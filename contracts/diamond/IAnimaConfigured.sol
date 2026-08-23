// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC6551Registry} from "../interfaces/IERC6551.sol";
import {EncryptionKeyRegistry} from "../core/EncryptionKeyRegistry.sol";

/// @notice The four addresses an ANIMA token is pinned to for its whole life.
/// @dev Grouped into a struct so every facet's constructor takes one argument that cannot be
///      passed in the wrong order — three of the four are addresses, and a transposed pair
///      would deploy a diamond that derives every agent's wallet to the wrong place.
struct AnimaConfig {
    IERC6551Registry registry;
    address accountImplementation;
    bytes32 accountSalt;
    EncryptionKeyRegistry keyRegistry;
}

/**
 * @title IAnimaConfigured — how a diamond checks its facets agree
 * @notice Implemented by every facet that carries the {AnimaConfig}, so the diamond's
 *         constructor can confirm they all carry the *same* one.
 *
 * @dev The values are `immutable` in each facet, which is what makes them free to read: an
 *      immutable is inlined into the runtime code of whatever executes, and under `delegatecall`
 *      that is the facet's own code. Storage would have cost three cold `SLOAD`s on `accountOf`,
 *      measured at ~6,300 gas — paid by every settlement in the protocol, since eight contracts
 *      call `accountOf` to find where an agent's money goes.
 *
 *      The obvious hazard of per-facet immutables is that the facets could be deployed
 *      disagreeing, producing a token whose agents' wallet addresses depend on which function
 *      you asked. So it is checked rather than hoped: {AnimaDiamond}'s constructor collects this
 *      hash from every facet that answers and refuses to deploy unless they match. A facet that
 *      does not implement this carries no configuration and is skipped.
 */
interface IAnimaConfigured {
    /// @return keccak256(abi.encode(registry, accountImplementation, accountSalt, keyRegistry))
    function animaConfigHash() external view returns (bytes32);
}
