import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "viem";
import { deployProtocol, expectRevert, mintAgent } from "./helpers.js";

describe("AnimaBindings — ERC-8217 identity authorization", () => {
  it("rejects an NFT owner trying to permanently hijack another ERC-8004 identity", async () => {
    const p = await deployProtocol();
    const victimId = await mintAgent(p, p.alice.account.address);
    const attackerTokenId = await mintAgent(p, p.bob.account.address);
    const bindings = await p.viem.deployContract("AnimaBindings", [p.anima.address]);

    await expectRevert(
      bindings.write.bind([victimId, 0, p.anima.address, attackerTokenId], { account: p.bob.account }),
      "NotAgentOwner"
    );

    const unbound = await bindings.read.bindingOf([victimId]);
    assert.equal(unbound.tokenContract, "0x0000000000000000000000000000000000000000");
  });

  it("allows the current identity owner to bind a token they own and follows token transfers", async () => {
    const p = await deployProtocol();
    const agentId = await mintAgent(p, p.alice.account.address);
    const masterId = await mintAgent(p, p.alice.account.address);
    const bindings = await p.viem.deployContract("AnimaBindings", [p.anima.address]);

    await bindings.write.bind([agentId, 0, p.anima.address, masterId], { account: p.alice.account });
    assert.equal(getAddress(await bindings.read.controllerOf([agentId])), getAddress(p.alice.account.address));

    await p.anima.write.transferFrom([p.alice.account.address, p.bob.account.address, masterId], {
      account: p.alice.account,
    });
    assert.equal(getAddress(await bindings.read.controllerOf([agentId])), getAddress(p.bob.account.address));

    await expectRevert(
      bindings.write.bind([agentId, 0, p.anima.address, masterId], { account: p.bob.account }),
      "AlreadyBound"
    );
  });

  it("requires ownership of both the ERC-8004 identity and proposed master token", async () => {
    const p = await deployProtocol();
    const agentId = await mintAgent(p, p.alice.account.address);
    const foreignTokenId = await mintAgent(p, p.bob.account.address);
    const bindings = await p.viem.deployContract("AnimaBindings", [p.anima.address]);

    await expectRevert(
      bindings.write.bind([agentId, 0, p.anima.address, foreignTokenId], { account: p.alice.account }),
      "NotTokenOwner"
    );
  });
});
