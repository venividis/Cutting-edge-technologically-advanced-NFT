import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toHex, zeroAddress, getAddress } from "viem";
import {
  deployProtocol,
  mintAgent,
  shard,
  brainRoot,
  expectRevert,
  SealPolicy,
  AgentStatus,
  ACCOUNT_SALT,
  ZERO32,
} from "./helpers.js";

describe("AnimaAgent — identity and manifest", () => {
  it("mints an agent whose id is both the ERC-721 tokenId and the ERC-8004 agentId", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address, { manifest: "card-v1" });

    assert.equal(id, 1n);
    assert.equal(getAddress(await p.anima.read.ownerOf([id])), getAddress(p.alice.account.address));
    assert.equal(await p.anima.read.statusOf([id]), AgentStatus.Inactive);
  });

  it("commits to the manifest so a swapped card is detectable", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address, { manifest: "card-v1" });

    assert.equal(await p.anima.read.verifyManifest([id, toHex("card-v1")]), true);
    assert.equal(await p.anima.read.verifyManifest([id, toHex("card-v2")]), false);
  });

  it("treats a URI set without a hash as uncommitted rather than leaving a stale hash", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address, { manifest: "card-v1" });

    // The ERC-8004 shim sets only the URI. A stale hash would falsely validate old bytes.
    await p.anima.write.setAgentURI([id, "https://evil.example/card.json"], { account: p.alice.account });

    const [, manifestHash] = await p.anima.read.manifestOf([id]);
    assert.equal(manifestHash, ZERO32);
    assert.equal(await p.anima.read.verifyManifest([id, toHex("card-v1")]), false);
  });

  it("supports the ERC-8004 register() overloads", async () => {
    const p = await deployProtocol();
    await p.anima.write.register(["https://a.example"], { account: p.bob.account });
    const id = await p.anima.read.totalMinted();
    assert.equal(getAddress(await p.anima.read.ownerOf([id])), getAddress(p.bob.account.address));
    assert.equal(await p.anima.read.tokenURI([id]), "https://a.example");
  });

  it("advertises every interface it implements", async () => {
    const p = await deployProtocol();
    const ids: [string, `0x${string}`][] = [
      ["ERC-165", "0x01ffc9a7"],
      ["ERC-721", "0x80ac58cd"],
      ["ERC-721Metadata", "0x5b5e139f"],
      ["ERC-2981", "0x2a55205a"],
      ["ERC-4906", "0x49064906"],
      ["ERC-4907", "0xad092b5c"],
      ["ERC-5192", "0xb45a3c0e"],
      ["ERC-6454", "0x91a6262f"],
      ["ERC-7572", "0xe8a3d485"],
    ];
    for (const [name, iid] of ids) {
      assert.equal(await p.anima.read.supportsInterface([iid]), true, `${name} (${iid}) not advertised`);
    }
  });
});

describe("AnimaAgent — the brain", () => {
  it("computes a commitment an off-chain indexer can reproduce", async () => {
    const p = await deployProtocol();
    const shards = [shard("memory", "hello"), shard("prompt", "you are helpful", 2)];
    const id = await mintAgent(p, p.alice.account.address, { shards });

    assert.equal(await p.anima.read.brainRoot([id]), brainRoot(shards));
    assert.equal(await p.anima.read.brainEpoch([id]), 1n);
  });

  it("is order-sensitive, so reordering shards is a real state change", async () => {
    const p = await deployProtocol();
    const a = shard("memory", "hello");
    const b = shard("prompt", "you are helpful", 2);
    assert.notEqual(brainRoot([a, b]), brainRoot([b, a]));
  });

  it("rejects a concurrent update against a stale epoch instead of clobbering it", async () => {
    const p = await deployProtocol();
    const shards = [shard("memory", "v1")];
    const id = await mintAgent(p, p.alice.account.address, { shards });

    await p.anima.write.updateBrain([id, [shard("memory", "v2")], 1n], { account: p.alice.account });
    assert.equal(await p.anima.read.brainEpoch([id]), 2n);

    // A second writer still holding epoch 1 must fail loudly, not silently overwrite v2.
    await expectRevert(
      p.anima.write.updateBrain([id, [shard("memory", "v3")], 1n], { account: p.alice.account }),
      "BrainEpochMismatch"
    );
  });

  it("truncates when the new shard set is shorter", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address, {
      shards: [shard("a", "1"), shard("b", "2"), shard("c", "3")],
    });
    const next = [shard("a", "9")];
    await p.anima.write.updateBrain([id, next, 1n], { account: p.alice.account });

    const stored = await p.anima.read.brainOf([id]);
    assert.equal(stored.length, 1);
    assert.equal(await p.anima.read.brainRoot([id]), brainRoot(next));
  });

  it("lets an owner weaken a seal claim but never strengthen it", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address, {
      shards: [shard("m", "x")],
      seal: SealPolicy.SealedTEE,
    });

    await p.anima.write.downgradeSealPolicy([id, SealPolicy.Committed], { account: p.alice.account });
    assert.equal(await p.anima.read.sealPolicyOf([id]), SealPolicy.Committed);

    // Upgrading would be an unearned claim: only a verifier that certified a re-key may do it.
    await expectRevert(
      p.anima.write.downgradeSealPolicy([id, SealPolicy.SealedZK], { account: p.alice.account }),
      "SealPolicyNotUpgradable"
    );
  });
});

