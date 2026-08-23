import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAddress, zeroAddress } from "viem";
import { deployProtocol, mintAgent, expectRevert, DAY } from "./helpers.js";

/**
 * The owner's levers, and the handover of the owner itself.
 *
 * These are impl-agnostic on purpose, so they run against whichever build `ANIMA_IMPL` selects.
 * That matters most for the diamond: it is immutable, and this handful of pointers is the entire
 * set of things about a deployed one that can still change. If `transferOwnership` were misrouted
 * there would be no way to fix it — and until this file existed, nothing in the suite would have
 * noticed, because the equivalence tests exercise the agent surface and never the owner's.
 */

describe("Ownership — the two-step handover", () => {
  it("does not hand over on the first step alone", async () => {
    const p = await deployProtocol();

    await p.anima.write.transferOwnership([p.bob.account.address]);

    // The whole point of two-step: naming a successor does not yet make them owner, so a typo'd
    // address is recoverable rather than terminal.
    assert.equal(getAddress(await p.anima.read.owner()), getAddress(p.deployer.account.address));
    assert.equal(getAddress(await p.anima.read.pendingOwner()), getAddress(p.bob.account.address));

    // And the nominee cannot yet use the levers.
    await expectRevert(
      p.anima.write.setModule([p.carol.account.address, true], { account: p.bob.account }),
      "OwnableUnauthorizedAccount"
    );
  });

  it("completes only when the nominee accepts, and only the nominee may", async () => {
    const p = await deployProtocol();
    await p.anima.write.transferOwnership([p.bob.account.address]);

    await expectRevert(
      p.anima.write.acceptOwnership({ account: p.carol.account }),
      "OwnableUnauthorizedAccount"
    );

    await p.anima.write.acceptOwnership({ account: p.bob.account });
    assert.equal(getAddress(await p.anima.read.owner()), getAddress(p.bob.account.address));
    assert.equal(await p.anima.read.pendingOwner(), zeroAddress);

    // The new owner's levers work, and the old owner's do not.
    await p.anima.write.setModule([p.carol.account.address, true], { account: p.bob.account });
    assert.equal(await p.anima.read.isModule([p.carol.account.address]), true);
    await expectRevert(
      p.anima.write.setModule([p.carol.account.address, false]),
      "OwnableUnauthorizedAccount"
    );
  });

  it("lets the owner retract a nomination by naming someone else, or nobody", async () => {
    const p = await deployProtocol();
    await p.anima.write.transferOwnership([p.bob.account.address]);
    await p.anima.write.transferOwnership([p.carol.account.address]);

    await expectRevert(
      p.anima.write.acceptOwnership({ account: p.bob.account }),
      "OwnableUnauthorizedAccount"
    );

    await p.anima.write.transferOwnership([zeroAddress]);
    assert.equal(await p.anima.read.pendingOwner(), zeroAddress);
    await expectRevert(
      p.anima.write.acceptOwnership({ account: p.carol.account }),
      "OwnableUnauthorizedAccount"
    );
    assert.equal(getAddress(await p.anima.read.owner()), getAddress(p.deployer.account.address));
  });

  it("renounces to nobody, permanently, and clears any pending nomination with it", async () => {
    const p = await deployProtocol();
    await p.anima.write.transferOwnership([p.bob.account.address]);

    await p.anima.write.renounceOwnership();
    assert.equal(await p.anima.read.owner(), zeroAddress);
    assert.equal(await p.anima.read.pendingOwner(), zeroAddress);

    // Nobody can pick it up afterwards — including the address that was mid-handover.
    await expectRevert(
      p.anima.write.acceptOwnership({ account: p.bob.account }),
      "OwnableUnauthorizedAccount"
    );
    await expectRevert(
      p.anima.write.setModule([p.bob.account.address, true], { account: p.bob.account }),
      "OwnableUnauthorizedAccount"
    );

    // Agents keep working. Renouncing gives up the pointers, not the token.
    const id = await mintAgent(p, p.alice.account.address);
    await p.anima.write.setGuardian([id, p.guardian.account.address], { account: p.alice.account });
    assert.equal(getAddress(await p.anima.read.guardianOf([id])), getAddress(p.guardian.account.address));
  });
});

