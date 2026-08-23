// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AnimaBase} from "./AnimaBase.sol";
import {AnimaStorage} from "./AnimaStorage.sol";
import {AnimaConfig} from "./IAnimaConfigured.sol";
import {ITransferVerifier} from "../interfaces/ITransferVerifier.sol";

/**
 * @title AnimaInit — the diamond's constructor, borrowed
 * @notice Delegatecalled exactly once, from {AnimaDiamond}'s constructor, to do the work the
 *         monolith does in its own constructor.
 *
 * @dev A facet's constructor runs against the *facet's* storage, not the diamond's, so a
 *      diamond needs a separate initialiser reached by `delegatecall`. Two things make that
 *      safe here rather than merely conventional:
 *
 *      1. `initializer` writes its flag into the diamond's ERC-7201 `Initializable`
 *         namespace, so a second call reverts.
 *      2. This contract's `init` selector is never added to the diamond's function table, so
 *         after construction there is no route to it at all — not even a reverting one.
 *
 *      Calling `init` on this contract *directly* initialises this contract's own storage
 *      and affects no diamond. It is inert by construction, not by discipline.
 *
 *      It takes the {AnimaConfig} too, and therefore answers `animaConfigHash()` — so the
 *      diamond's agreement check covers the initialiser as well as the facets. An initialiser
 *      compiled against a different ERC-6551 registry than the facets it initialises would be
 *      a subtle way to end up with a token nobody can explain, and it cannot happen.
 */
contract AnimaInit is AnimaBase {
    constructor(AnimaConfig memory config) AnimaBase(config) {}

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

        // Agent ids are one-based so that `agentId == 0` stays an unambiguous "no agent"
        // across every registry that keys on it.
        AnimaStorage.layout().nextAgentId = 1;

        _setVerifier(verifier_);
        if (royaltyReceiver_ != address(0)) _setDefaultRoyalty(royaltyReceiver_, royaltyBps_);
    }
}
