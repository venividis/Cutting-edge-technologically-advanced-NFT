# Ethereum Sepolia batch-agent exercise — 2026-09-15

The ten previously minted ANIMA agents, token IDs **14–23**, were exercised against the
diamond deployment at `0xbbd203d76eb2a2e493f458dff74b10c6659d12a3` on Ethereum Sepolia.
The run completed 32 successful state-changing transactions. Their hashes and block numbers are
recorded under `batchExercise.evidence` in `deployments/11155111.json`; the private keys used for
the run are not stored in the repository.

## Live coverage

The resumable runner assigned distinct concerns to the ten tokens and checked the combined state
after the transactions settled:

- URI, arbitrary ERC-8004 metadata, model identity, manifest commitment, brain replacement and
  optimistic-concurrency epoch;
- deterministic ERC-6551 account deployment, autonomy policy, per-agent operator, guardian,
  activation and guardian pause;
- ERC-4907 lease creation and removal;
- token approval, ordinary transfer, both safe-transfer overloads and round trips through an
  independently signed wallet;
- unbounded approval, expiry-bounded approval and epoch-wide revocation;
- EIP-712 arbitrary-wallet binding, nonce consumption and restoration of the ERC-6551 fallback;
- ERC-2981 token royalty override and the active → paused → retired lifecycle; and
- the composed sale invariant: transfer clears the guardian and lease and leaves the sold agent
  paused under its new owner.

The runner deliberately does not mutate collection ownership, global module allowlists, the
collection verifier, or collection-wide royalty/metadata settings. Those calls affect every NFT
and destructive ownership calls cannot be safely reversed. Module-only lock/dispute calls also
must be made through their deployed modules rather than impersonated by an owner. Their positive,
negative, and compositional paths remain covered by the local monolith and diamond suites.

## Reproduction

```bash
DEPLOYER_PRIVATE_KEY=<burner> \
  npm run testnet:batch-exercise -- --network sepolia
```

The script uses a recovery key outside the repository for the independent actor, checkpoints each
receipt before proceeding, tolerates a resumed run where a token is temporarily held by that
actor, and verifies read-back invariants before marking the deployment record complete.

“Every combination” is not a finite test target for a stateful protocol. The live run therefore
tests representative high-risk compositions, while the deterministic unit suites enumerate
authorization failures, stale epochs, locking, settlement, transfer reset, marketplace, account,
bridge, and module interactions for both equivalent token builds.
