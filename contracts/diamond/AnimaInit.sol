// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AnimaBase} from "./AnimaBase.sol";
import {AnimaStorage} from "./AnimaStorage.sol";
import {IAnima} from "../interfaces/IAnima.sol";
import {IERC6551Registry} from "../interfaces/IERC6551.sol";
import {ITransferVerifier} from "../interfaces/ITransferVerifier.sol";
import {EncryptionKeyRegistry} from "../core/EncryptionKeyRegistry.sol";

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
 */
contract AnimaInit is AnimaBase {
    function init(
        string memory name_,
        string memory symbol_,
        address owner_,
        IERC6551Registry registry_,
        address accountImplementation_,
        bytes32 accountSalt_,
        ITransferVerifier verifier_,
        EncryptionKeyRegistry keyRegistry_,
        address royaltyReceiver_,
        uint96 royaltyBps_
    ) external initializer {
        if (address(registry_) == address(0) || accountImplementation_ == address(0)) revert ZeroAddress();
        if (address(keyRegistry_) == address(0)) revert ZeroAddress();

        __ERC721_init(name_, symbol_);
        __EIP712_init("AnimaAgent", "1");
        __Ownable_init(owner_);

        AnimaStorage.Layout storage $ = AnimaStorage.layout();
        $.registry = registry_;
        $.accountImplementation = accountImplementation_;
        $.accountSalt = accountSalt_;
        $.keyRegistry = keyRegistry_;
        // Agent ids are one-based so that `agentId == 0` stays an unambiguous "no agent"
        // across every registry that keys on it.
        $.nextAgentId = 1;

        _setVerifier(verifier_);
        if (royaltyReceiver_ != address(0)) _setDefaultRoyalty(royaltyReceiver_, royaltyBps_);
    }
}
