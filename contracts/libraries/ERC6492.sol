// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/**
 * @title ERC6492
 * @notice Signature validation for accounts that have not been deployed yet.
 *
 * @dev ANIMA needs this more than most protocols do, because counterfactual accounts are not an
 *      edge case here — they are the design. An ERC-6551 account has a deterministic address
 *      from the moment its token exists and is typically deployed lazily, on first use. So an
 *      agent can be listed, hired, or messaged at an address that holds no code, and every
 *      ERC-1271 check against it fails: a `staticcall` to an address with no code succeeds and
 *      returns nothing, which reads as "invalid signature" rather than "not deployed yet".
 *
 *      ERC-6492 (Final) fixes this by letting a signature carry its own deployment instructions,
 *      wrapped as `abi.encode(factory, factoryCalldata, innerSignature)` followed by a 32-byte
 *      magic suffix. The suffix value was chosen so it cannot collide with a valid ECDSA
 *      signature — its last byte, `0x92`, is not a legal `v`.
 *
 *      Validation is therefore state-changing: it may deploy the account. That is acceptable at
 *      a settlement site, which is where this is used, and is why it is not a `view` function.
 *      A caller that only wants to read should require the account to exist first.
 */
library ERC6492 {
    bytes32 internal constant MAGIC = 0x6492649264926492649264926492649264926492649264926492649264926492;

    /// @notice Validate a signature, deploying the signer first if it carries an ERC-6492 wrapper.
    /// @dev Falls through to ordinary ECDSA / ERC-1271 validation for unwrapped signatures, so it
    ///      is a drop-in replacement for `SignatureChecker.isValidSignatureNow`.
    function isValidSignatureNow(address signer, bytes32 hash, bytes memory signature) internal returns (bool) {
        if (_hasMagic(signature)) {
            // Only prepare an account that genuinely has no code. Honouring the wrapper against
            // an already-deployed signer would let anyone run an arbitrary call on a factory as
            // a side effect of "checking a signature".
            if (signer.code.length == 0) {
                bytes memory inner = new bytes(signature.length - 32);
                for (uint256 i; i < inner.length; ++i) {
                    inner[i] = signature[i];
                }
                (address factory, bytes memory factoryCalldata, bytes memory innerSignature) =
                    abi.decode(inner, (address, bytes, bytes));

                // A failed preparation is not fatal: the account may have been deployed by
                // someone else between quoting and settling, in which case the plain 1271 check
                // below still succeeds.
                (bool ok,) = factory.call(factoryCalldata);
                ok;
                return SignatureChecker.isValidSignatureNow(signer, hash, innerSignature);
            }
            // Deployed after the signature was produced: strip the wrapper and check normally.
            bytes memory stripped = new bytes(signature.length - 32);
            for (uint256 i; i < stripped.length; ++i) {
                stripped[i] = signature[i];
            }
            (,, bytes memory sig) = abi.decode(stripped, (address, bytes, bytes));
            return SignatureChecker.isValidSignatureNow(signer, hash, sig);
        }
        return SignatureChecker.isValidSignatureNow(signer, hash, signature);
    }

    function _hasMagic(bytes memory signature) private pure returns (bool) {
        if (signature.length < 32) return false;
        bytes32 tail;
        assembly ("memory-safe") {
            tail := mload(add(add(signature, 0x20), sub(mload(signature), 32)))
        }
        return tail == MAGIC;
    }
}