describe("AnimaAgent — sealed transfer", () => {
  it("refuses to seal to a recipient who has published no encryption key", async () => {
    const p = await deployProtocol();
    const shards = [shard("memory", "secret")];
    const id = await mintAgent(p, p.alice.account.address, { shards, seal: SealPolicy.SealedTEE });

    await expectRevert(
      p.anima.write.transferWithBrain(
        [p.alice.account.address, p.bob.account.address, id, [shard("memory", "resealed")], ["0xdead"], "0x"],
        { account: p.alice.account }
      ),
      "NoEncryptionKey"
    );
  });

  it("re-keys and transfers atomically, advancing the epoch", async () => {
    const p = await deployProtocol();
    const shards = [shard("memory", "secret")];
    const id = await mintAgent(p, p.alice.account.address, { shards, seal: SealPolicy.SealedTEE });

    await p.keyRegistry.write.setEncryptionKey([1, toHex("bob-x25519-pubkey")], { account: p.bob.account });

    const resealed = [shard("memory", "resealed")];
    await p.anima.write.transferWithBrain(
      [p.alice.account.address, p.bob.account.address, id, resealed, ["0xbeef"], "0x"],
      { account: p.alice.account }
    );

    assert.equal(getAddress(await p.anima.read.ownerOf([id])), getAddress(p.bob.account.address));
    assert.equal(await p.anima.read.brainRoot([id]), brainRoot(resealed));
    assert.equal(await p.anima.read.brainEpoch([id]), 2n);
    // The null verifier can only certify Committed, so the recorded seal drops to the truth.
    assert.equal(await p.anima.read.sealPolicyOf([id]), SealPolicy.Committed);
  });
});

describe("AnimaAgent — autonomy does not survive a sale", () => {
  it("clears operators, guardian, policy, lease and wallet, and pauses on transfer", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);

    await p.anima.write.setOperator([id, p.carol.account.address, true], { account: p.alice.account });
    await p.anima.write.setGuardian([id, p.guardian.account.address], { account: p.alice.account });
    await p.anima.write.setUser([id, p.carol.account.address, 2n ** 63n], { account: p.alice.account });
    await p.anima.write.setPolicy(
      [
        id,
        {
          perTxWei: 10n ** 18n,
          dailyWei: 10n ** 19n,
          expiry: 0n,
          allowDelegateCall: false,
          allowUnlistedTargets: true,
          targetsRoot: ZERO32,
        },
      ],
      { account: p.alice.account }
    );
    await p.anima.write.setStatus([id, AgentStatus.Active], { account: p.alice.account });

    assert.equal(await p.anima.read.isOperator([id, p.carol.account.address]), true);

    await p.anima.write.transferFrom([p.alice.account.address, p.bob.account.address, id], {
      account: p.alice.account,
    });

    // The seller's staff must not retain control of the buyer's agent.
    assert.equal(await p.anima.read.isOperator([id, p.carol.account.address]), false);
    assert.equal(getAddress(await p.anima.read.guardianOf([id])), getAddress(zeroAddress));
    assert.equal(getAddress(await p.anima.read.userOf([id])), getAddress(zeroAddress));
    assert.equal(await p.anima.read.statusOf([id]), AgentStatus.Paused);

    const policy = await p.anima.read.policyOf([id]);
    assert.equal(policy.perTxWei, 0n);
    assert.equal(policy.allowUnlistedTargets, false);
  });
});

