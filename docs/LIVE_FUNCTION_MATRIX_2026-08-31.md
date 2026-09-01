# Live Base Sepolia full-function exercise — 2026-08-31

This is transaction evidence from the deployer-scoped Base Sepolia deployment at
`0xb3d92c766e3cb356db381feb21958a9ebb974365`. It supplements, rather than replaces,
the adversarial unit suite. Test-only venues are identified as such.

## Lifecycle, accountability, work and chat

Agent #6 completed mint, manifest verification, ERC-6551 deployment, policy, guardian, activation,
bond deposit, client offer, job acceptance, lock enforcement, brain update, delivery, settlement,
attested reputation, account-funded bond top-up, priced inbox/send, ERC-4907 lease, and transfer-reset.

| Action | Transaction |
|---|---|
| Mint lifecycle agent | `0x2f555ab8d7abbdc067387291336b7f86dafdf5c420c7f1443b45974c724e7eaa` |
| Accept collateralized job | `0x92b9fd1e813664c3ad69f7ac7a3d4936ac130f3783f5c67774c80b1a3b0f8c4c` |
| Settle work and reputation | `0x139ef4380b704973fc8c50b47f69645be84c3327db8cbb234783d8f6219bb6a7` |
| Paid message send | `0x91b466a5dd16b9e4043f8503693a58f355f3f5a45a6b51542f197eaed3ae97e0` |
| Sale and authority reset | `0xf6e8a9fab0c2439837f1c7457bf28ac9e8cc36f82ea0a9d28c07071fe1318437` |

Agent #9 separately exercised a paid chat reply and authenticated broadcast:
`0x28e15b365d3d7654b0c1b3bc1829563dc3c81d53afa179a9bad12389df5cd51c` and
`0x7b66b389459c4fc1a91462f783f7195001b6f830d880d985c8ffb8bf41366b98`.

## Handles, roles and inference

Agents #7 and #8 exercised handle uniqueness, three simultaneous ERC-7432 roles, revocation,
permissionless unlock, a funded inference channel, two cumulative voucher settlements, and replay
rejection.

| Action | Transaction |
|---|---|
| Handle attestation | `0x5ced698b193479540e2a9a5edcab6fe9d087d58b381ffed03833832ef96fb1cb` |
| Final role revoke and unlock | `0x9c86151a73dc3b75c202ca0f3b472f81aa1ecf5e4361cb7d5d5818229d522d06` |
| Open inference channel | `0x8445846b1445d49d2796fc8c26f7711cef2c0537e6e0f4227dd59380e41ecc34` |
| Settle cumulative 300 aUSD | `0xc74c62816e6adb6f5703cfa0e9c78e312625dd09ee1fcee30fe39b0359b19cc3` |

## Agent-token launch and floor

Launch #1 exercised creation, curve buy, curve sell, floor redemption, direct revenue sync, the
graduation threshold, and permissionless graduation through `MockLiquidityDeployer`.

| Action | Transaction |
|---|---|
| Create launch | `0x0d8757a1533b3689ad11a072a02bb7158b33efaef4fd0ff5cc76294c16a70903` |
| Buy / sell | `0xb6bb0e03954fe8a00e2a273c7800c8776d8ef079b9292919910626616e156e35` / `0x4f95fda99a163000100989fe7ad04ff1b8f7af36c152c23efd0c5d76507c33a2` |
| Redeem floor | `0x8b26a02602464760ebe7d5d6a68bbd01b941239b92a8c51db2a4b3dd97f3e895` |
| Sync revenue | `0x81ee920f53afaab347762838a316310bbdc883bd118adcdad5995c9b72ba5884` |
| Graduate | `0x315e08c569bdb6719978f68439581321410fab3fd35b4bf9809f280e970f12cc` |

## Swap and derivatives

The swap router used live contracts with test faucet tokens and `MockVenue`; the derivatives desk
used live aUSD with `MockPerpVenue`. These transactions prove protocol integration and accounting,
not external DEX/perpetual venue behavior.

| Action | Transaction |
|---|---|
| Bounded account swap | `0x24aea6ccd82a81a60dc7d2cddbc1f0254147d7304581c567beb4be8f8ce7cb42` |
| Revoke token permission | `0x932bd9ba5d38359986e07a6fc18b816960da2211617a24362d81057a84c2ff18` |
| Open bounded perpetual | `0x805be0dc03e6e50b83815617d339fad6f7e3c71487917c3410b820990e26ba11` |
| Close perpetual | `0x52c248192db1fb8f82413f43226562f986c9acfc569caa23820640a85e9b0ff0` |
| Halt market / disable venue | `0x5088cf56feafd1c34d245ad4cee63f4ac141b61128433f67e95d59744914fdb5` / `0xf67e65857439881fd043828b27ac692a9d55806621bff62d588729cd56525e34` |

