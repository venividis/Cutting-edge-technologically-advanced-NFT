import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertMainnetEnsCustody, encodeContenthash } from "../cli/anima.mjs";

describe("ANIMA terminal", () => {
  it("encodes a CIDv1 IPFS URI as an ENS contenthash", () => {
    assert.equal(
      encodeContenthash("ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylh5mda4t5wqx5d4o4k3a/index.html"),
      "0xe30101701220c3c4733ec8affd06cf9e9ff50ffc6bcd2ec85a6167eb060e4fb685fa3e3b8ad8",
    );
  });

  it("accepts a pre-encoded contenthash and rejects unsupported or malformed identifiers", () => {
    assert.equal(encodeContenthash("0xe3010170"), "0xe3010170");
    assert.throws(() => encodeContenthash("0xzz"), /even-length hex/);
    assert.throws(() => encodeContenthash("https://example.com"), /ipfs/);
    assert.throws(() => encodeContenthash("ipfs://b"), /invalid CIDv1/);
    assert.throws(() => encodeContenthash("ipfs://QmYwAPJzv5CZsnAzt8auVZRnGiRA5hWkV7DbU"), /CIDv1/);
  });

  it("only permits ENS custody for agents homed on Ethereum mainnet", () => {
    assert.doesNotThrow(() => assertMainnetEnsCustody(1));
    assert.throws(
      () => assertMainnetEnsCustody(8453),
      /home chain is Ethereum mainnet \(chain 1\)/,
    );
  });
});
