// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {
    ILayerZeroEndpointV2,
    ILayerZeroReceiver,
    MessagingParams,
    MessagingReceipt,
    MessagingFee,
    Origin
} from "./ILayerZeroV2.sol";

/**
 * @title AnimaOApp — minimal LayerZero V2 application base
 * @notice Peer management, authenticated inbound delivery, and outbound dispatch.
 *
 * @dev Cross-chain messaging has one dominant failure mode and it is always the same one:
 *      accepting a payload that did not come from the contract you think it did. Nomad,
 *      Wormhole and most of the rest reduce to a missing or forged origin check. Every
 *      inbound message here must satisfy both halves:
 *
 *        1. `msg.sender` is the local LayerZero endpoint — nobody can call `lzReceive`
 *           directly and hand this contract a fabricated `Origin`;
 *        2. `origin.sender` equals the peer this owner explicitly registered for
 *           `origin.srcEid` — a message from an unconfigured chain, or from an unexpected
 *           contract on a configured chain, is rejected rather than processed with defaults.
 *
 *      A zero peer is never trusted, so an unset route fails closed.
 *
 *      Note also what this base does *not* claim: LayerZero's security ultimately rests on
 *      the DVN and executor configuration set at the endpoint, not here. An OApp that leaves
 *      that on defaults has delegated its security to whoever the defaults name. Deployments
 *      must set an explicit DVN stack; `setDelegate` exists so that configuration can be
 *      handed to a governance address distinct from this contract's owner.
 */
