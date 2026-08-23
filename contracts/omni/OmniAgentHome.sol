// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {AnimaOApp} from "./AnimaOApp.sol";
import {AnimaOmniCodec, AgentSnapshot} from "./AnimaOmniCodec.sol";
import {MessagingFee, MessagingReceipt, Origin} from "./ILayerZeroV2.sol";
import {SealPolicy, ModelIdentity} from "../interfaces/IAnima.sol";

interface IAnimaOmniView {
    function locked(uint256 tokenId) external view returns (bool);
    function accountOf(uint256 agentId) external view returns (address);
    function brainRoot(uint256 agentId) external view returns (bytes32);
    function brainEpoch(uint256 agentId) external view returns (uint64);
    function sealPolicyOf(uint256 agentId) external view returns (SealPolicy);
    function modelOf(uint256 agentId) external view returns (ModelIdentity memory);
    function manifestOf(uint256 agentId) external view returns (string memory, bytes32, uint32);
}

/**
 * @title OmniAgentHome — the chain where an agent is actually accountable
 * @notice Escrows an ANIMA agent and mints a mirror of it on another chain; releases the
 *         original when the mirror comes home.
 *
 * @dev **Why escrow rather than burn-and-mint.** An agent's bond, reputation and validation
 *      history are chain-local claims other contracts hold against it. Burning the token on
 *      its home chain would strand all of that behind an id nobody owns, and an agent whose
 *      accountability can be left behind by bridging has no accountability at all. Escrow
 *      keeps exactly one chain where the agent can be slashed, and lets only the tradeable
 *      representation travel.
 *
 *      **What does not travel, stated plainly.** The agent's ERC-6551 account is derived from
 *      its home chain id and home token contract, so the mirror on another chain has a
 *      *different* account. Assets in the home account stay home, reachable again only when
 *      the token returns. This contract refuses to bridge an agent whose home account holds
 *      native currency unless the sender passes `acknowledgeAssetsRemain`. ERC-20 balances
 *      cannot be enumerated on-chain and therefore cannot be checked — the departure event
 *      publishes the account address precisely so a front-end can look, and every integrator
 *      should. A check that claimed to be complete here would be a lie.
 *
 *      **A busy agent may not leave.** Mid-job or under dispute, an agent is collateral for
 *      someone's escrow. Letting it cross to a chain where that escrow cannot reach it is
 *      the bridge equivalent of absconding.
 */
contract OmniAgentHome is AnimaOApp, ReentrancyGuardTransient {
    using AnimaOmniCodec for AgentSnapshot;

    IERC721 public immutable AGENTS;
    IAnimaOmniView public immutable ANIMA;

    /// @notice Endpoint id this agent is currently mirrored on, or zero if it is home.
    mapping(uint256 agentId => uint32) public awayOn;

    event AgentDeparted(
        uint256 indexed agentId,
        uint32 indexed dstEid,
        address indexed homeAccount,
        bytes32 to,
        bytes32 brainRoot,
        uint64 brainEpoch,
        uint256 strandedNativeBalance
    );
    event AgentReturned(uint256 indexed agentId, uint32 indexed srcEid, address to);

    error AgentBusy(uint256 agentId);
    error HomeAccountHoldsAssets(uint256 agentId, address account, uint256 balance);
    error NotAgentOwner(uint256 agentId, address caller);
    error AgentNotAway(uint256 agentId);
    error WrongOriginChain(uint256 agentId, uint32 expected, uint32 actual);
    error InvalidReceiver();

    constructor(address agents_, address endpoint_, address delegate_, address owner_)
        AnimaOApp(endpoint_, delegate_, owner_)
    {
        AGENTS = IERC721(agents_);
        ANIMA = IAnimaOmniView(agents_);
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

    /// @param acknowledgeAssetsRemain Must be true if the agent's home ERC-6551 account holds
    ///        native currency. Deliberate friction in front of an irreversible mistake.
    function send(
        uint32 dstEid,
        bytes32 to,
        uint256 agentId,
        bytes calldata options,
        MessagingFee calldata fee,
        address refundAddress,
        bool acknowledgeAssetsRemain
    ) external payable nonReentrant returns (MessagingReceipt memory receipt) {
        // Validate the receiver exactly as the destination will interpret it. A right-padded
        // address is non-zero as a word but decodes to address(0) on arrival, and by then the
        // token is already escrowed and the message reverts on every retry — the agent would be
        // stranded in this contract permanently.
        _requireCleanReceiver(to);
        if (AGENTS.ownerOf(agentId) != msg.sender) revert NotAgentOwner(agentId, msg.sender);
        if (ANIMA.locked(agentId)) revert AgentBusy(agentId);

        address account = ANIMA.accountOf(agentId);
        uint256 stranded = account.balance;
        if (stranded != 0 && !acknowledgeAssetsRemain) {
            revert HomeAccountHoldsAssets(agentId, account, stranded);
        }

        AgentSnapshot memory snapshot = _snapshot(agentId, to);

        awayOn[agentId] = dstEid;
        // Escrow before dispatch. The token transfer also trips AnimaAgent's transfer hook,
        // which pauses the agent and clears its autonomy policy — exactly right for a token
        // about to be controlled from a different chain.
        AGENTS.transferFrom(msg.sender, address(this), agentId);

        emit AgentDeparted(agentId, dstEid, account, to, snapshot.brainRoot, snapshot.brainEpoch, stranded);

        receipt = _lzSend(dstEid, snapshot.encode(), options, fee, refundAddress);
    }

    /*//////////////////////////////////////////////////////////////
                                 RECEIVE
    //////////////////////////////////////////////////////////////*/

    function _lzReceive(Origin calldata origin, bytes32, bytes calldata message, address, bytes calldata)
        internal
        override
    {
        AgentSnapshot memory snapshot = AnimaOmniCodec.decode(message);
        uint256 agentId = snapshot.agentId;

        uint32 away = awayOn[agentId];
        // Only an agent this contract actually sent out may come back, and only from the
        // chain it was sent to. Without this, a compromised peer on any configured chain
        // could mint itself a claim on an agent that never left.
        if (away == 0) revert AgentNotAway(agentId);
        if (away != origin.srcEid) revert WrongOriginChain(agentId, away, origin.srcEid);

        awayOn[agentId] = 0;

        address to = _toAddress(snapshot.to);
        if (to == address(0)) revert InvalidReceiver();

        AGENTS.transferFrom(address(this), to, agentId);
        emit AgentReturned(agentId, origin.srcEid, to);
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

    function _requireCleanReceiver(bytes32 to) private pure {
        if (uint256(to) >> 160 != 0 || _toAddress(to) == address(0)) revert InvalidReceiver();
    }

    function _snapshot(uint256 agentId, bytes32 to) private view returns (AgentSnapshot memory s) {
        (string memory uri, bytes32 manifestHash,) = ANIMA.manifestOf(agentId);
        s = AgentSnapshot({
            to: to,
            agentId: agentId,
            brainRoot: ANIMA.brainRoot(agentId),
            brainEpoch: ANIMA.brainEpoch(agentId),
            manifestHash: manifestHash,
            weightsRoot: ANIMA.modelOf(agentId).weightsRoot,
            seal: uint8(ANIMA.sealPolicyOf(agentId)),
            homeChainId: uint64(block.chainid),
            homeToken: _toBytes32(address(AGENTS)),
            agentURI: uri
        });
    }
}
