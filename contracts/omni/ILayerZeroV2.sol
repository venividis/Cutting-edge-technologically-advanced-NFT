// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/*
 * Minimal LayerZero V2 surface, transcribed from
 * @layerzerolabs/lz-evm-protocol-v2 ILayerZeroEndpointV2.sol.
 *
 * Declared locally rather than imported because that package's `exports` map does not expose
 * its `contracts/` subpath, so a Node-resolution build cannot import it. The protocol uses no
 * LayerZero package implementation: it talks to the deployed endpoint only through this ABI.
 * Keeping the three structs and receiver/endpoint functions actually used here makes the build
 * hermetic, keeps the ABI byte-identical, and avoids shipping LayerZero's unused tooling tree.
 */

struct MessagingParams {
    uint32 dstEid;
    bytes32 receiver;
    bytes message;
    bytes options;
    bool payInLzToken;
}

struct MessagingReceipt {
    bytes32 guid;
    uint64 nonce;
    MessagingFee fee;
}

struct MessagingFee {
    uint256 nativeFee;
    uint256 lzTokenFee;
}

struct Origin {
    uint32 srcEid;
    bytes32 sender;
    uint64 nonce;
}

interface ILayerZeroEndpointV2 {
    function quote(MessagingParams calldata params, address sender) external view returns (MessagingFee memory);

    function send(MessagingParams calldata params, address refundAddress)
        external
        payable
        returns (MessagingReceipt memory);

    function setDelegate(address delegate) external;

    function eid() external view returns (uint32);
}

interface ILayerZeroReceiver {
    function allowInitializePath(Origin calldata origin) external view returns (bool);

    function nextNonce(uint32 srcEid, bytes32 sender) external view returns (uint64);

    function lzReceive(
        Origin calldata origin,
        bytes32 guid,
        bytes calldata message,
        address executor,
        bytes calldata extraData
    ) external payable;
}
