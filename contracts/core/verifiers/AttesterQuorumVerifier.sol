// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ITransferVerifier, ReKeyRequest} from "../../interfaces/ITransferVerifier.sol";
import {SealPolicy} from "../../interfaces/IAnima.sol";

/**
 * @title AttesterQuorumVerifier
 * @notice Certifies that an agent's private state was re-encrypted for its new owner inside
 *         an attested confidential-compute environment, as witnessed by an M-of-N quorum of
 *         registered attesters.
 *
 * @dev Why a quorum and not a raw on-chain TEE quote?
 *
 *      Verifying an Intel TDX or SEV-SNP quote on-chain means verifying an X.509 chain plus
 *      ECDSA-P384 against a provisioning root, and then keeping TCB recovery and CRL state
 *      current forever. That is possible, but it puts a hardware vendor's revocation
 *      schedule inside your token contract's liveness path. The quorum instead pushes quote
 *      parsing to attesters who are cheap to rotate, and keeps on-chain what actually needs
 *      to be immutable: *which* enclave build was permitted, and that enough independent
 *      parties signed for it.
 *
 *      The enclave measurement is part of the signed payload, so a quorum cannot silently
 *      certify a different (backdoored) re-encryption program than the one governance
 *      approved. That is the property that makes `SealPolicy.SealedTEE` meaningful.
 *
 *      Honest limitations, stated because a standard that hides them is worse than useless:
 *        - collusion of `threshold` attesters forges a re-key;
 *        - a hardware break in the enclave family breaks the guarantee;
 *        - none of this stops a prior owner who *already exported* plaintext. Sealing
 *          protects future state, not memories already taken out of the box.
 */
