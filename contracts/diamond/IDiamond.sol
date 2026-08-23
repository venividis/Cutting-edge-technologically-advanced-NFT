// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title IDiamond — EIP-2535 cut vocabulary
 * @notice The types and the event, without the `diamondCut` function.
 *
 * @dev EIP-2535 requires the `DiamondCut` event for *every* cut "including cuts in the
 *      constructor", but does not require a `diamondCut` function: "A diamond that has no
 *      external function for adding, replacing or removing functions is immutable." An
 *      immutable diamond therefore needs the vocabulary and not the verb, which is exactly
 *      this interface. `IDiamondCut` is deliberately absent from the codebase — there is no
 *      contract to inherit it from, so there is no path by which a later edit accidentally
 *      makes {AnimaDiamond} mutable.
 */
interface IDiamond {
    enum FacetCutAction {
        Add,
        Replace,
        Remove
    }

    struct FacetCut {
        address facetAddress;
        FacetCutAction action;
        bytes4[] functionSelectors;
    }

    event DiamondCut(FacetCut[] _diamondCut, address _init, bytes _calldata);
}

/**
 * @title IDiamondLoupe — EIP-2535 introspection. interfaceId `0x48e2b093`.
 * @notice What functions this diamond has and where each one lives.
 * @dev Mandatory for every diamond, immutable ones included: the loupe is how a caller
 *      verifies for itself that the code behind an address is the code it agreed to, and
 *      how it confirms — by finding no `diamondCut` selector — that nobody can change it.
 */
interface IDiamondLoupe {
    struct Facet {
        address facetAddress;
        bytes4[] functionSelectors;
    }

    function facets() external view returns (Facet[] memory facets_);

    function facetFunctionSelectors(address _facet) external view returns (bytes4[] memory facetFunctionSelectors_);

    function facetAddresses() external view returns (address[] memory facetAddresses_);

    function facetAddress(bytes4 _functionSelector) external view returns (address facetAddress_);
}
