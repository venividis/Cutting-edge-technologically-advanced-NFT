// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title ERC-4907 Rental NFT
 * @notice interfaceId 0xad092b5c. An agent's `user` is the party entitled to operate it
 *         (submit jobs, spend its metered budget) without owning it. ANIMA keeps the
 *         owner's slashable bond in place across a rental, so renting out an agent does
 *         not launder away accountability.
 */
interface IERC4907 {
    event UpdateUser(uint256 indexed tokenId, address indexed user, uint64 expires);

    function setUser(uint256 tokenId, address user, uint64 expires) external;

    function userOf(uint256 tokenId) external view returns (address);

    function userExpires(uint256 tokenId) external view returns (uint256);
}

/**
 * @title ERC-5192 Minimal Soulbound NFT
 * @notice interfaceId 0xb45a3c0e. ANIMA uses locking as a *temporary* safety property,
 *         not a permanent one: an agent is locked while it holds an active work escrow or
 *         while its bond is subject to a live dispute, so it cannot be sold out from under
 *         a counterparty mid-job.
 */
interface IERC5192 {
    event Locked(uint256 tokenId);
    event Unlocked(uint256 tokenId);

    function locked(uint256 tokenId) external view returns (bool);
}
