// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
    ILayerZeroEndpointV2, ILayerZeroReceiver, MessagingParams, MessagingReceipt, MessagingFee, Origin
} from "../omni/ILayerZeroV2.sol";

/**
 * @notice In-memory LayerZero V2 endpoint pair for tests: `send` queues a packet, and the
 *         test harness calls `deliver` on the counterpart endpoint to complete the hop.
 * @dev Deliberately does *not* auto-deliver. Cross-chain bugs live in the gap between send
 *      and receive, and an endpoint that delivers synchronously hides exactly the reordering
 *      and replay cases worth testing.
 */
contract MockLZEndpoint is ILayerZeroEndpointV2 {
    struct Packet {
        uint32 dstEid;
        bytes32 receiver;
        bytes message;
        address sender;
        bool delivered;
    }

    uint32 public immutable LOCAL_EID;
    uint256 public nativeFee = 1e15;
    Packet[] public packets;
    mapping(address oapp => address) public delegates;

    constructor(uint32 eid_) {
        LOCAL_EID = eid_;
    }

    function eid() external view returns (uint32) {
        return LOCAL_EID;
    }

    function setNativeFee(uint256 fee) external {
        nativeFee = fee;
    }

    function packetCount() external view returns (uint256) {
        return packets.length;
    }

    function quote(MessagingParams calldata, address) external view returns (MessagingFee memory) {
        return MessagingFee({nativeFee: nativeFee, lzTokenFee: 0});
    }

    function send(MessagingParams calldata params, address) external payable returns (MessagingReceipt memory) {
        require(msg.value >= nativeFee, "insufficient fee");
        packets.push(
            Packet({
                dstEid: params.dstEid,
                receiver: params.receiver,
                message: params.message,
                sender: msg.sender,
                delivered: false
            })
        );
        return MessagingReceipt({
            guid: keccak256(abi.encode(block.chainid, packets.length)),
            nonce: uint64(packets.length),
            fee: MessagingFee({nativeFee: nativeFee, lzTokenFee: 0})
        });
    }

    function setDelegate(address delegate) external {
        delegates[msg.sender] = delegate;
    }

    /// @notice Deliver a packet queued on `source` into an OApp on this endpoint.
    /// @param spoofSender Override the claimed origin sender, to test peer authentication.
    function deliver(MockLZEndpoint source, uint256 packetIndex, address receiver, bytes32 spoofSender) external {
        (,, bytes memory message, address sender, bool delivered) = source.packetAt(packetIndex);
        require(!delivered, "already delivered");
        source.markDelivered(packetIndex);

        bytes32 origin = spoofSender == bytes32(0) ? bytes32(uint256(uint160(sender))) : spoofSender;
        ILayerZeroReceiver(receiver).lzReceive(
            Origin({srcEid: source.LOCAL_EID(), sender: origin, nonce: uint64(packetIndex + 1)}),
            keccak256(abi.encode(packetIndex)),
            message,
            address(this),
            ""
        );
    }

    function packetAt(uint256 i)
        external
        view
        returns (uint32 dstEid, bytes32 receiver, bytes memory message, address sender, bool delivered)
    {
        Packet storage p = packets[i];
        return (p.dstEid, p.receiver, p.message, p.sender, p.delivered);
    }

    function markDelivered(uint256 i) external {
        packets[i].delivered = true;
    }
}