describe("Ownership — the levers themselves", () => {
  it("swaps the re-key verifier, and refuses a zero one", async () => {
    const p = await deployProtocol();
    assert.equal(getAddress(await p.anima.read.verifier()), getAddress(p.nullVerifier.address));

    const replacement = await p.viem.deployContract("NullTransferVerifier");
    await p.anima.write.setVerifier([replacement.address]);
    assert.equal(getAddress(await p.anima.read.verifier()), getAddress(replacement.address));

    await expectRevert(p.anima.write.setVerifier([zeroAddress]), "ZeroAddress");
    await expectRevert(
      p.anima.write.setVerifier([replacement.address], { account: p.bob.account }),
      "OwnableUnauthorizedAccount"
    );
  });

  it("adds and removes modules, which is the allowlist that can lock an agent", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);

    // Not on the allowlist: cannot lock.
    await expectRevert(p.anima.write.lockAgent([id], { account: p.bob.account }), "NotModule");

    await p.anima.write.setModule([p.bob.account.address, true]);
    assert.equal(await p.anima.read.isModule([p.bob.account.address]), true);
    await p.anima.write.lockAgent([id], { account: p.bob.account });
    assert.equal(await p.anima.read.locked([id]), true);

    // Removal is immediate, and does not retroactively unlock what is already locked — an agent
    // mid-job stays held even if the module that holds it is delisted.
    await p.anima.write.setModule([p.bob.account.address, false]);
    assert.equal(await p.anima.read.isModule([p.bob.account.address]), false);
    assert.equal(await p.anima.read.locked([id]), true);
    await expectRevert(p.anima.write.unlockAgent([id], { account: p.bob.account }), "NotModule");
  });

  it("sets the collection royalty and a per-token override", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);

    // The fixture declares 5% to the treasury.
    let [receiver, amount] = await p.anima.read.royaltyInfo([id, 10_000n]);
    assert.equal(getAddress(receiver), getAddress(p.treasury.account.address));
    assert.equal(amount, 500n);

    await p.anima.write.setDefaultRoyalty([p.carol.account.address, 250n]);
    [receiver, amount] = await p.anima.read.royaltyInfo([id, 10_000n]);
    assert.equal(getAddress(receiver), getAddress(p.carol.account.address));
    assert.equal(amount, 250n);

    await p.anima.write.setTokenRoyalty([id, p.bob.account.address, 1_000n]);
    [receiver, amount] = await p.anima.read.royaltyInfo([id, 10_000n]);
    assert.equal(getAddress(receiver), getAddress(p.bob.account.address));
    assert.equal(amount, 1_000n);

    // A second agent still sees the collection default, not the override.
    const other = await mintAgent(p, p.alice.account.address);
    [receiver] = await p.anima.read.royaltyInfo([other, 10_000n]);
    assert.equal(getAddress(receiver), getAddress(p.carol.account.address));

    await expectRevert(
      p.anima.write.setDefaultRoyalty([p.bob.account.address, 100n], { account: p.bob.account }),
      "OwnableUnauthorizedAccount"
    );
  });

  it("publishes ERC-7572 collection metadata", async () => {
    const p = await deployProtocol();
    assert.equal(await p.anima.read.contractURI(), "");

    await p.anima.write.setContractURI(["ipfs://collection.json"]);
    assert.equal(await p.anima.read.contractURI(), "ipfs://collection.json");

    await expectRevert(
      p.anima.write.setContractURI(["ipfs://hijacked"], { account: p.bob.account }),
      "OwnableUnauthorizedAccount"
    );
  });

  it("keeps the pinned ERC-6551 configuration out of the owner's reach", async () => {
    const p = await deployProtocol();

    // These four are the token's identity: change any of them and every agent's wallet address
    // moves. There is deliberately no setter on either build — the monolith holds them as
    // `immutable`, the diamond as per-facet immutables checked equal at construction.
    const surface = p.anima.abi
      .filter((e: { type: string }) => e.type === "function")
      .map((e: { name: string }) => e.name);
    for (const forbidden of ["setRegistry", "setAccountImplementation", "setAccountSalt", "setKeyRegistry"]) {
      assert.ok(!surface.includes(forbidden), `${forbidden} must not exist on the token`);
    }

    assert.notEqual(await p.anima.read.REGISTRY(), zeroAddress);
    assert.notEqual(await p.anima.read.KEY_REGISTRY(), zeroAddress);
    assert.notEqual(await p.anima.read.ACCOUNT_IMPLEMENTATION(), zeroAddress);
  });
});

describe("Ownership — reads the equivalence suite never touched", () => {
  it("reports approval epochs and expiries for accounts that have none", async () => {
    const p = await deployProtocol();
    assert.equal(await p.anima.read.approvalEpoch([p.alice.account.address]), 0n);
    assert.equal(await p.anima.read.approvalExpiryOf([p.alice.account.address, p.bob.account.address]), 0n);

    const until = BigInt(await p.networkHelpers.time.latest()) + 30n * DAY;
    await p.anima.write.setApprovalForAllUntil([p.bob.account.address, until], { account: p.alice.account });
    assert.equal(await p.anima.read.approvalExpiryOf([p.alice.account.address, p.bob.account.address]), until);

    await p.anima.write.revokeAllApprovals({ account: p.alice.account });
    assert.equal(await p.anima.read.approvalEpoch([p.alice.account.address]), 1n);
    // The old key is orphaned rather than cleared, which is what makes revoke-all O(1).
    assert.equal(await p.anima.read.approvalExpiryOf([p.alice.account.address, p.bob.account.address]), 0n);
    assert.equal(await p.anima.read.isApprovedForAll([p.alice.account.address, p.bob.account.address]), false);
  });

  it("counts wallet-binding nonces from zero and advances them on use", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);
    assert.equal(await p.anima.read.walletNonce([id]), 0n);
    assert.equal(await p.anima.read.totalMinted(), id);
  });
});
