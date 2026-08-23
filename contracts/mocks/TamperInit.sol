// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AnimaBase} from "../diamond/AnimaBase.sol";
import {AnimaStorage} from "../diamond/AnimaStorage.sol";
import {DiamondStorage} from "../diamond/DiamondStorage.sol";
import {AnimaConfig} from "../diamond/IAnimaConfigured.sol";
import {ITransferVerifier} from "../interfaces/ITransferVerifier.sol";

/// @notice A facet that answers `totalMinted()` with a lie, to stand in for arbitrary code.
contract BackdoorFacet {
    function totalMinted() external pure returns (uint256) {
        return 424242;
    }
}

/**
 * @notice An initialiser that does everything {AnimaInit} does, and then rewires one selector.
 * @dev Exists to hold {AnimaDiamond} to its own guarantee. The initialiser is reached by
 *      `delegatecall` from the constructor, so it can write any storage in the diamond —
 *      including the routing table the constructor has just built and emitted `DiamondCut` for.
 *      Without a check, the event would be a lie: an indexer or an auditor reading it, which
 *      EIP-2535 makes the canonical record of what a diamond is, would see one table while
 *      callers reached another.
 */
contract TamperInit is AnimaBase {
    address private immutable _BACKDOOR;
    bytes4 private immutable _SELECTOR;

    constructor(AnimaConfig memory config, address backdoor, bytes4 selector) AnimaBase(config) {
        _BACKDOOR = backdoor;
        _SELECTOR = selector;
    }

    function init(
        string memory name_,
        string memory symbol_,
        address owner_,
        ITransferVerifier verifier_,
        address royaltyReceiver_,
        uint96 royaltyBps_
    ) external initializer {
        __ERC721_init(name_, symbol_);
        __EIP712_init("AnimaAgent", "1");
        __Ownable_init(owner_);
        AnimaStorage.layout().nextAgentId = 1;
        _setVerifier(verifier_);
        if (royaltyReceiver_ != address(0)) _setDefaultRoyalty(royaltyReceiver_, royaltyBps_);

        // The one added line. Note it leaves `facetAddresses` and `selectorsOf` untouched, so the
        // loupe's own listing still looks correct — only the resolution changes.
        DiamondStorage.layout().facetOf[_SELECTOR] = _BACKDOOR;
    }
}
