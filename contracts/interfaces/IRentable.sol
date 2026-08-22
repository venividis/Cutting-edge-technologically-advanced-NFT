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

/**
 * @title ERC-6454 Minimal Transferable NFT detection
 * @notice interfaceId 0x91a6262f. Strictly more expressive than ERC-5192's binary flag:
 *         it answers "can this token move from A to B *right now*", which is the question a
 *         marketplace actually needs before it shows a Buy button.
 * @dev Both standards are merely descriptive — returning false stops nothing on its own.
 *      The transfer path must revert as well, which is why ANIMA enforces in `_update` and
 *      treats these two functions purely as the machine-readable explanation of why.
 *      `from == address(0)` asks about a mint, `to == address(0)` about a burn.
 */
interface IERC6454 {
    function isTransferable(uint256 tokenId, address from, address to) external view returns (bool);
}

/**
 * @title ERC-7572 Contract-level metadata
 * @notice `contractURI()`, the near-universal convention for collection-level metadata.
 * @dev Still Draft since 2023-12-06 despite being read by essentially every marketplace,
 *      and it publishes no interfaceId. ANIMA registers the community-computed 0xe8a3d485
 *      and treats a mismatch as harmless: consumers detect this function by calling it.
 *      Note the event carries no arguments, so listeners must blindly re-fetch.
 */
interface IERC7572 {
    event ContractURIUpdated();

    function contractURI() external view returns (string memory);
}
