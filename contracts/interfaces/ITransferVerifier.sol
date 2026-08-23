// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SealPolicy} from "./IAnima.sol";

/// @notice Everything a verifier needs to decide whether a re-keying is legitimate.
/// @dev The struct is hashed with EIP-712 by signature-based verifiers and used as the
///      public input by proof-based ones, so both families bind to the *same* commitment.
struct ReKeyRequest {
    uint256 chainId; //         replay protection across forks and deployments
    address anima; //           the token contract this request is for
    uint256 agentId;
    address from;
    address to;
    bytes32 oldBrainRoot;
    bytes32 newBrainRoot;
    uint64 oldEpoch; //         pins the exact state being re-keyed
    bytes32 recipientKeyId; //  keccak256 of the recipient's encryption public key
    bytes32 sealedKeysHash; //  keccak256(abi.encode(sealedKeys)) — binds the payload
}

/**
 * @title ITransferVerifier
 * @notice Pluggable adjudicator for "was this agent's private state honestly re-keyed to
 *         the new owner?".
 *
 *         ANIMA does not hard-code a trust model. A collection targeting consumer art can
 *         run `NullTransferVerifier`; one custodying trading strategies can require an
 *         enclave quorum; a future one can drop in a zk verifier without a token migration.
 *         What ANIMA *does* fix is that the achieved guarantee is published on-chain as a
 *         `SealPolicy`, so nobody can quietly sell a weaker promise than they advertise.
 */
interface ITransferVerifier {
    /// @notice The strongest guarantee this verifier is able to certify.
    function sealPolicy() external view returns (SealPolicy);

    /// @notice Verify a re-key. MUST revert or return false on failure, and MUST be
    ///         replay-safe: a proof accepted once must never be accepted again.
    /// @dev Non-view by design — implementations need to burn nonces.
    function verifyReKey(ReKeyRequest calldata request, bytes calldata proof) external returns (bool);
}
