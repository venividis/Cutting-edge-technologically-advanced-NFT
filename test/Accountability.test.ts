import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAddress, keccak256, toHex, encodeAbiParameters, parseAbiParameters, zeroAddress } from "viem";
import { deployProtocol, mintAgent, expectRevert, JobState, AgentStatus, DAY, ZERO32 } from "./helpers.js";

const USDC = (n: number | bigint) => BigInt(n) * 1_000_000n;

async function fundedAgent(p: Awaited<ReturnType<typeof deployProtocol>>, bond = USDC(1000)) {
  const id = await mintAgent(p, p.alice.account.address);
  await p.anima.write.deployAccount([id]);
  await p.anima.write.setStatus([id, AgentStatus.Active], { account: p.alice.account });
  if (bond > 0n) {
    await p.usdc.write.mint([p.alice.account.address, bond]);
    await p.usdc.write.approve([p.bonds.address, bond], { account: p.alice.account });
    await p.bonds.write.deposit([id, bond], { account: p.alice.account });
  }
  return id;
}

async function fundClient(p: Awaited<ReturnType<typeof deployProtocol>>, amount: bigint) {
  await p.usdc.write.mint([p.bob.account.address, amount]);
  await p.usdc.write.approve([p.escrow.address, amount], { account: p.bob.account });
}

async function offer(
  p: Awaited<ReturnType<typeof deployProtocol>>,
  id: bigint,
  amount = USDC(100),
  coverage = USDC(200),
  reviewWindow = 3600n
) {
  const now = BigInt(await p.networkHelpers.time.latest());
  await p.escrow.write.offerJob(
    [id, amount, coverage, now + 7n * DAY, reviewWindow, p.validator.account.address, keccak256(toHex("spec")), "ipfs://spec"],
    { account: p.bob.account }
  );
  return await p.escrow.read.jobOf([1n]).then(() => 1n);
}

describe("BondVault — collateral that cannot be walked away from", () => {
  it("reports coverage a client can check before hiring", async () => {
    const p = await deployProtocol();
    const id = await fundedAgent(p, USDC(500));
    assert.equal(await p.bonds.read.availableCoverage([id]), USDC(500));
    assert.equal(await p.bonds.read.slashableOf([id]), USDC(500));
  });

  it("keeps collateral slashable throughout the unbonding cooldown", async () => {
    const p = await deployProtocol();
    const id = await fundedAgent(p, USDC(500));

    await p.bonds.write.requestUnbond([id, USDC(500)], { account: p.alice.account });
    // Withdrawing must not be a way to front-run accountability.
    assert.equal(await p.bonds.read.availableCoverage([id]), 0n);
    assert.equal(await p.bonds.read.slashableOf([id]), USDC(500));

    await p.bonds.write.setArbiter([p.deployer.account.address, true]);
    await p.bonds.write.slash([id, USDC(300), p.carol.account.address, ZERO32]);
    assert.equal(await p.usdc.read.balanceOf([p.carol.account.address]), USDC(300));

    await expectRevert(p.bonds.write.withdraw([id]), "UnbondNotReady");
    await p.networkHelpers.time.increase(Number(7n * DAY) + 1);
    await p.bonds.write.withdraw([id]);
    // Only what survived the slash comes back.
    assert.equal(await p.usdc.read.balanceOf([p.alice.account.address]), USDC(200));
  });

  it("pays a queued withdrawal to whoever queued it, not to whoever buys the agent", async () => {
    const p = await deployProtocol();
    const id = await fundedAgent(p, USDC(500));
    await p.bonds.write.requestUnbond([id, USDC(500)], { account: p.alice.account });

    await p.anima.write.transferFrom([p.alice.account.address, p.bob.account.address, id], {
      account: p.alice.account,
    });

    await p.networkHelpers.time.increase(Number(7n * DAY) + 1);
    await p.bonds.write.withdraw([id]);

    assert.equal(await p.usdc.read.balanceOf([p.alice.account.address]), USDC(500));
    assert.equal(await p.usdc.read.balanceOf([p.bob.account.address]), 0n);
  });

  it("refuses to reserve more than the agent actually has free", async () => {
    const p = await deployProtocol();
    const id = await fundedAgent(p, USDC(100));
    await p.bonds.write.setModule([p.deployer.account.address, true]);
    await p.bonds.write.reserve([id, USDC(100)]);
    // One bond must never back two jobs at once.
    await expectRevert(p.bonds.write.reserve([id, 1n]), "InsufficientFree");
  });

  it("consumes free collateral before another client's reserved coverage", async () => {
    const p = await deployProtocol();
    const id = await fundedAgent(p, USDC(1000));
    await p.bonds.write.setModule([p.deployer.account.address, true]);
    await p.bonds.write.setArbiter([p.deployer.account.address, true]);

    await p.bonds.write.reserve([id, USDC(400)]); // another client's protection
    await p.bonds.write.slash([id, USDC(600), p.carol.account.address, ZERO32]);

    const bond = await p.bonds.read.bondOf([id]);
    assert.equal(bond.reserved, USDC(400), "reserved coverage must survive a slash it did not cause");
    assert.equal(bond.total, USDC(400));
  });
});

