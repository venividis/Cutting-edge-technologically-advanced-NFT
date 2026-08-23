import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAddress, zeroAddress } from "viem";
import { deployProtocol, expectRevert } from "./helpers.js";
import { deployDiamond } from "../scripts/deploy-diamond.js";
import { DIAMOND_CUT_SELECTOR } from "../sdk/src/index.js";

/**
 * The deployment script, run.
 *
 * An immutable diamond's routing table is decided once and never again, which makes the script
 * that decides it the highest-leverage code in the repo — and until this file existed it was the
 * only part of the diamond path with no test at all, while `docs/DEPLOYMENT.md` told operators to
 * follow it. A worked example nobody executes is a worked example that rots.
 *
 * So the suite runs the real `deployDiamond`, including its own on-chain verification pass, and
 * then confirms the result is a token rather than merely an address.
 */
describe("scripts/deploy-diamond — the deployment an operator actually runs", () => {
  it("produces a verified, immutable, initialised token", async () => {
    // Borrow a fixture only for the prerequisites the script takes as given.
    const p = await deployProtocol();

    const result = await deployDiamond(
      {
        name: "ANIMA Agents",
        symbol: "ANIMA",
        owner: p.deployer.account.address,
        registry: p.registry.address,
        accountImplementation: p.accountImpl.address,
        keyRegistry: p.keyRegistry.address,
        verifier: p.nullVerifier.address,
        royaltyReceiver: p.treasury.account.address,
        royaltyBps: 500n,
      },
      p.connection
    );

    // The script throws on any verification failure, so reaching here means all of its checks
    // passed. What is left is to confirm the thing it returned behaves like the token.
    const token = await p.viem.getContractAt("AnimaAgent", result.token);
    const loupe = await p.viem.getContractAt("AnimaLoupeFacet", result.token);

    assert.equal(await token.read.name(), "ANIMA Agents");
    assert.equal(getAddress(await token.read.owner()), getAddress(p.deployer.account.address));
    assert.equal(await loupe.read.facetAddress([DIAMOND_CUT_SELECTOR]), zeroAddress);
    assert.equal((await loupe.read.facetAddresses()).length, 4);

    // It mints, and it mints one-based — the check that catches an uninitialised diamond.
    const hash = await token.write.mintAgent([
      p.alice.account.address,
      "https://agents.example/1.json",
      `0x${"00".repeat(32)}`,
      { weightsRoot: `0x${"00".repeat(32)}`, runtimeMeasurement: `0x${"00".repeat(32)}`, attestationKind: 0, modelId: "" },
      [],
      0,
      [],
    ]);
    await p.publicClient.waitForTransactionReceipt({ hash });
    assert.equal(await token.read.totalMinted(), 1n);
    assert.equal(getAddress(await token.read.ownerOf([1n])), getAddress(p.alice.account.address));

    // And the owner's levers reach it, which is the one thing about it that can still change.
    await token.write.setModule([p.escrow.address, true]);
    assert.equal(await token.read.isModule([p.escrow.address]), true);
  });

  it("refuses a configuration with a zero address rather than deploying it", async () => {
    const p = await deployProtocol();
    await expectRevert(
      deployDiamond(
        {
          name: "Broken",
          symbol: "BRK",
          owner: p.deployer.account.address,
          registry: zeroAddress,
          accountImplementation: p.accountImpl.address,
          keyRegistry: p.keyRegistry.address,
          verifier: p.nullVerifier.address,
          royaltyReceiver: p.treasury.account.address,
          royaltyBps: 500n,
        },
        p.connection
      ),
      "registry is the zero address"
    );
  });
});
