# Privacy architecture and omnichain roadmap

**Research date:** 2026-09-03. **Status:** implemented transport confidentiality plus a
design roadmap; not a claim that public EVM execution is private.

## Executive conclusion

There is no Solidity modifier, LayerZero option, or single “privacy omnichain” standard that
makes an application private. Solidity's `private` visibility only restricts calls from other
contracts; node operators can still read bytecode, calldata, storage and logs. LayerZero moves
authenticated bytes between chains, but both transactions remain observable. Encryption protects
content, not sender, recipient, timing, fee, size, or access pattern.

ANIMA should split privacy into independently testable properties:

1. **Content confidentiality:** ciphertext off-chain; only commitments and retrieval pointers
   on-chain. This repository does this for brains and messages.
2. **Key correctness and forward secrecy:** pin the exact recipient key, rotate content keys,
   and advance epochs. The private messaging API closes the original key-rotation race.
3. **Private computation:** run secret-dependent logic in a TEE, FHE network, or ZK/private
   execution environment and return a proof or attestation. Ordinary Base execution cannot do it.
4. **Metadata privacy:** use relayers, one-time addresses and batching where appropriate.
5. **Cross-chain privacy:** encrypt before transport and authenticate both the route and the
   confidential-compute result. “Omnichain” does not mean “confidential.”

## Whole-project privacy review

The review covered every deployable contract, interface and library, plus deployment scripts,
SDK, CLI, UI and tests. Privacy-relevant flows are:

| Area | Public data | Protection | Remaining limitation |
|---|---|---|---|
| Brain shards | URI, size, kind, description, commitments and timing | encrypted bytes stay off-chain; epoch/root bind integrity; verified transfer can certify re-keying | descriptions and access patterns leak; a former reader cannot be made to forget |
| Encryption keys | key, scheme, owner and rotation time | explicit scheme id and commitment prevent treating an EVM address as an encryption key | ownership is visible; rotation cannot revoke plaintext already read |
| Messages | sender/recipient, postage, deadlines, thread tag, URI and commitment | payload is intended to ride encrypted over XMTP/Waku/HTTPS | legacy `send` cannot prove encryption; routing metadata remains public |
| Inference/work | parties, amounts, request/response hashes and attestations | plaintext may stay off-chain; bilateral commitments prevent substitution | low-entropy values can be guessed from an unsalted hash |
| Account actions | target, value, selector and data hash | append-only audit root prevents history deletion | calldata and asset movement are public; a hash is not secrecy for guessable data |
| Market/bond/reputation | ownership, prices, jobs, balances, scores and timing | integrity and accountability are intentionally public | hiding them conflicts with public solvency checks unless proven in ZK |
| Omnichain mirror | receiver, id, roots, seal, model commitment and URI | home escrow preserves accountability; OApp authenticates peer/origin | packet and route are public; plaintext and keys do not travel |
| Handles/roles | identifiers are hashed in storage but values appear in calldata | uniqueness and verifier attribution | hashes do not anonymize email/phone dictionaries; secret handles need salted commitments or ZK membership |

The core choice is correct: **commit to private data; do not store it on-chain**. A bare
`keccak256(secret)` is not hiding when the secret has low entropy. Commitments to prompts,
handles, answers and capabilities need a random nonce kept inside the encrypted envelope.

## Implemented private functions

`AgentComms.sendPrivate` resolves the NFT's current owner, requires a registered encryption key,
atomically checks the exact key id used by the sender, and records it. A missing or mempool-rotated
key makes the send fail instead of recording undecryptable ciphertext. `replyPrivate` applies the
same rule to the original sender. Separate mappings preserve the original `Message` ABI; zero
means the legacy, non-enforcing path was used.

The SDK's `privateEnvelopeHash` binds randomized ciphertext to the chain, comms deployment,
sender, recipient agent and recipient key. It intentionally does **not** implement encryption.
Applications must use an audited HPKE/ECIES/KEM implementation matching the registry key type;
home-grown cryptography would make the project look private while weakening it.

## Private-compute options

These technologies solve different problems and must not become one checkbox.

### Confidential EVM / TEE

