// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IValidationRegistry} from "../interfaces/IERC8004.sol";

/**
 * @title ValidationRegistry
 * @notice ERC-8004 validation: a request for an independent party to check an agent's work,
 *         and that party's verdict, both anchored on-chain.
 *
 * @dev Two departures from a naive reading of the spec, both deliberate:
 *
 *      1. **Requests expire.** A validation request with no deadline is a claim an agent can
 *         leave dangling forever and point at as "pending review". Every request here carries
 *         an explicit expiry; past it the request is dead and reads as such.
 *      2. **Only the named validator may answer, once.** The request commits to
 *         `validatorAddress` up front, so an agent cannot shop for a friendly verdict after
 *         seeing an unfriendly one, and a validator cannot revise a published answer.
 *
 *      `response` is a 0-100 score, as ERC-8004 intends. This contract treats >= 50 as
 *      "passed" when other modules ask it whether work cleared review.
 */
contract ValidationRegistry is IValidationRegistry, Ownable2Step {
    /*//////////////////////////////////////////////////////////////
                                  TYPES
    //////////////////////////////////////////////////////////////*/

    struct Request {
        address validator;
        uint256 agentId;
        address requester;
        uint64 expiry;
        uint64 lastUpdate;
        uint8 response;
        bool answered;
        bytes32 responseHash;
        string tag;
    }

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    uint8 public constant PASS_THRESHOLD = 50;

    address public immutable IDENTITY_REGISTRY;

    /// @notice When true, only allowlisted addresses may act as validators. Collections that
    ///         want an open validator market simply leave it false.
    bool public restrictValidators;
    mapping(address validator => bool) public isValidator;

    /// @dev Keyed by `keccak256(requester, requestHash)`, never by `requestHash` alone. See
    ///      {requestKeyOf} for why.
    mapping(bytes32 requestKey => Request) private _requests;
    mapping(uint256 agentId => bytes32[]) private _agentRequests;
    mapping(address validator => bytes32[]) private _validatorRequests;

    /*//////////////////////////////////////////////////////////////
                             EVENTS / ERRORS
    //////////////////////////////////////////////////////////////*/

    event ValidatorSet(address indexed validator, bool allowed);
    event RestrictValidatorsSet(bool restricted);

    error RequestExists(bytes32 requestHash);
    error NoSuchRequest(bytes32 requestHash);
    error NotTheValidator(bytes32 requestHash, address caller);
    error AlreadyAnswered(bytes32 requestHash);
    error RequestExpired(bytes32 requestHash, uint64 expiry);
    error ValidatorNotAllowed(address validator);
    error ScoreOutOfRange(uint8 response);
    error SelfValidation(uint256 agentId, address validator);
    error ZeroAddress();

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    constructor(address identityRegistry_, address owner_) Ownable(owner_) {
        if (identityRegistry_ == address(0)) revert ZeroAddress();
        IDENTITY_REGISTRY = identityRegistry_;
    }

    function getIdentityRegistry() external view returns (address) {
        return IDENTITY_REGISTRY;
    }

    function setValidator(address validator, bool allowed) external onlyOwner {
        isValidator[validator] = allowed;
        emit ValidatorSet(validator, allowed);
    }

    function setRestrictValidators(bool restricted) external onlyOwner {
        restrictValidators = restricted;
        emit RestrictValidatorsSet(restricted);
    }

    /*//////////////////////////////////////////////////////////////
                                REQUESTS
    //////////////////////////////////////////////////////////////*/

    /// @notice The storage key for a request, namespaced by whoever opened it.
    /// @dev Keying purely by `requestHash` — the obvious reading of ERC-8004 — is
    ///      front-runnable. Request hashes are derived from public data, so anyone watching a
    ///      pending `validationRequest` can pre-register that exact hash and make the real
    ///      request revert as a duplicate. Against an escrow that opens a dispute this is a
    ///      denial of service with a payout: block the dispute until the review window lapses
    ///      and the agent collects for undelivered work with its bond untouched.
    ///
    ///      Namespacing by opener removes the attack outright — a squatter cannot write into
    ///      someone else's namespace — while leaving the emitted `requestHash` exactly as
    ///      ERC-8004 describes. Validators respond with the key, which is the value the
    ///      `ValidationRequest` event carries.
    function requestKeyOf(address requester, bytes32 requestHash) public pure returns (bytes32) {
        return keccak256(abi.encode(requester, requestHash));
    }

    /// @inheritdoc IValidationRegistry
    /// @dev Spec-shaped entry point; defaults to a 7 day window.
    function validationRequest(
        address validatorAddress,
        uint256 agentId,
        string calldata requestURI,
        bytes32 requestHash
    ) external {
        _open(validatorAddress, agentId, requestURI, requestHash, uint64(block.timestamp + 7 days));
    }

    /// @notice Open a request with an explicit deadline.
    function validationRequestWithExpiry(
        address validatorAddress,
        uint256 agentId,
        string calldata requestURI,
        bytes32 requestHash,
        uint64 expiry
    ) external {
        _open(validatorAddress, agentId, requestURI, requestHash, expiry);
    }

    function _open(address validator, uint256 agentId, string calldata requestURI, bytes32 requestHash, uint64 expiry)
        private
    {
        if (validator == address(0)) revert ZeroAddress();
        bytes32 key = requestKeyOf(msg.sender, requestHash);
        if (_requests[key].validator != address(0)) revert RequestExists(key);
        if (restrictValidators && !isValidator[validator]) revert ValidatorNotAllowed(validator);

        // Reverts for an agent that does not exist.
        address holder = IERC721(IDENTITY_REGISTRY).ownerOf(agentId);
        // An agent's own holder grading its own work is not validation, it is marketing.
        if (validator == holder) revert SelfValidation(agentId, validator);

        Request storage r = _requests[key];
        r.validator = validator;
        r.agentId = agentId;
        r.requester = msg.sender;
        r.expiry = expiry;
        r.lastUpdate = uint64(block.timestamp);

        _agentRequests[agentId].push(key);
        _validatorRequests[validator].push(key);

        // The event carries the namespaced key, which is what a validator must answer with.
        emit ValidationRequest(validator, agentId, requestURI, key);
    }

    /// @inheritdoc IValidationRegistry
    /// @param requestKey The namespaced key from the `ValidationRequest` event, not the raw
    ///        content hash. See {requestKeyOf}.
    function validationResponse(
        bytes32 requestKey,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external {
        Request storage r = _requests[requestKey];
        if (r.validator == address(0)) revert NoSuchRequest(requestKey);
        if (r.validator != msg.sender) revert NotTheValidator(requestKey, msg.sender);
        if (r.answered) revert AlreadyAnswered(requestKey);
        if (block.timestamp > r.expiry) revert RequestExpired(requestKey, r.expiry);
        if (response > 100) revert ScoreOutOfRange(response);

        r.response = response;
        r.answered = true;
        r.responseHash = responseHash;
        r.tag = tag;
        r.lastUpdate = uint64(block.timestamp);

        emit ValidationResponse(msg.sender, r.agentId, requestKey, response, responseURI, responseHash, tag);
    }

    /*//////////////////////////////////////////////////////////////
                                 READING
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IValidationRegistry
    function getValidationStatus(bytes32 requestKey)
        external
        view
        returns (
            address validatorAddress,
            uint256 agentId,
            uint8 response,
            bytes32 responseHash,
            string memory tag,
            uint256 lastUpdate
        )
    {
        Request storage r = _requests[requestKey];
        if (r.validator == address(0)) revert NoSuchRequest(requestKey);
        return (r.validator, r.agentId, r.response, r.responseHash, r.tag, r.lastUpdate);
    }

    function hasPassed(bytes32 requestKey) external view returns (bool) {
        Request storage r = _requests[requestKey];
        return r.answered && r.response >= PASS_THRESHOLD;
    }

    function requestOf(bytes32 requestKey) external view returns (Request memory) {
        return _requests[requestKey];
    }

    /// @inheritdoc IValidationRegistry
    /// @dev Counts answered, unexpired-at-answer-time responses only. An ignored request
    ///      contributes nothing rather than counting as a zero, because a validator's
    ///      silence says something about the validator, not about the agent.
    function getSummary(uint256 agentId, address[] calldata validatorAddresses, string calldata tag)
        external
        view
        returns (uint64 count, uint8 averageResponse)
    {
        bytes32[] storage hashes = _agentRequests[agentId];
        uint256 total;
        bool filterValidators = validatorAddresses.length != 0;
        bool filterTag = bytes(tag).length != 0;

        for (uint256 i; i < hashes.length; ++i) {
            Request storage r = _requests[hashes[i]];
            if (!r.answered) continue;
            if (filterTag && keccak256(bytes(r.tag)) != keccak256(bytes(tag))) continue;
            if (filterValidators && !_contains(validatorAddresses, r.validator)) continue;
            total += r.response;
            unchecked {
                ++count;
            }
        }
        if (count != 0) averageResponse = uint8(total / count);
    }

    function _contains(address[] calldata list, address needle) private pure returns (bool) {
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == needle) return true;
        }
        return false;
    }

    /// @inheritdoc IValidationRegistry
    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory) {
        return _agentRequests[agentId];
    }

    /// @inheritdoc IValidationRegistry
    function getValidatorRequests(address validatorAddress) external view returns (bytes32[] memory) {
        return _validatorRequests[validatorAddress];
    }
}