abstract contract AnimaOApp is ILayerZeroReceiver, Ownable2Step {
    ILayerZeroEndpointV2 public immutable ENDPOINT;

    /// @notice Trusted counterpart per destination endpoint id, as a left-padded address.
    mapping(uint32 eid => bytes32 peer) public peers;

    /// @notice Inbound throughput cap per source chain.
    /// @dev Neither LayerZero's ONFT721 nor Hyperlane's HypERC721 has one, and that is the
    ///      difference between a compromised DVN set costing one agent and costing all of them:
    ///      without a cap, a forged verification can release or mint every agent on the route in
    ///      a single block. xERC20 solved this for fungibles in 2023 and it never became an EIP.
    ///
    ///      A throttled message is not lost. LayerZero keeps an unexecuted payload retryable, so
    ///      the cap converts a catastrophic drain into a delay — which is the entire point: it
    ///      buys the time in which a human notices.
    struct RateLimit {
        uint64 windowSeconds;
        uint64 capacity; //     messages per window; zero disables the limit
        uint64 windowStart;
        uint64 used;
    }

    mapping(uint32 srcEid => RateLimit) public inboundLimit;

    event PeerSet(uint32 indexed eid, bytes32 peer);
    event InboundLimitSet(uint32 indexed srcEid, uint64 windowSeconds, uint64 capacity);

    error OnlyEndpoint(address caller);
    error UntrustedPeer(uint32 srcEid, bytes32 sender);
    error NoPeerConfigured(uint32 dstEid);
    error IncorrectFee(uint256 expected, uint256 provided);
    error InvalidInboundLimit(uint64 windowSeconds, uint64 capacity);
    error InboundRateLimited(uint32 srcEid, uint64 used, uint64 capacity, uint64 windowEndsAt);

    constructor(address endpoint_, address delegate_, address owner_) Ownable(owner_) {
        ENDPOINT = ILayerZeroEndpointV2(endpoint_);
        if (delegate_ != address(0)) ENDPOINT.setDelegate(delegate_);
    }

    /// @notice Register the trusted contract on a remote chain. Setting a peer is the entire
    ///         trust decision for that route, so it stays with the owner alone.
    function setPeer(uint32 eid, bytes32 peer) external onlyOwner {
        peers[eid] = peer;
        emit PeerSet(eid, peer);
    }

    /// @notice Cap how many messages this contract will accept from a chain per window.
    /// @param capacity Messages per window. Zero disables the limit — the default, so that a
    ///        deployment must opt in deliberately rather than inherit a number nobody chose.
    function setInboundLimit(uint32 srcEid, uint64 windowSeconds, uint64 capacity) external onlyOwner {
        // A positive capacity with a zero-length window would reset on every message and
        // silently turn the advertised limit into no limit at all.
        if (capacity != 0 && windowSeconds == 0) revert InvalidInboundLimit(windowSeconds, capacity);
        RateLimit storage r = inboundLimit[srcEid];
        r.windowSeconds = windowSeconds;
        r.capacity = capacity;
        r.windowStart = uint64(block.timestamp);
        r.used = 0;
        emit InboundLimitSet(srcEid, windowSeconds, capacity);
    }

    /// @notice Messages still accepted from this chain in the current window.
    function inboundRemaining(uint32 srcEid) external view returns (uint64) {
        RateLimit storage r = inboundLimit[srcEid];
        if (r.capacity == 0) return type(uint64).max;
        if (block.timestamp >= r.windowStart + r.windowSeconds) return r.capacity;
        return r.used >= r.capacity ? 0 : r.capacity - r.used;
    }

    function _consumeInbound(uint32 srcEid) private {
        RateLimit storage r = inboundLimit[srcEid];
        if (r.capacity == 0) return;

        if (block.timestamp >= r.windowStart + r.windowSeconds) {
            r.windowStart = uint64(block.timestamp);
            r.used = 0;
        }
        if (r.used >= r.capacity) {
            revert InboundRateLimited(srcEid, r.used, r.capacity, r.windowStart + r.windowSeconds);
        }
        unchecked {
            r.used += 1;
        }
    }

    /// @notice Hand endpoint configuration (DVNs, executors, libraries) to another address.
    function setDelegate(address delegate) external onlyOwner {
        ENDPOINT.setDelegate(delegate);
    }

    /// @inheritdoc ILayerZeroReceiver
    function allowInitializePath(Origin calldata origin) external view returns (bool) {
        return peers[origin.srcEid] == origin.sender && origin.sender != bytes32(0);
    }

    /// @inheritdoc ILayerZeroReceiver
    /// @dev Zero selects the endpoint's default unordered delivery. Ordered delivery would
    ///      let one stuck message block every later one for that route.
    function nextNonce(uint32, bytes32) external pure returns (uint64) {
        return 0;
    }

    function oAppVersion() external pure returns (uint64 senderVersion, uint64 receiverVersion) {
        return (1, 2);
    }

    /// @inheritdoc ILayerZeroReceiver
    function lzReceive(
        Origin calldata origin,
        bytes32 guid,
        bytes calldata message,
        address executor,
        bytes calldata extraData
    ) external payable {
        if (msg.sender != address(ENDPOINT)) revert OnlyEndpoint(msg.sender);
        bytes32 peer = peers[origin.srcEid];
        if (peer == bytes32(0) || peer != origin.sender) revert UntrustedPeer(origin.srcEid, origin.sender);
        _consumeInbound(origin.srcEid);
        _lzReceive(origin, guid, message, executor, extraData);
    }

    function _lzReceive(
        Origin calldata origin,
        bytes32 guid,
        bytes calldata message,
        address executor,
        bytes calldata extraData
    ) internal virtual;

    function _lzSend(uint32 dstEid, bytes memory message, bytes memory options, MessagingFee memory fee, address refund)
        internal
        returns (MessagingReceipt memory)
    {
        bytes32 peer = peers[dstEid];
        if (peer == bytes32(0)) revert NoPeerConfigured(dstEid);
        if (msg.value != fee.nativeFee) revert IncorrectFee(fee.nativeFee, msg.value);

        return ENDPOINT.send{value: fee.nativeFee}(
            MessagingParams({
                dstEid: dstEid,
                receiver: peer,
                message: message,
                options: options,
                payInLzToken: fee.lzTokenFee > 0
            }),
            refund
        );
    }

    function _quote(uint32 dstEid, bytes memory message, bytes memory options, bool payInLzToken)
        internal
        view
        returns (MessagingFee memory)
    {
        bytes32 peer = peers[dstEid];
        if (peer == bytes32(0)) revert NoPeerConfigured(dstEid);
        return ENDPOINT.quote(
            MessagingParams({
                dstEid: dstEid,
                receiver: peer,
                message: message,
                options: options,
                payInLzToken: payInLzToken
            }),
            address(this)
        );
    }

    function _toBytes32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }

    function _toAddress(bytes32 b) internal pure returns (address) {
        return address(uint160(uint256(b)));
    }
}