contract AttesterQuorumVerifier is ITransferVerifier, EIP712, Ownable2Step {
    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    bytes32 private constant _REKEY_TYPEHASH = keccak256(
        "ReKey(uint256 chainId,address anima,uint256 agentId,address from,address to,bytes32 oldBrainRoot,bytes32 newBrainRoot,uint64 oldEpoch,bytes32 recipientKeyId,bytes32 sealedKeysHash,bytes32 enclaveMeasurement)"
    );

    mapping(address attester => bool) public isAttester;
    mapping(bytes32 measurement => bool) public isApprovedEnclave;
    mapping(bytes32 digest => bool) public consumed;

    uint256 public attesterCount;
    uint256 public threshold;

    /*//////////////////////////////////////////////////////////////
                             EVENTS / ERRORS
    //////////////////////////////////////////////////////////////*/

    event AttesterSet(address indexed attester, bool allowed);
    event EnclaveSet(bytes32 indexed measurement, bool allowed);
    event ThresholdSet(uint256 threshold);
    event ReKeyCertified(uint256 indexed agentId, bytes32 indexed digest, bytes32 enclaveMeasurement, uint256 signers);

    error ThresholdTooHigh(uint256 threshold, uint256 attesterCount);
    error ThresholdZero();
    error EnclaveNotApproved(bytes32 measurement);
    error NotEnoughSignatures(uint256 got, uint256 need);
    error SignersNotSorted();
    error UnknownAttester(address signer);
    error BadSignature(address signer);
    error ProofAlreadyUsed(bytes32 digest);
    error LengthMismatch();
    error NotTheRequestingToken(address expected, address caller);
    error WrongChain(uint256 expected, uint256 actual);

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    constructor(address owner_, address[] memory attesters, uint256 threshold_, bytes32[] memory enclaves)
        EIP712("AnimaAttesterQuorum", "1")
        Ownable(owner_)
    {
        for (uint256 i; i < attesters.length; ++i) {
            if (!isAttester[attesters[i]]) {
                isAttester[attesters[i]] = true;
                ++attesterCount;
                emit AttesterSet(attesters[i], true);
            }
        }
        for (uint256 i; i < enclaves.length; ++i) {
            isApprovedEnclave[enclaves[i]] = true;
            emit EnclaveSet(enclaves[i], true);
        }
        _setThreshold(threshold_);
    }

    /*//////////////////////////////////////////////////////////////
                                GOVERNANCE
    //////////////////////////////////////////////////////////////*/

    function setAttester(address attester, bool allowed) external onlyOwner {
        if (isAttester[attester] == allowed) return;
        isAttester[attester] = allowed;
        unchecked {
            attesterCount = allowed ? attesterCount + 1 : attesterCount - 1;
        }
        // Removing attesters must never leave an unsatisfiable quorum, which would brick
        // every future transfer of every agent using this verifier.
        if (!allowed && threshold > attesterCount) revert ThresholdTooHigh(threshold, attesterCount);
        emit AttesterSet(attester, allowed);
    }

    function setEnclave(bytes32 measurement, bool allowed) external onlyOwner {
        isApprovedEnclave[measurement] = allowed;
        emit EnclaveSet(measurement, allowed);
    }

    function setThreshold(uint256 threshold_) external onlyOwner {
        _setThreshold(threshold_);
    }

    function _setThreshold(uint256 threshold_) private {
        if (threshold_ == 0) revert ThresholdZero();
        if (threshold_ > attesterCount) revert ThresholdTooHigh(threshold_, attesterCount);
        threshold = threshold_;
        emit ThresholdSet(threshold_);
    }

    /*//////////////////////////////////////////////////////////////
                              VERIFICATION
    //////////////////////////////////////////////////////////////*/

    function sealPolicy() external pure returns (SealPolicy) {
        return SealPolicy.SealedTEE;
    }

    /// @param proof abi.encode(bytes32 enclaveMeasurement, address[] signers, bytes[] signatures)
    function verifyReKey(ReKeyRequest calldata request, bytes calldata proof) external returns (bool) {
        // Proofs are single-use, so a stranger who could consume one could permanently block a
        // sealed transfer by front-running it with the seller's own proof, read from the
        // mempool. Binding consumption to the token contract named in the request makes the
        // digest useless to anyone else.
        if (request.anima != msg.sender) revert NotTheRequestingToken(request.anima, msg.sender);
        if (request.chainId != block.chainid) revert WrongChain(block.chainid, request.chainId);

        (bytes32 measurement, address[] memory signers, bytes[] memory signatures) =
            abi.decode(proof, (bytes32, address[], bytes[]));

        if (signers.length != signatures.length) revert LengthMismatch();
        if (!isApprovedEnclave[measurement]) revert EnclaveNotApproved(measurement);

        uint256 need = threshold;
        if (signers.length < need) revert NotEnoughSignatures(signers.length, need);

        bytes32 digest = _digest(request, measurement);
        if (consumed[digest]) revert ProofAlreadyUsed(digest);
        consumed[digest] = true;

        // Strictly ascending order gives duplicate-rejection in O(n) without a set, and is
        // cheap for the prover to satisfy.
        address previous;
        for (uint256 i; i < signers.length; ++i) {
            address signer = signers[i];
            if (signer <= previous) revert SignersNotSorted();
            previous = signer;
            if (!isAttester[signer]) revert UnknownAttester(signer);
            // SignatureChecker accepts both ECDSA and ERC-1271, so an attester may itself
            // be a multisig or a rotating-key contract.
            if (!SignatureChecker.isValidSignatureNow(signer, digest, signatures[i])) revert BadSignature(signer);
        }

        emit ReKeyCertified(request.agentId, digest, measurement, signers.length);
        return true;
    }

    function digestOf(ReKeyRequest calldata request, bytes32 measurement) external view returns (bytes32) {
        return _digest(request, measurement);
    }

    function _digest(ReKeyRequest calldata r, bytes32 measurement) private view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    _REKEY_TYPEHASH,
                    r.chainId,
                    r.anima,
                    r.agentId,
                    r.from,
                    r.to,
                    r.oldBrainRoot,
                    r.newBrainRoot,
                    r.oldEpoch,
                    r.recipientKeyId,
                    r.sealedKeysHash,
                    measurement
                )
            )
        );
    }
}