describe("WorkEscrow — hiring an agent", () => {
  it("lets a client withdraw an offer the agent never took", async () => {
    const p = await deployProtocol();
    const id = await fundedAgent(p);
    await fundClient(p, USDC(100));
    const jobId = await offer(p, id);

    await p.escrow.write.cancelOffer([jobId], { account: p.bob.account });
    assert.equal((await p.escrow.read.jobOf([jobId])).state, JobState.Cancelled);
    assert.equal(await p.usdc.read.balanceOf([p.bob.account.address]), USDC(100));
  });

  it("reserves collateral and locks the agent on acceptance", async () => {
    const p = await deployProtocol();
    const id = await fundedAgent(p);
    await fundClient(p, USDC(100));
    const jobId = await offer(p, id);

    await p.escrow.write.acceptJob([jobId], { account: p.alice.account });

    assert.equal(await p.anima.read.locked([id]), true);
    assert.equal((await p.bonds.read.bondOf([id])).reserved, USDC(200));
    // A hired agent cannot be sold out from under its client.
    await expectRevert(
      p.anima.write.transferFrom([p.alice.account.address, p.carol.account.address, id], {
        account: p.alice.account,
      }),
      "AgentLocked"
    );
  });

  it("cannot be forced to lock collateral by an offer it never wanted", async () => {
    const p = await deployProtocol();
    const id = await fundedAgent(p);
    await fundClient(p, USDC(100));
    await offer(p, id);
    // Making an offer reserves nothing: otherwise a stream of unwanted offers would pin an
    // agent's entire bond and stop it earning.
    assert.equal((await p.bonds.read.bondOf([id])).reserved, 0n);
    assert.equal(await p.anima.read.locked([id]), false);
  });

  it("pays the agent's own account and files customer-attested feedback on acceptance", async () => {
    const p = await deployProtocol();
    const id = await fundedAgent(p);
    await fundClient(p, USDC(100));
    const jobId = await offer(p, id);
    const agentAccount = await p.anima.read.accountOf([id]);

    await p.escrow.write.acceptJob([jobId], { account: p.alice.account });
    await p.escrow.write.deliver([jobId, keccak256(toHex("result")), "ipfs://result"], {
      account: p.alice.account,
    });
    await p.escrow.write.acceptDelivery([jobId, 95n, 0, "quality", "ipfs://fb", ZERO32], {
      account: p.bob.account,
    });

    // 1% protocol fee.
    assert.equal(await p.usdc.read.balanceOf([agentAccount]), USDC(99));
    assert.equal(await p.usdc.read.balanceOf([p.treasury.account.address]), USDC(1));
    assert.equal(await p.anima.read.locked([id]), false);
    assert.equal((await p.bonds.read.bondOf([id])).reserved, 0n);

    const [count, value, weight] = await p.reputation.read.getAttestedSummary([id, [], "", ""]);
    assert.equal(count, 1n);
    assert.equal(value, 9500n, "score normalised to 2 decimals");
    assert.equal(weight, USDC(100), "weighted by what was actually at stake");
  });

  it("refunds the client and takes coverage when a deadline is missed", async () => {
    const p = await deployProtocol();
    const id = await fundedAgent(p);
    await fundClient(p, USDC(100));
    const jobId = await offer(p, id);
    await p.escrow.write.acceptJob([jobId], { account: p.alice.account });

    await p.networkHelpers.time.increase(Number(8n * DAY));
    // Permissionless: the client should not need the agent's cooperation.
    await p.escrow.write.claimMissedDeadline([jobId], { account: p.carol.account });

    assert.equal(await p.usdc.read.balanceOf([p.bob.account.address]), USDC(100) + USDC(200));
    assert.equal(await p.bonds.read.slashableOf([id]), USDC(800));
    assert.equal(await p.anima.read.locked([id]), false);
  });

  it("pays the agent when the client simply never reviews", async () => {
    const p = await deployProtocol();
    const id = await fundedAgent(p);
    await fundClient(p, USDC(100));
    const jobId = await offer(p, id);
    const agentAccount = await p.anima.read.accountOf([id]);

    await p.escrow.write.acceptJob([jobId], { account: p.alice.account });
    await p.escrow.write.deliver([jobId, keccak256(toHex("r")), "ipfs://r"], { account: p.alice.account });

    await expectRevert(p.escrow.write.claimUnreviewed([jobId]), "ReviewOpen");
    await p.networkHelpers.time.increase(3601);
    // Refusing to click accept is not a free option.
    await p.escrow.write.claimUnreviewed([jobId]);
    assert.equal(await p.usdc.read.balanceOf([agentAccount]), USDC(99));
  });
});