[Oasis Sapphire](https://docs.oasis.io/build/sapphire/) provides confidential EVM state and
execution using trusted hardware. It is the lowest-friction option for private policy, inference
authorization or sealed auctions. The trust boundary includes hardware, attestation, key manager
and bridge. ANIMA already has `SealedTEE` and runtime measurements, so an executor attestation
must bind `(home chain, token, agent id, brain epoch, request commitment, result commitment)`.

**Fit:** prompts, API credentials and private policy evaluation. **Keep on home:** canonical
ownership, bond and slashability, which must remain publicly verifiable.

### Fully homomorphic encryption

[Zama Protocol](https://docs.zama.org/protocol) and [Inco](https://docs.inco.org/home) expose
encrypted values contracts can compute over without decrypting. FHE suits hidden scores, sealed
bids and quota checks, but adds specialized types, asynchronous authorization/decryption and new
relayer or coprocessor assumptions. It is not a drop-in replacement for every `uint256`.

**Fit:** narrow comparisons/arithmetic. **Poor fit:** model state, arbitrary inference,
high-frequency wallet execution, or cross-chain ownership.

### Zero-knowledge private execution

[Aztec](https://docs.aztec.network/) is a private smart-contract environment; proof systems can
also act as a coprocessor while ownership stays on Base. ZK offers stronger verification than a
trusted executor, but circuits define the computation and key recovery/data availability remain
application problems. `SealedZK` should only be set when a verifier binds the precise old/new
roots, epoch, recipient key and domain—not a generic “valid computation” proof.

**Fit:** policy compliance, membership, ranges and state transitions. **Poor fit today:**
unconstrained general-purpose LLM inference.

### Threshold access and anonymous identity

Threshold networks can release or transform a content key after an on-chain condition, matching
`SealPolicy.Threshold`. They do not stop committee collusion, hide metadata, prove inference, or
erase a released key. Membership, threshold, liveness, slashing and finality must be versioned.

[Semaphore](https://docs.semaphore.pse.dev/) proves group membership with unlinkable nullifiers;
[ERC-5564](https://eips.ethereum.org/EIPS/eip-5564) defines stealth-address announcements. These
can hide a client or rotate recipients, but ANIMA's public accountability means anonymity should
be optional and transaction-specific. A stealth address needs private funding/relaying or its
first gas payment re-links it.

## Omnichain design

Keep the existing home-and-mirror model. A confidential sidechain/coprocessor is a **service
chain**, never a second canonical owner:

```text
Base/home: commit request + epoch + executor policy
    -> authenticated route carrying ciphertext/commitment
Confidential executor: check route/key/nonce/expiry, compute, attest result
    -> authenticated response carrying result commitment + proof
Base/home verifier: check origin/replay/epoch/proof, apply minimal public transition
```

The packet must bind both chain ids and contracts, token id, brain epoch, operation, nonce,
expiry, key id and ciphertext hash. The response binds its request and exact authorized public
transition. A LayerZero DVN quorum authenticates delivery; it does not attest confidential
execution. Those claims need independent verifiers.

Do not add raw ciphertext, sealed keys or secret policy values to `AgentSnapshot`. It is public
replication metadata. Private state remains content-addressed and encrypted; destination access
is a new key grant or verified re-encryption.

## Delivery plan

1. **Implemented:** key-pinned private send/reply and randomized domain-separated commitments.
2. Define a versioned HPKE envelope (suite, ephemeral key, nonce, associated data, ciphertext),
   known-answer vectors, maximum sizes and fetch-before-decrypt commitment checks.
3. Add versioned salted commitments to inference receipts and optional private handles; never
   silently change existing hash formats.
4. Pilot one confidential executor for private policy evaluation, not custody. Enforce caps,
   nonces, expiry, epoch binding and explicit timeout/cancellation behavior.
5. Only after audit, permit verified confidential results to authorize bounded account actions.
6. Cross-chain, combine current OApp peer/rate limits with a distinct proof verifier and replay
   store. Test reorgs, delayed/duplicate packets, in-flight key rotation, executor upgrade and
   unavailable key committees.

## Non-negotiable claims

- Never call a Solidity `private` variable confidential.
- Never call a hash of guessable data private without a secret random nonce.
- Never claim encryption hides transaction metadata or makes a former owner forget.
- Never equate bridge authentication with confidential-compute attestation.
- Never log plaintext, keys, prompts, responses, API credentials, salts or envelope nonces.
- Never advertise `SealedTEE`, `SealedZK` or `Threshold` from configuration alone; certify the
  specific transition.

## Primary references

- [Solidity visibility](https://docs.soliditylang.org/en/latest/contracts.html#visibility-and-getters)
- [ERC-7857 Intelligent NFTs](https://eips.ethereum.org/EIPS/eip-7857)
- [LayerZero V2](https://docs.layerzero.network/v2)
- [Oasis Sapphire](https://docs.oasis.io/build/sapphire/)
- [Zama Protocol](https://docs.zama.org/protocol)
- [Inco](https://docs.inco.org/home)
- [Aztec](https://docs.aztec.network/)
- [Semaphore](https://docs.semaphore.pse.dev/)
- [ERC-5564 Stealth Addresses](https://eips.ethereum.org/EIPS/eip-5564)
