// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ITransferVerifier, ReKeyRequest} from "../../interfaces/ITransferVerifier.sol";
import {SealPolicy} from "../../interfaces/IAnima.sol";

/**
 * @title NullTransferVerifier
 * @notice Accepts any re-key. For agents whose brain is public, or whose key handover is
 *         an off-chain matter of trust between the parties.
 * @dev It reports `SealPolicy.Committed` and nothing stronger. The point of publishing the
 *      policy is that a marketplace can grey out "verified private state" for these agents
 *      instead of letting a seller imply a guarantee this verifier cannot make.
 */
contract NullTransferVerifier is ITransferVerifier {
    function sealPolicy() external pure returns (SealPolicy) {
        return SealPolicy.Committed;
    }

    function verifyReKey(ReKeyRequest calldata, bytes calldata) external pure returns (bool) {
        return true;
    }
}