describe("WorkEscrow — disputes", () => {
  async function disputed(p: Awaited<ReturnType<typeof deployProtocol>>) {
    const id = await fundedAgent(p);
    await fundClient(p, USDC(100));
    const jobId = await offer(p, id);
    await p.escrow.write.acceptJob([jobId], { account: p.alice.account });
    await p.escrow.write.deliver([jobId, keccak256(toHex("r")), "ipfs://r"], { account: p.alice.account });

    const contentHash = keccak256(toHex("it is wrong"));
    await p.escrow.write.dispute([jobId, contentHash, "ipfs://complaint"], { account: p.bob.account });

    // The registry key is namespaced by opener, which is what stops a third party squatting it.
    const contentCommitment = keccak256(
      encodeAbiParameters(parseAbiParameters("uint256, bytes32"), [jobId, contentHash])
    );
    const requestHash = await p.validation.read.requestKeyOf([p.escrow.address, contentCommitment]);
    return { id, jobId, requestHash, contentCommitment };
  }

  it("locks the agent into Disputed while a verdict is pending", async () => {
    const p = await deployProtocol();
    const { id } = await disputed(p);
    assert.equal(await p.anima.read.statusOf([id]), AgentStatus.Disputed);
    assert.equal(await p.anima.read.locked([id]), true);
  });

  it("pays the agent when the validator passes the work", async () => {
    const p = await deployProtocol();
    const { id, jobId, requestHash } = await disputed(p);
    const agentAccount = await p.anima.read.accountOf([id]);

    await p.validation.write.validationResponse([requestHash, 80, "ipfs://verdict", ZERO32, "quality"], {
      account: p.validator.account,
    });
    await p.escrow.write.resolveDispute([jobId]);

    assert.equal(await p.usdc.read.balanceOf([agentAccount]), USDC(99));
    assert.equal(await p.bonds.read.slashableOf([id]), USDC(1000), "a vindicated agent keeps its bond");
    assert.equal(await p.anima.read.locked([id]), false);
  });

  it("refunds the client and slashes when the validator fails the work", async () => {
    const p = await deployProtocol();
    const { id, jobId, requestHash } = await disputed(p);

    await p.validation.write.validationResponse([requestHash, 10, "ipfs://verdict", ZERO32, "quality"], {
      account: p.validator.account,
    });
    await p.escrow.write.resolveDispute([jobId]);

    assert.equal(await p.usdc.read.balanceOf([p.bob.account.address]), USDC(300));
    assert.equal(await p.bonds.read.slashableOf([id]), USDC(800));
  });

  it("returns everyone's money untouched when the validator never answers", async () => {
    const p = await deployProtocol();
    const { id, jobId } = await disputed(p);

    await expectRevert(p.escrow.write.resolveStaleDispute([jobId]), "VerdictPending");
    await p.networkHelpers.time.increase(Number(15n * DAY));
    await p.escrow.write.resolveStaleDispute([jobId]);

    // Nobody proved anything, so nobody is punished.
    assert.equal(await p.usdc.read.balanceOf([p.bob.account.address]), USDC(100));
    assert.equal(await p.bonds.read.slashableOf([id]), USDC(1000));
    assert.equal(await p.anima.read.locked([id]), false);
  });

  it("refuses a second verdict on the same request", async () => {
    const p = await deployProtocol();
    const { requestHash } = await disputed(p);
    await p.validation.write.validationResponse([requestHash, 80, "u", ZERO32, "t"], {
      account: p.validator.account,
    });
    // A validator must not be able to revise a published answer.
    await expectRevert(
      p.validation.write.validationResponse([requestHash, 10, "u", ZERO32, "t"], {
        account: p.validator.account,
      }),
      "AlreadyAnswered"
    );
  });

  it("cannot be blocked by a third party squatting the validation request key", async () => {
    const p = await deployProtocol();
    const id = await fundedAgent(p);
    await fundClient(p, USDC(100));
    const jobId = await offer(p, id);
    await p.escrow.write.acceptJob([jobId], { account: p.alice.account });
    await p.escrow.write.deliver([jobId, keccak256(toHex("junk")), ""], { account: p.alice.account });

    const contentHash = keccak256(toHex("it is wrong"));
    const contentCommitment = keccak256(
      encodeAbiParameters(parseAbiParameters("uint256, bytes32"), [jobId, contentHash])
    );

    // The agent front-runs, pre-registering the very hash the escrow is about to use. Under a
    // registry keyed purely by requestHash this would revert the dispute; repeated until the
    // review window lapsed, the agent would collect for undelivered work with its bond intact.
    await p.validation.write.validationRequestWithExpiry(
      [p.carol.account.address, id, "", contentCommitment, BigInt(await p.networkHelpers.time.latest()) + 100000n],
      { account: p.alice.account }
    );

    await p.escrow.write.dispute([jobId, contentHash, "ipfs://complaint"], { account: p.bob.account });
    assert.equal(await p.anima.read.statusOf([id]), AgentStatus.Disputed);
  });

  it("refuses a verdict from anyone but the named validator", async () => {
    const p = await deployProtocol();
    const { requestHash } = await disputed(p);
    await expectRevert(
      p.validation.write.validationResponse([requestHash, 100, "u", ZERO32, "t"], {
        account: p.alice.account,
      }),
      "NotTheValidator"
    );
  });
});