describe("AnimaAgent — locking", () => {
  it("reports lock state through both ERC-5192 and ERC-6454, and enforces it on transfer", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);

    assert.equal(await p.anima.read.locked([id]), false);
    assert.equal(
      await p.anima.read.isTransferable([id, p.alice.account.address, p.bob.account.address]),
      true
    );

    // Impersonate a registered module to lock the agent, as an escrow would.
    await p.anima.write.setModule([p.deployer.account.address, true]);
    await p.anima.write.lockAgent([id]);

    assert.equal(await p.anima.read.locked([id]), true);
    assert.equal(
      await p.anima.read.isTransferable([id, p.alice.account.address, p.bob.account.address]),
      false
    );
    // Descriptive views are not enough; the transfer path itself must refuse.
    await expectRevert(
      p.anima.write.transferFrom([p.alice.account.address, p.bob.account.address, id], {
        account: p.alice.account,
      }),
      "AgentLocked"
    );

    await p.anima.write.unlockAgent([id]);
    await p.anima.write.transferFrom([p.alice.account.address, p.bob.account.address, id], {
      account: p.alice.account,
    });
    assert.equal(getAddress(await p.anima.read.ownerOf([id])), getAddress(p.bob.account.address));
  });

  it("blocks burning a locked agent too, not just transferring it", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);
    await p.anima.write.setModule([p.deployer.account.address, true]);
    await p.anima.write.lockAgent([id]);

    await expectRevert(
      p.anima.write.transferFrom([p.alice.account.address, zeroAddress, id], { account: p.alice.account })
    );
  });
});

describe("AnimaAgent — guardian", () => {
  it("lets a guardian pause but never unpause, transfer, or reconfigure", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);
    await p.anima.write.setGuardian([id, p.guardian.account.address], { account: p.alice.account });
    await p.anima.write.setStatus([id, AgentStatus.Active], { account: p.alice.account });

    await p.anima.write.guardianPause([id], { account: p.guardian.account });
    assert.equal(await p.anima.read.statusOf([id]), AgentStatus.Paused);

    // A kill switch that can also restart or steal is not a safety feature.
    await expectRevert(
      p.anima.write.setStatus([id, AgentStatus.Active], { account: p.guardian.account }),
      "NotAgentController"
    );
    await expectRevert(
      p.anima.write.setOperator([id, p.guardian.account.address, true], { account: p.guardian.account }),
      "NotOwnerOf"
    );
  });

  it("rejects a guardianPause from anyone who is not the guardian", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);
    await expectRevert(p.anima.write.guardianPause([id], { account: p.bob.account }), "NotGuardian");
  });
});

describe("AnimaAgent — token bound account", () => {
  it("derives the same account address before and after deployment", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);

    const predicted = await p.anima.read.accountOf([id]);
    const chainId = await p.publicClient.getChainId();
    const fromRegistry = await p.registry.read.account([
      p.accountImpl.address,
      ACCOUNT_SALT,
      BigInt(chainId),
      p.anima.address,
      id,
    ]);
    assert.equal(getAddress(predicted), getAddress(fromRegistry));

    await p.anima.write.deployAccount([id]);
    assert.equal(getAddress(await p.anima.read.accountOf([id])), getAddress(predicted));
    assert.notEqual(await p.publicClient.getCode({ address: predicted }), undefined);
  });

  it("requires the wallet's own signature to bind it, blocking standing-borrowing", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

    // An unsigned claim on someone else's address must fail.
    await expectRevert(
      p.anima.write.setAgentWallet([id, p.carol.account.address, deadline, "0x"], {
        account: p.alice.account,
      }),
      "InvalidSignature"
    );

    const nonce = await p.anima.read.walletNonce([id]);
    const signature = await p.carol.signTypedData({
      domain: {
        name: "AnimaAgent",
        version: "1",
        chainId: await p.publicClient.getChainId(),
        verifyingContract: p.anima.address,
      },
      types: {
        AgentWalletBinding: [
          { name: "agentId", type: "uint256" },
          { name: "wallet", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      primaryType: "AgentWalletBinding",
      message: { agentId: id, wallet: p.carol.account.address, nonce, deadline },
    });

    await p.anima.write.setAgentWallet([id, p.carol.account.address, deadline, signature], {
      account: p.alice.account,
    });
    assert.equal(getAddress(await p.anima.read.getAgentWallet([id])), getAddress(p.carol.account.address));
  });

  it("defaults the ERC-8004 agent wallet to the token bound account", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);
    assert.equal(
      getAddress(await p.anima.read.getAgentWallet([id])),
      getAddress(await p.anima.read.accountOf([id]))
    );
  });
});
