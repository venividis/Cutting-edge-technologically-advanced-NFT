import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodeAbiParameters, getAddress, toHex } from "viem";
import { deployProtocol, mintAgent } from "./helpers.js";

async function page(publicClient: any, address: `0x${string}`, path: string) {
  const result = await publicClient.call({ to: address, data: toHex(path) });
  assert.ok(result.data);
  return decodeAbiParameters([{ type: "string" }], result.data)[0];
}

describe("AnimaWeb3Renderer", () => {
  it("serves an ERC-4804 manual-mode live page from token state", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);
    const renderer = await p.viem.deployContract("AnimaWeb3Renderer", [p.anima.address]);

    assert.equal(await renderer.read.resolveMode(), toHex("manual", { size: 32 }));
    const html = await page(p.publicClient, renderer.address, `/token/${id}/live`);
    assert.match(html, /<!doctype html>/);
    assert.match(html, /Not merely owned/);
    assert.match(html, /data-panel="overview"/);
    assert.match(html, /data-panel="identity"/);
    assert.match(html, /data-panel="control"/);
    assert.match(html, /data-panel="advanced"/);
    assert.match(html, /ACTIVATE ACCOUNT/);
    assert.match(html, /SIMULATE &amp; EXECUTE/);
    assert.match(html, /createWalletClient/);
    assert.match(html, /simulateContract/);
    assert.ok(html.toLowerCase().includes(getAddress(p.alice.account.address).toLowerCase()));
    assert.ok(html.toLowerCase().includes(getAddress(await p.anima.read.accountOf([id])).toLowerCase()));
  });

  it("serves usage and not-found pages without reverting", async () => {
    const p = await deployProtocol();
    const renderer = await p.viem.deployContract("AnimaWeb3Renderer", [p.anima.address]);

    assert.match(await page(p.publicClient, renderer.address, "/"), /\/token\/\{id\}\/live/);
    assert.match(await page(p.publicClient, renderer.address, "/token/999/live"), /Agent not found/);
    assert.match(await page(p.publicClient, renderer.address, "/bad/path"), /Agent not found/);
  });
});
