// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title ERC-6551 Non-fungible Token Bound Accounts
 * @notice The canonical registry is deployed at 0x000000006551c19487814612e58FE06813775758
 *         on every EVM chain via Nick's Factory (0x4e59b44847b379578588920cA78FbF26c0B4956C)
 *         with salt 0x0000000000000000000000000000000000000000fd8eb4e1dca713016c518e31.
 *         See https://eips.ethereum.org/EIPS/eip-6551.
 */
interface IERC6551Registry {
    event ERC6551AccountCreated(
        address account,
        address indexed implementation,
        bytes32 salt,
        uint256 chainId,
        address indexed tokenContract,
        uint256 indexed tokenId
    );

    error AccountCreationFailed();

    function createAccount(
        address implementation,
        bytes32 salt,
        uint256 chainId,
        address tokenContract,
        uint256 tokenId
    ) external returns (address account);

    function account(address implementation, bytes32 salt, uint256 chainId, address tokenContract, uint256 tokenId)
        external
        view
        returns (address account);
}

/// @dev ERC-165 interfaceId: 0x6faff5f1
interface IERC6551Account {
    receive() external payable;

    function token() external view returns (uint256 chainId, address tokenContract, uint256 tokenId);

    /// @notice Monotonically increasing counter, bumped on every state-changing execution.
    ///         Consumers MUST use it to detect that an account was used between the time a
    ///         purchase was quoted and the time it settled (the "sell the NFT with the
    ///         assets already drained" attack).
    function state() external view returns (uint256);

    function isValidSigner(address signer, bytes calldata context) external view returns (bytes4 magicValue);
}

/// @dev ERC-165 interfaceId: 0x51945447
interface IERC6551Executable {
    /// @param operation 0 = CALL, 1 = DELEGATECALL, 2 = CREATE, 3 = CREATE2
    function execute(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        payable
        returns (bytes memory);
}
