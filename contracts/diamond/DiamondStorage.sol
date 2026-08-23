// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title DiamondStorage — the selector table, in its own ERC-7201 namespace
 * @dev Separate from {AnimaStorage} on purpose. The routing table is infrastructure; agent
 *      state is the product. Keeping them in different namespaces means a future ANIMA
 *      field can never be added in a position that walks into the facet map.
 */
library DiamondStorage {
    /// @custom:storage-location erc7201:anima.storage.diamond
    struct Layout {
        mapping(bytes4 selector => address facet) facetOf;
        mapping(address facet => bytes4[] selectors) selectorsOf;
        address[] facetAddresses;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("anima.storage.diamond")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant SLOT = 0xbebefff3c1769f392cbed28935c84c24a3fe9fb422c6177e5902f9088f11d900;

    function layout() internal pure returns (Layout storage $) {
        assembly {
            $.slot := SLOT
        }
    }
}
