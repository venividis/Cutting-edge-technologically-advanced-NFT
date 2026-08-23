// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title EncryptionKeyRegistry
 * @notice Where an address publishes the public key that sealed content should be
 *         encrypted to.
 *
 * @dev A blockchain address is a hash, not a public key. You cannot encrypt to it, and a
 *      smart-account holder may have no recoverable encryption key at all. Every design
 *      that promises "the buyer receives the decryption key on transfer" has to solve this
 *      first, and most don't — which is how NFTs get sold with private state the buyer can
 *      never open.
 *
 *      ANIMA makes publishing a key a hard precondition of a sealed transfer. This registry
 *      is deliberately a standalone singleton rather than state on the token: a key is a
 *      property of a *person*, not of any one collection, so registering once should serve
 *      every ANIMA deployment on the chain.
 *
 *      The registry is intentionally unopinionated about the key's cryptosystem — X25519,
 *      secp256k1 ECIES, a post-quantum KEM — because the verifier and the sealing enclave
 *      are what must agree on it, not this contract. `keyType` names the scheme so they can.
 */
contract EncryptionKeyRegistry {
    struct KeyRecord {
        uint16 keyType; //   see KeyType below
        uint64 updatedAt;
        bytes publicKey;
    }

    /// @dev Conventional scheme identifiers. Values above 1000 are free for private use.
    uint16 public constant KEY_TYPE_X25519 = 1;
    uint16 public constant KEY_TYPE_SECP256K1_ECIES = 2;
    uint16 public constant KEY_TYPE_P256_ECIES = 3;
    uint16 public constant KEY_TYPE_ML_KEM_768 = 4;

    mapping(address account => KeyRecord) private _keys;

    event EncryptionKeyRegistered(address indexed account, bytes32 indexed keyId, uint16 keyType);
    event EncryptionKeyRevoked(address indexed account);

    error EmptyKey();

    function setEncryptionKey(uint16 keyType, bytes calldata publicKey) external {
        if (publicKey.length == 0) revert EmptyKey();
        _keys[msg.sender] = KeyRecord({keyType: keyType, updatedAt: uint64(block.timestamp), publicKey: publicKey});
        emit EncryptionKeyRegistered(msg.sender, keccak256(publicKey), keyType);
    }

    /// @notice Withdraw your key. Any sealed transfer to you will revert until you publish a
    ///         new one, which is the correct failure mode: better to block the sale than to
    ///         complete one that hands over ciphertext nobody can open.
    function revokeEncryptionKey() external {
        delete _keys[msg.sender];
        emit EncryptionKeyRevoked(msg.sender);
    }

    function keyOf(address account) external view returns (KeyRecord memory) {
        return _keys[account];
    }

    function publicKeyOf(address account) external view returns (bytes memory) {
        return _keys[account].publicKey;
    }

    /// @notice keccak256 of the published key, or zero if none. This is the value bound into
    ///         a {ReKeyRequest}, so the proof commits to exactly which key was sealed to.
    function keyIdOf(address account) external view returns (bytes32) {
        bytes memory k = _keys[account].publicKey;
        return k.length == 0 ? bytes32(0) : keccak256(k);
    }
}
