import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toHex } from "viem";
import { deployProtocol, expectRevert, mintAgent, ZERO32 } from "./helpers.js";

describe("ERC-8126 — portable agent security verification", () => {
  it("lets an allowlisted provider publish a queryable risk score and proof", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);
    const proof = keccak256(toHex("complete ERC-8126 report"));

    await p.validation.write.setVerificationProvider([p.validator.account.address, true]);
    await p.validation.write.recordAgentVerification(
      [id, 18, ZERO32, ZERO32, ZERO32, ZERO32, ZERO32, proof],
      { account: p.validator.account }
    );

    assert.equal(await p.validation.read.getLatestRiskScore([id]), 18);
    const verification = await p.validation.read.latestVerificationOf([id]);
    assert.equal(verification.provider.toLowerCase(), p.validator.account.address.toLowerCase());
    assert.equal(verification.riskScore, 18);
    assert.equal(verification.summaryProofId, proof);
    assert.ok(verification.verifiedAt > 0n);
  });

  it("rejects spoofed, out-of-range, missing-agent, and absent assessments", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);

    await expectRevert(p.validation.read.getLatestRiskScore([id]), "NoVerification");
    await expectRevert(
      p.validation.write.recordAgentVerification([id, 0, ZERO32, ZERO32, ZERO32, ZERO32, ZERO32, ZERO32]),
      "VerificationProviderNotAllowed"
    );

    await p.validation.write.setVerificationProvider([p.validator.account.address, true]);
    await expectRevert(
      p.validation.write.recordAgentVerification(
        [id, 101, ZERO32, ZERO32, ZERO32, ZERO32, ZERO32, ZERO32],
        { account: p.validator.account }
      ),
      "ScoreOutOfRange"
    );
    await expectRevert(
      p.validation.write.recordAgentVerification(
        [999n, 10, ZERO32, ZERO32, ZERO32, ZERO32, ZERO32, ZERO32],
        { account: p.validator.account }
      ),
      "ERC721NonexistentToken"
    );
  });

  it("does not let a work validator publish security assessments", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);

    assert.equal(await p.validation.read.isValidator([p.validator.account.address]), true);
    assert.equal(await p.validation.read.isVerificationProvider([p.validator.account.address]), false);
    await expectRevert(
      p.validation.write.setVerificationProvider([p.validator.account.address, true], { account: p.alice.account }),
      "OwnableUnauthorizedAccount"
    );
    await expectRevert(
      p.validation.write.recordAgentVerification(
        [id, 0, ZERO32, ZERO32, ZERO32, ZERO32, ZERO32, ZERO32],
        { account: p.validator.account }
      ),
      "VerificationProviderNotAllowed"
    );
  });
});
