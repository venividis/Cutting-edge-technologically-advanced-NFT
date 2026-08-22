// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC6551Registry} from "../interfaces/IERC6551.sol";

/**
 * @title ERC6551Registry
 * @notice Behaviour-faithful reimplementation of the canonical ERC-6551 registry deployed at
 *         0x000000006551c19487814612e58FE06813775758 on every EVM chain.
 *
 * @dev Written in plain Solidity rather than the reference implementation's assembly, but it
 *      MUST produce a byte-identical proxy, because {AgentAccount.token} reads its own
 *      constructor arguments straight out of its deployed code. The runtime layout is:
 *
 *          offset  size  content
 *          0x00    10    ERC-1167 runtime prefix
 *          0x0a    20    implementation address
 *          0x1e    15    ERC-1167 runtime footer
 *          0x2d    32    salt
 *          0x4d    32    chainId          <- AgentAccount reads from here,
 *          0x6d    32    tokenContract       96 bytes covering these three
 *          0x8d    32    tokenId
 *
 *      Total runtime 0xad (173) bytes, which is why the creation header returns 0xad rather
 *      than the 0x2d of a bare minimal proxy.
 *
 *      Production deployments should point at the canonical registry; this exists so tests
 *      and local chains exercise the real address derivation instead of a stub that would
 *      hide a layout bug until mainnet.
 */
contract ERC6551Registry is IERC6551Registry {
    function createAccount(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external returns (address) {
        bytes memory code = _creationCode(implementation, salt, chainId, tokenContract, tokenId);
        address predicted = _addressOf(code, salt);

        // Idempotent, exactly as the canonical registry is: callers must be able to "ensure
        // deployed" without racing each other.
        if (predicted.code.length != 0) return predicted;

        address deployed;
        assembly ("memory-safe") {
            deployed := create2(0, add(code, 0x20), mload(code), salt)
        }
        if (deployed == address(0)) revert AccountCreationFailed();

        emit ERC6551AccountCreated(deployed, implementation, salt, chainId, tokenContract, tokenId);
        return deployed;
    }

    function account(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId)
        external
        view
        returns (address)
    {
        return _addressOf(_creationCode(implementation, salt, chainId, tokenContract, tokenId), salt);
    }

    function _creationCode(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) private pure returns (bytes memory) {
        return abi.encodePacked(
            // creation header: return the following 0xad bytes as runtime code
            hex"3d60ad80600a3d3981f3",
            // ERC-1167 runtime prefix
            hex"363d3d373d3d3d363d73",
            implementation,
            // ERC-1167 runtime footer
            hex"5af43d82803e903d91602b57fd5bf3",
            // 128 bytes of appended immutable arguments
            abi.encode(salt, chainId, tokenContract, tokenId)
        );
    }

    function _addressOf(bytes memory code, bytes32 salt) private view returns (address) {
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(code))))));
    }
}