describe("ReputationRegistry — separating claims from evidence", () => {
  it("distinguishes open feedback from customer-attested feedback", async () => {
    const p = await deployProtocol();
    const id = await fundedAgent(p);

    // Anyone can say anything — that is ERC-8004 working as designed.
    await p.reputation.write.giveFeedback([id, 100n, 0, "quality", "", "", "", ZERO32], {
      account: p.carol.account,
    });

    const [openCount] = await p.reputation.read.getSummary([id, [], "", ""]);
    const [attestedCount] = await p.reputation.read.getAttestedSummary([id, [], "", ""]);
    assert.equal(openCount, 1n);
    assert.equal(attestedCount, 0n, "unpaid praise must not count as evidence");
  });

  it("weights attested scores by the value actually settled", async () => {
    const p = await deployProtocol();
    const id = await fundedAgent(p, USDC(5000));

    for (const [amount, rating] of [
      [USDC(10), 100n],
      [USDC(1000), 50n],
    ] as const) {
      await p.usdc.write.mint([p.bob.account.address, amount]);
      await p.usdc.write.approve([p.escrow.address, amount], { account: p.bob.account });
      const now = BigInt(await p.networkHelpers.time.latest());
      await p.escrow.write.offerJob(
        [id, amount, USDC(1), now + 7n * DAY, 3600n, p.validator.account.address, ZERO32, ""],
        { account: p.bob.account }
      );
      const jobId = await p.escrow.read.jobOf([1n]).then(async () => {
        // ids are sequential; find the newest by probing forward
        let n = 1n;
        while ((await p.escrow.read.jobOf([n + 1n])).client !== zeroAddress) n += 1n;
        return n;
      });
      await p.escrow.write.acceptJob([jobId], { account: p.alice.account });
      await p.escrow.write.deliver([jobId, ZERO32, ""], { account: p.alice.account });
      await p.escrow.write.acceptDelivery([jobId, rating, 0, "quality", "", ZERO32], {
        account: p.bob.account,
      });
    }

    const [count, value, weight] = await p.reputation.read.getAttestedSummary([id, [], "", ""]);
    assert.equal(count, 2n);
    assert.equal(weight, USDC(1010));
    // A perfect score on a $10 job barely moves an average dominated by a $1000 job.
    assert.ok(value < 5100n && value > 5000n, `expected ~50.5, got ${value}`);
  });

  it("refuses attested self-feedback from the agent's own owner", async () => {
    const p = await deployProtocol();
    const id = await fundedAgent(p);
    await p.reputation.write.setSettlementModule([p.deployer.account.address, true]);
    await expectRevert(
      p.reputation.write.giveAttestedFeedback([
        id,
        p.alice.account.address,
        100n,
        0,
        "quality",
        "",
        "",
        "",
        ZERO32,
        USDC(1),
        ZERO32,
      ]),
      "SelfFeedback"
    );
  });

  it("normalises differing decimals before averaging them", async () => {
    const p = await deployProtocol();
    const id = await fundedAgent(p);
    await p.reputation.write.giveFeedback([id, 80n, 0, "q", "", "", "", ZERO32], { account: p.bob.account });
    await p.reputation.write.giveFeedback([id, 6000n, 2, "q", "", "", "", ZERO32], {
      account: p.carol.account,
    });

    const [count, value, decimals] = await p.reputation.read.getSummary([id, [], "q", ""]);
    assert.equal(count, 2n);
    assert.equal(decimals, 2);
    assert.equal(value, 7000n, "80 (0dp) and 60.00 (2dp) average to 70.00");
  });
});
