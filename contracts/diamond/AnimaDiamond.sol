// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IDiamond} from "./IDiamond.sol";
import {DiamondStorage} from "./DiamondStorage.sol";

/**
 * @title AnimaDiamond — an EIP-2535 diamond with the cut welded shut
 * @notice The same agent token as {AnimaAgent}, assembled from facets so it is not bounded
 *         by EIP-170's 24,576 bytes — and with no way to ever change those facets.
 *
 * @dev **Why a diamond at all.** The monolith fits, with 605 bytes to spare. That is not a
 *      margin, it is a countdown: the next Final standard worth adopting does not fit, and
 *      the levers left (drop the metadata trailer, cut optimizer runs) each cost something
 *      permanent to buy a few hundred bytes once. A diamond removes the ceiling instead of
 *      raising it.
 *
 *      **Why immutable.** The usual reason to build a diamond is upgradeability, and that is
 *      precisely the property this contract must not have. An agent standard whose rules an
 *      admin can rewrite after you have bought the agent is not a standard; the buyer's
 *      guarantee that a sale revokes the seller's session keys is worth exactly as much as
 *      the admin key that could remove it. So the facets are wired in the constructor and
 *      there is no `diamondCut`, no `owner` over the routing table, and no `delegatecall`
 *      reachable after construction other than through the frozen table. EIP-2535 provides
 *      for this explicitly: *"A diamond that has no external function for adding, replacing
 *      or removing functions is immutable."*
 *
 *      What remains configurable is exactly what is configurable in the monolith, and by the
 *      same two-step owner: the re-key verifier, the module allowlist, royalties and the
 *      contract URI. Those are pointers the standard names as swappable. The code is not.
 *
 *      **Verifying that claim.** Call {IDiamondLoupe-facets} and confirm (a) no selector
 *      resolves to `diamondCut`, and (b) each facet address holds the bytecode you expect.
 *      Both are answerable from an RPC node with no trust in the deployer.
 */
contract AnimaDiamond is IDiamond {
    error FunctionNotFound(bytes4 selector);
    error NotAnAddition(FacetCutAction action);
    error FacetHasNoCode(address facet);
    error EmptyFacetCut(address facet);
    error SelectorAlreadyBound(bytes4 selector, address boundTo);
    error InitializationFailed();

    /**
     * @param cuts Facets to wire in, all of action `Add`. Every selector must be unique
     *        across the whole set — a diamond in which two facets claim `balanceOf` has no
     *        principled answer to which one runs, so this reverts rather than picking.
     * @param init Contract to `delegatecall` once for initialisation, or the zero address.
     * @param initCalldata Calldata for that call.
     */
    constructor(FacetCut[] memory cuts, address init, bytes memory initCalldata) payable {
        DiamondStorage.Layout storage $ = DiamondStorage.layout();

        for (uint256 i; i < cuts.length; ++i) {
            FacetCut memory cut = cuts[i];
            if (cut.action != FacetCutAction.Add) revert NotAnAddition(cut.action);
            if (cut.facetAddress.code.length == 0) revert FacetHasNoCode(cut.facetAddress);
            if (cut.functionSelectors.length == 0) revert EmptyFacetCut(cut.facetAddress);

            if ($.selectorsOf[cut.facetAddress].length == 0) $.facetAddresses.push(cut.facetAddress);

            for (uint256 j; j < cut.functionSelectors.length; ++j) {
                bytes4 selector = cut.functionSelectors[j];
                address bound = $.facetOf[selector];
                if (bound != address(0)) revert SelectorAlreadyBound(selector, bound);
                $.facetOf[selector] = cut.facetAddress;
                $.selectorsOf[cut.facetAddress].push(selector);
            }
        }

        // EIP-2535: the event is required for all cuts, "including cuts in the constructor".
        // For an immutable diamond it is the only one that will ever be emitted, which makes
        // it the permanent, indexable record of what this address actually is.
        emit DiamondCut(cuts, init, initCalldata);

        if (init != address(0)) {
            (bool ok, bytes memory returndata) = init.delegatecall(initCalldata);
            if (!ok) {
                if (returndata.length == 0) revert InitializationFailed();
                assembly {
                    revert(add(returndata, 0x20), mload(returndata))
                }
            }
        }
    }

    /// @dev The only executable code this contract has after construction. `payable` so that
    ///      facet functions may accept value; a bare ETH transfer still reverts, because
    ///      empty calldata resolves to selector `0x00000000`, which is bound to nothing.
    fallback() external payable {
        address facet = DiamondStorage.layout().facetOf[msg.sig];
        if (facet == address(0)) revert FunctionNotFound(msg.sig);
        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), facet, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }
}
