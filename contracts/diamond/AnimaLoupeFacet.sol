// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IDiamondLoupe} from "./IDiamond.sol";
import {DiamondStorage} from "./DiamondStorage.sol";

/**
 * @title AnimaLoupeFacet — EIP-2535 introspection
 * @notice Answers "what code is behind this address, and can it change?" without trusting
 *         anyone's word for it.
 * @dev EIP-2535 requires a diamond to "return information about immutable functions if they
 *      exist" — those are functions defined on the diamond contract itself, whose reported
 *      facet address is the diamond's own. {AnimaDiamond} defines none: it is nothing but a
 *      constructor and a fallback, so every selector reported here resolves to a real,
 *      separately deployed and separately verifiable facet.
 */
contract AnimaLoupeFacet is IDiamondLoupe {
    function facets() external view returns (Facet[] memory facets_) {
        DiamondStorage.Layout storage $ = DiamondStorage.layout();
        uint256 n = $.facetAddresses.length;
        facets_ = new Facet[](n);
        for (uint256 i; i < n; ++i) {
            address facet = $.facetAddresses[i];
            facets_[i] = Facet({facetAddress: facet, functionSelectors: $.selectorsOf[facet]});
        }
    }

    function facetFunctionSelectors(address _facet) external view returns (bytes4[] memory) {
        return DiamondStorage.layout().selectorsOf[_facet];
    }

    function facetAddresses() external view returns (address[] memory) {
        return DiamondStorage.layout().facetAddresses;
    }

    function facetAddress(bytes4 _functionSelector) external view returns (address) {
        return DiamondStorage.layout().facetOf[_functionSelector];
    }
}
