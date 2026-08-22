// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @notice What crosses the wire when an agent moves chains.
 * @dev The default ONFT721 message carries only `(to, tokenId)`, which is enough to move a
 *      collectible and not nearly enough to move an agent: the receiving chain would have a
 *      token with an id and no way to know what that agent *is*. Carrying the commitments
 *      means a mirror is a verifiable replica — a client can fetch the manifest, hash it,
 *      and check it against what the home chain attested at departure.
 */
struct AgentSnapshot {
    bytes32 to;
    uint256 agentId;
    bytes32 brainRoot;
    uint64 brainEpoch;
    bytes32 manifestHash;
    bytes32 weightsRoot;
    uint8 seal;
    uint64 homeChainId;
    bytes32 homeToken;
    string agentURI;
}

/**
 * @title AnimaOmniCodec
 * @dev Plain `abi.encode`, deliberately. Hand-packed cross-chain codecs save a few hundred
 *      gas and have produced a remarkable number of critical bugs; the ABI coder is the
 *      audited option and its length-prefixing makes a truncated payload fail to decode
 *      rather than silently decode into something else.
 */
library AnimaOmniCodec {
    function encode(AgentSnapshot memory snapshot) internal pure returns (bytes memory) {
        return abi.encode(snapshot);
    }

    function decode(bytes calldata message) internal pure returns (AgentSnapshot memory) {
        return abi.decode(message, (AgentSnapshot));
    }
}
