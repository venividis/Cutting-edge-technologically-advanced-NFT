// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IReputationRegistry} from "../interfaces/IERC8004.sol";

/**
 * @title ReputationRegistry
 * @notice ERC-8004 reputation, plus the part ERC-8004 leaves open: proof that the reviewer
 *         was actually a customer.
 *
 * @dev ERC-8004 lets any address leave feedback on any agent. That is the right base layer —
 *      permissionless, unopinionated — but consumed naively it is a sybil farm: an agent can
 *      mint a thousand addresses and rate itself perfect for the price of gas.
 *
 *      So this implementation records, alongside every score, two facts a reader can filter
 *      on and neither the agent nor the reviewer can forge:
 *
 *        `attested` — the feedback was submitted by a registered settlement module on
 *                     behalf of a client who actually paid this agent for work;
 *        `weight`   — how much that client paid, in the settlement asset's smallest unit.
 *
 *      `getSummary` stays byte-compatible with ERC-8004 and counts everything.
 *      `getAttestedSummary` counts only paid-for work, weighted by what was at stake, which
 *      is the number worth trusting. Faking it costs exactly as much as the jobs are worth.
 */
contract ReputationRegistry is IReputationRegistry, Ownable2Step {
    /*//////////////////////////////////////////////////////////////
                                  TYPES
    //////////////////////////////////////////////////////////////*/

    struct Feedback {
        int128 value;
        uint8 valueDecimals;
        bool isRevoked;
        bool attested;
        uint64 timestamp;
        uint128 weight; //   value at stake in the job that backs this feedback
        bytes32 jobId; //    settlement reference, zero when unattested
        string tag1;
        string tag2;
    }

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Normalised precision for every summary this contract returns. Fixing it
    ///         removes an entire class of integration bug where a caller averages values
    ///         that were quoted in different decimals.
    uint8 public constant SUMMARY_DECIMALS = 2;

    address public immutable IDENTITY_REGISTRY;

    /// @notice Settlement modules trusted to mark feedback as customer-attested.
    mapping(address module => bool) public isSettlementModule;

    /// @notice Running totals over attested feedback, maintained on write.
    /// @dev The filtered summaries below iterate every client an agent ever had, and anyone can
    ///      append to that list for the price of gas — a few dollars of spam on an L2 makes an
    ///      agent's reputation cost more to read than any node will spend, which is a denial of
    ///      service against a competitor. The number consumers actually want is therefore
    ///      maintained incrementally and read in constant time.
    struct Aggregate {
        uint64 count;
        int256 weightedSum;
        uint256 totalWeight;
    }

    mapping(uint256 agentId => Aggregate) private _attested;

    mapping(uint256 agentId => mapping(address client => Feedback[])) private _feedback;
    mapping(uint256 agentId => mapping(address client => mapping(uint64 index => uint64))) private _responseCount;
    mapping(uint256 agentId => address[]) private _clients;
    mapping(uint256 agentId => mapping(address client => bool)) private _seenClient;

    /*//////////////////////////////////////////////////////////////
                             EVENTS / ERRORS
    //////////////////////////////////////////////////////////////*/

    event SettlementModuleSet(address indexed module, bool allowed);

    error UnknownAgent(uint256 agentId);
    error NoSuchFeedback(uint256 agentId, address client, uint64 index);
    error AlreadyRevoked(uint256 agentId, address client, uint64 index);
    error NotSettlementModule(address caller);
    error SelfFeedback(uint256 agentId, address client);

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    constructor(address identityRegistry_, address owner_) Ownable(owner_) {
        IDENTITY_REGISTRY = identityRegistry_;
    }

    function getIdentityRegistry() external view returns (address) {
        return IDENTITY_REGISTRY;
    }

    function setSettlementModule(address module, bool allowed) external onlyOwner {
        isSettlementModule[module] = allowed;
        emit SettlementModuleSet(module, allowed);
    }

    /*//////////////////////////////////////////////////////////////
                                 WRITING
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IReputationRegistry
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external {
        _record(agentId, msg.sender, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash, false, 0, bytes32(0));
    }

    /// @notice Record feedback on behalf of a client who provably paid for the work.
    /// @dev Only callable by a registered settlement module, which submits it as part of
    ///      releasing an escrow. The client cannot be the agent's own owner, which closes
    ///      the obvious self-dealing loop of hiring yourself to farm a rating.
    function giveAttestedFeedback(
        uint256 agentId,
        address client,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash,
        uint128 weight,
        bytes32 jobId
    ) external {
        if (!isSettlementModule[msg.sender]) revert NotSettlementModule(msg.sender);
        if (client == IERC721(IDENTITY_REGISTRY).ownerOf(agentId)) revert SelfFeedback(agentId, client);
        _record(agentId, client, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash, true, weight, jobId);
    }

    function _record(
        uint256 agentId,
        address client,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash,
        bool attested,
        uint128 weight,
        bytes32 jobId
    ) private {
        // Reverts for a non-existent agent, which keeps reputation from accruing to ids
        // that were never minted.
        IERC721(IDENTITY_REGISTRY).ownerOf(agentId);

        if (!_seenClient[agentId][client]) {
            _seenClient[agentId][client] = true;
            _clients[agentId].push(client);
        }

        Feedback[] storage list = _feedback[agentId][client];
        uint64 index = uint64(list.length);
        list.push(
            Feedback({
                value: value,
                valueDecimals: valueDecimals,
                isRevoked: false,
                attested: attested,
                timestamp: uint64(block.timestamp),
                weight: weight,
                jobId: jobId,
                tag1: tag1,
                tag2: tag2
            })
        );

        if (attested) {
            uint256 w = weight == 0 ? 1 : weight;
            Aggregate storage agg = _attested[agentId];
            agg.count += 1;
            agg.weightedSum += _normalise(value, valueDecimals) * int256(w);
            agg.totalWeight += w;
        }

        emit NewFeedback(
            agentId, client, index, value, valueDecimals, tag1, tag1, tag2, endpoint, feedbackURI, feedbackHash
        );
    }

    /// @inheritdoc IReputationRegistry
    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external {
        Feedback[] storage list = _feedback[agentId][msg.sender];
        if (feedbackIndex >= list.length) revert NoSuchFeedback(agentId, msg.sender, feedbackIndex);
        Feedback storage f = list[feedbackIndex];
        if (f.isRevoked) revert AlreadyRevoked(agentId, msg.sender, feedbackIndex);
        f.isRevoked = true;

        if (f.attested) {
            uint256 w = f.weight == 0 ? 1 : f.weight;
            Aggregate storage agg = _attested[agentId];
            agg.count -= 1;
            agg.weightedSum -= _normalise(f.value, f.valueDecimals) * int256(w);
            agg.totalWeight -= w;
        }

        emit FeedbackRevoked(agentId, msg.sender, feedbackIndex);
    }

    /// @inheritdoc IReputationRegistry
    /// @dev Anyone may respond, not just the agent's owner: a third party who can show the
    ///      review is wrong is exactly the sort of evidence a reader wants. Responses are
    ///      events, so they cost nothing to store and everything is attributable.
    function appendResponse(
        uint256 agentId,
        address clientAddress,
        uint64 feedbackIndex,
        string calldata responseURI,
        bytes32 responseHash
    ) external {
        if (feedbackIndex >= _feedback[agentId][clientAddress].length) {
            revert NoSuchFeedback(agentId, clientAddress, feedbackIndex);
        }
        unchecked {
            ++_responseCount[agentId][clientAddress][feedbackIndex];
        }
        emit ResponseAppended(agentId, clientAddress, feedbackIndex, msg.sender, responseURI, responseHash);
    }

    /*//////////////////////////////////////////////////////////////
                                 READING
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IReputationRegistry
    /// @dev ERC-8004 semantics: every non-revoked score, unweighted. Useful, but treat it
    ///      as the *upper bound* on an agent's claimed standing, not as evidence.
    function getSummary(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2
    ) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals) {
        (count, summaryValue) = _summarise(agentId, clientAddresses, tag1, tag2);
        summaryValueDecimals = SUMMARY_DECIMALS;
    }

    /// @notice Constant-time attested standing. This is the read path integrators should use.
    /// @return count        attested reviews counted
    /// @return summaryValue stake-weighted mean at `SUMMARY_DECIMALS`
    /// @return totalWeight  total collateral that stood behind those jobs
    function attestedSummaryOf(uint256 agentId)
        external
        view
        returns (uint64 count, int128 summaryValue, uint256 totalWeight)
    {
        Aggregate storage agg = _attested[agentId];
        count = agg.count;
        totalWeight = agg.totalWeight;
        if (totalWeight != 0) summaryValue = int128(agg.weightedSum / int256(totalWeight));
    }

    /// @notice Filtered attested standing. O(clients x feedback) — use {attestedSummaryOf}
    ///         unless you genuinely need the tag or client filters.
    /// @return count            number of attested reviews counted
    /// @return summaryValue     stake-weighted mean, at `SUMMARY_DECIMALS`
    /// @return totalWeight      total value settled across those jobs
    function getAttestedSummary(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2
    ) external view returns (uint64 count, int128 summaryValue, uint256 totalWeight) {
        address[] memory clients;
        if (clientAddresses.length == 0) {
            clients = _clients[agentId];
        } else {
            clients = clientAddresses;
        }
        int256 weightedSum;

        for (uint256 i; i < clients.length; ++i) {
            Feedback[] storage list = _feedback[agentId][clients[i]];
            for (uint256 j; j < list.length; ++j) {
                Feedback storage f = list[j];
                if (f.isRevoked || !f.attested) continue;
                if (!_tagMatch(f.tag1, f.tag2, tag1, tag2)) continue;
                // A zero-value job carries a weight of one so it still counts, just barely.
                uint256 w = f.weight == 0 ? 1 : f.weight;
                weightedSum += _normalise(f.value, f.valueDecimals) * int256(w);
                totalWeight += w;
                unchecked {
                    ++count;
                }
            }
        }
        if (totalWeight != 0) summaryValue = int128(weightedSum / int256(totalWeight));
    }

    function _summarise(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2
    ) private view returns (uint64 count, int128 mean) {
        address[] memory clients;
        if (clientAddresses.length == 0) {
            clients = _clients[agentId];
        } else {
            clients = clientAddresses;
        }
        int256 sum;
        for (uint256 i; i < clients.length; ++i) {
            Feedback[] storage list = _feedback[agentId][clients[i]];
            for (uint256 j; j < list.length; ++j) {
                Feedback storage f = list[j];
                if (f.isRevoked) continue;
                if (!_tagMatch(f.tag1, f.tag2, tag1, tag2)) continue;
                sum += _normalise(f.value, f.valueDecimals);
                unchecked {
                    ++count;
                }
            }
        }
        if (count != 0) mean = int128(sum / int256(uint256(count)));
    }

    /// @dev Empty filter matches everything, mirroring ERC-8004's optional-tag semantics.
    function _tagMatch(string storage a1, string storage a2, string calldata q1, string calldata q2)
        private
        pure
        returns (bool)
    {
        if (bytes(q1).length != 0 && keccak256(bytes(a1)) != keccak256(bytes(q1))) return false;
        if (bytes(q2).length != 0 && keccak256(bytes(a2)) != keccak256(bytes(q2))) return false;
        return true;
    }

    /// @dev Rebase a score onto `SUMMARY_DECIMALS`. Scores arrive in whatever precision the
    ///      reviewer chose; averaging them raw is a silent correctness bug.
    function _normalise(int128 value, uint8 decimals) private pure returns (int256) {
        if (decimals == SUMMARY_DECIMALS) return int256(value);
        if (decimals > SUMMARY_DECIMALS) {
            unchecked {
                return int256(value) / int256(10 ** uint256(decimals - SUMMARY_DECIMALS));
            }
        }
        unchecked {
            return int256(value) * int256(10 ** uint256(SUMMARY_DECIMALS - decimals));
        }
    }

    /// @inheritdoc IReputationRegistry
    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked)
    {
        Feedback[] storage list = _feedback[agentId][clientAddress];
        if (feedbackIndex >= list.length) revert NoSuchFeedback(agentId, clientAddress, feedbackIndex);
        Feedback storage f = list[feedbackIndex];
        return (f.value, f.valueDecimals, f.tag1, f.tag2, f.isRevoked);
    }

    /// @notice Full record including the provenance fields ERC-8004 does not carry.
    function readFeedbackDetail(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (Feedback memory)
    {
        Feedback[] storage list = _feedback[agentId][clientAddress];
        if (feedbackIndex >= list.length) revert NoSuchFeedback(agentId, clientAddress, feedbackIndex);
        return list[feedbackIndex];
    }

    function getResponseCount(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (uint64)
    {
        return _responseCount[agentId][clientAddress][feedbackIndex];
    }

    /// @inheritdoc IReputationRegistry
    function getClients(uint256 agentId) external view returns (address[] memory) {
        return _clients[agentId];
    }

    function clientCount(uint256 agentId) external view returns (uint256) {
        return _clients[agentId].length;
    }

    /// @notice Paged client list, since the full one grows without bound and permissionlessly.
    function getClientsPaged(uint256 agentId, uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory page)
    {
        address[] storage all = _clients[agentId];
        if (offset >= all.length) return new address[](0);
        uint256 end = offset + limit;
        if (end > all.length) end = all.length;
        page = new address[](end - offset);
        for (uint256 i; i < page.length; ++i) {
            page[i] = all[offset + i];
        }
    }

    /// @inheritdoc IReputationRegistry
    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64) {
        return uint64(_feedback[agentId][clientAddress].length);
    }
}
