// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {AnimaOApp} from "./AnimaOApp.sol";
import {AnimaOmniCodec, AgentSnapshot} from "./AnimaOmniCodec.sol";
import {MessagingFee, MessagingReceipt, Origin} from "./ILayerZeroV2.sol";

/**
 * @title OmniAgentMirror — an agent's tradeable shadow on a foreign chain
 * @notice The remote half of {OmniAgentHome}. Mints a mirror when an agent arrives, burns it
 *         when the agent is sent home, and carries the commitments needed to verify that the
 *         mirror really corresponds to the agent it claims.
 *
 * @dev **A mirror is not the agent, and this contract says so.** `isReplica()` returns true
 *      and there is no bond, no reputation, no validation history and no token bound account
 *      here. Those live on the home chain, because that is the only chain where an agent can
 *      actually be slashed. A protocol that let an agent's guarantees be duplicated by
 *      bridging would be issuing collateral out of thin air, once per chain.
 *
 *      What the mirror *does* carry is enough to check what it is: the manifest commitment,
 *      the brain root and epoch, the declared model root, the seal policy, and the home
 *      chain and contract. A client fetches the manifest, hashes it, and compares — so a
 *      mirror cannot misrepresent the agent behind it even though it cannot enforce it.
 *
 *      The brain root is a snapshot taken at departure. If the agent updates its memory
 *      while it is away, the mirror's root is stale — and visibly so, since `syncedAt` is
 *      recorded. This is honest staleness rather than a false claim of live state.
 */
contract OmniAgentMirror is ERC721, AnimaOApp, ReentrancyGuardTransient {
    using AnimaOmniCodec for AgentSnapshot;

    struct Replica {
        bytes32 brainRoot;
        bytes32 manifestHash;
        bytes32 weightsRoot;
        uint64 brainEpoch;
        uint64 homeChainId;
        uint64 syncedAt;
        uint8 seal;
        bytes32 homeToken;
        string agentURI;
    }

    mapping(uint256 agentId => Replica) private _replicas;

    event MirrorMinted(uint256 indexed agentId, address indexed to, uint32 indexed srcEid, bytes32 brainRoot);
    event MirrorBurned(uint256 indexed agentId, uint32 indexed dstEid, bytes32 to);

    error NotMirrorOwner(uint256 agentId, address caller);
    error InvalidReceiver();
    error UnknownMirror(uint256 agentId);

    constructor(
        string memory name_,
        string memory symbol_,
        address endpoint_,
        address delegate_,
        address owner_
    ) ERC721(name_, symbol_) AnimaOApp(endpoint_, delegate_, owner_) {}

    /// @notice Always true. Read it before treating this token as a bondable agent.
    function isReplica() external pure returns (bool) {
        return true;
    }

    function replicaOf(uint256 agentId) external view returns (Replica memory) {
        return _replicas[agentId];
    }

    function tokenURI(uint256 agentId) public view override returns (string memory) {
        _requireOwned(agentId);
        return _replicas[agentId].agentURI;
    }

    /// @notice Verify a fetched manifest against what the home chain attested at departure.
    function verifyManifest(uint256 agentId, bytes calldata manifest) external view returns (bool) {
        bytes32 committed = _replicas[agentId].manifestHash;
        return committed != bytes32(0) && keccak256(manifest) == committed;
    }

    /*//////////////////////////////////////////////////////////////
                                 RECEIVE
    //////////////////////////////////////////////////////////////*/

    function _lzReceive(Origin calldata origin, bytes32, bytes calldata message, address, bytes calldata)
        internal
        override
    {
        AgentSnapshot memory s = AnimaOmniCodec.decode(message);
        address to = _toAddress(s.to);
        if (to == address(0)) revert InvalidReceiver();

        _replicas[s.agentId] = Replica({
            brainRoot: s.brainRoot,
            manifestHash: s.manifestHash,
            weightsRoot: s.weightsRoot,
            brainEpoch: s.brainEpoch,
            homeChainId: s.homeChainId,
            syncedAt: uint64(block.timestamp),
            seal: s.seal,
            homeToken: s.homeToken,
            agentURI: s.agentURI
        });

        // A round trip mints, burns and mints again under the same id, so tolerate both.
        if (_ownerOf(s.agentId) == address(0)) {
            _mint(to, s.agentId);
        } else {
            _update(to, s.agentId, address(0));
        }

        emit MirrorMinted(s.agentId, to, origin.srcEid, s.brainRoot);
    }

    /*//////////////////////////////////////////////////////////////
                                  SEND
    //////////////////////////////////////////////////////////////*/

    function quoteSend(uint32 dstEid, bytes32 to, uint256 agentId, bytes calldata options)
        external
        view
        returns (MessagingFee memory)
    {
        return _quote(dstEid, _snapshot(agentId, to).encode(), options, false);
    }

    /// @notice Send the mirror onward — home, or to another chain the owner has peered.
    function send(
        uint32 dstEid,
        bytes32 to,
        uint256 agentId,
        bytes calldata options,
        MessagingFee calldata fee,
        address refundAddress
    ) external payable nonReentrant returns (MessagingReceipt memory receipt) {
        if (to == bytes32(0)) revert InvalidReceiver();
        if (_ownerOf(agentId) != msg.sender) revert NotMirrorOwner(agentId, msg.sender);

        AgentSnapshot memory snapshot = _snapshot(agentId, to);

        _burn(agentId);
        emit MirrorBurned(agentId, dstEid, to);

        receipt = _lzSend(dstEid, snapshot.encode(), options, fee, refundAddress);
    }

    function _snapshot(uint256 agentId, bytes32 to) private view returns (AgentSnapshot memory) {
        Replica storage r = _replicas[agentId];
        if (r.homeChainId == 0) revert UnknownMirror(agentId);
        return AgentSnapshot({
            to: to,
            agentId: agentId,
            brainRoot: r.brainRoot,
            brainEpoch: r.brainEpoch,
            manifestHash: r.manifestHash,
            weightsRoot: r.weightsRoot,
            seal: r.seal,
            homeChainId: r.homeChainId,
            homeToken: r.homeToken,
            agentURI: r.agentURI
        });
    }
}