## Binding, key registry and signed market

Agent #9 published and revoked an encryption key and permanently bound its ERC-8004 identity to its
master NFT. Agent #11 was sold by a signed EIP-712 market order and then rented by its new owner.

| Action | Transaction |
|---|---|
| Publish / revoke encryption key | `0x9ee32aed9ccbd1fdf53ff49e26601f822457ea91113a15af388cb03e4e2d9d09` / `0xbd78094c09eaaeacd3ad31d474ded8009f3f83d2360750fd3299397e066d2be8` |
| Immutable binding | `0xa4e3d41b3f11228fb346ea4e798d9fe2fdb9abe98222a091fbbaae95464d5f8e` |
| Signed market fill | `0xc74a7390a3f4d07111859dc5db97b9d115ec360c8fc354686f9aff6e254be714` |
| Signed rental fill | `0x3388a56125796025efafbaccdea67fa4cf3eea29eb01fb4b2329cc015d8ce985` |

All hashes are on Base Sepolia and can be opened as
`https://sepolia.basescan.org/tx/<hash>`. Revert-path and attack-vector coverage remains in the
239-test monolith/diamond suites because failed gas estimates do not produce transaction hashes.

## Three-agent “small town” adversarial run

Three fresh, independently signed wallets minted agents #12–#14, deployed their ERC-6551 wallets,
and each deposited 500 aUSD into `BondVault`. They then configured closed inboxes, allowlisted one
another by **agent ID**, and completed a circular paid conversation with replies. This is distinct
from the earlier owner/client scenario: no resident shared a signer with another resident.

The run completed **27 successful transactions** and **12 deliberately mined reverts**. Each
resident tried to steal the next resident's NFT, rewrite its manifest, execute through its
ERC-6551 wallet, and unbond its collateral. Every hostile transaction reverted. The complete list,
including every explorer hash, is stored under `townRun.evidence` in the Base deployment record.

Representative evidence:

| Action | Transaction |
|---|---|
| Ada → Babbage authenticated message / reply | `0x51b34f70e9a0974e70aa9d6e196e99e57d7826016d6c42ea79053bbd4a7ecf63` / `0x1fcee36b5362dd1737ff1e47ad4a8b3fb666a25f6665f62b817bc2a55293d2b7` |
| Ada bond deposit | `0x60ffc1605f86da9c20bb03f58dc521974eaa9021fedd86b3cc0d9a82ff4957ad` |
| Ada's attempted theft of Babbage's NFT (reverted) | `0x77baf39093f9fc0d74b842e5b1f6cd4a71a79526c99e0d45bc6e6c5be1b85df2` |
| Babbage's attempted use of Curie's wallet (reverted) | `0x88a852c4b0a67bdea1706f19d50e5b06f7fa7c40ba84948526e657bfb58b6030` |
| Curie's attempted unbond of Ada's vault (reverted) | `0x6b70dff0bc7d628eedb0ddbd44628b16e26d555a86d4be56305ba139d7bc9cbd` |

There is no consignment contract or custody-based market listing in this repository. `AgentMarket`
uses non-custodial signed EIP-712 orders; custody occurs only in the ONFT bridge while an agent is
away from its home chain. Calling the signed market flow “consignment” would overstate what was
implemented and tested.

## Unichain packet diagnosis

The Base → Unichain transaction
`0x5462e54453301d77a78d1ad2757f0380777638a6c00358033a5780c0901e33cb` is conclusively still
in flight as of 2026-08-31. LayerZero Scan reports GUID
`0x5b2eb0ca9f9d4bdabdf66e9c9e981c6a04b19c78ca37c54c90a65d436c5452fc`, source `SUCCEEDED`,
destination `WAITING`, and **“Ready for DVNs to verify.”** The required LayerZero Labs DVN on the
Unichain path remains `WAITING`; both `configError` and `dvnConfigError` are false. It has not yet
reached executor delivery, so resending the ONFT cannot repair it and risks a duplicate journey.

The safe recovery sequence is:

1. Continue checking the original hash with `scripts/testnet-omni-status.ts`.
2. Escalate the source transaction and GUID to LayerZero because the required DVN, not ANIMA's
   receiver, is the current blocker.
3. Do not unlock home-chain custody on a wall-clock timeout: the original packet may verify later,
   which would create two live representations.
4. Before sending a *new* agent on this route, explicitly configure and verify a currently active
   DVN set on both path directions, then send a fresh low-value canary. Configuration changes are a
   prevention measure for future packets, not proof that the already-committed packet is cancelled.
