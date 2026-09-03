import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keccak256, toHex } from "viem";
import { deployProtocol, mintAgent, expectRevert, ZERO32 } from "./helpers.js";

const Kind = { Email: 0, Domain: 1, DID: 2, ENS: 3, Social: 4, MeshPeer: 5, Phone: 6, ApiKeyId: 7 } as const;
const NEVER = 0n;

async function withHandles(p: Awaited<ReturnType<typeof deployProtocol>>) {
  const handles = await p.viem.deployContract("AgentHandles", [p.anima.address, p.deployer.account.address]);
  // Verifiers are authorised per kind: an inbox provider should not be able to certify DNS.
  await handles.write.setVerifier([Kind.Email, p.validator.account.address, true]);
  await handles.write.setVerifier([Kind.MeshPeer, p.validator.account.address, true]);
  return handles;
}

describe("AgentHandles — an agent with a real account", () => {
  it("records a verified inbox that a counterparty can check without asking the agent", async () => {
    const p = await deployProtocol();
    const handles = await withHandles(p);
    const id = await mintAgent(p, p.alice.account.address);

    await handles.write.attest(
      [id, Kind.Email, "atlas.agents.example", NEVER, "https://verifier/evidence/1", keccak256(toHex("dkim-chain"))],
      { account: p.validator.account }
    );

    assert.equal(await handles.read.controls([id, Kind.Email, "atlas.agents.example"]), true);
    assert.equal(await handles.read.agentFor([Kind.Email, "atlas.agents.example"]), id);
    assert.equal(await handles.read.handleCount([id]), 1n);
  });

  it("refuses an attestation from an address not authorised for that kind", async () => {
    const p = await deployProtocol();
    const handles = await withHandles(p);
    const id = await mintAgent(p, p.alice.account.address);

    // Authorised for Email and MeshPeer, but not for Domain.
    await expectRevert(
      handles.write.attest([id, Kind.Domain, "agents.example", NEVER, "", ZERO32], {
        account: p.validator.account,
      }),
      "NotAVerifier"
    );
    await expectRevert(
      handles.write.attest([id, Kind.Email, "x.example", NEVER, "", ZERO32], { account: p.bob.account }),
      "NotAVerifier"
    );
  });

  it("binds one handle to exactly one agent", async () => {
    const p = await deployProtocol();
    const handles = await withHandles(p);
    const first = await mintAgent(p, p.alice.account.address);
    const second = await mintAgent(p, p.bob.account.address);

    await handles.write.attest([first, Kind.Email, "shared.example", NEVER, "", ZERO32], {
      account: p.validator.account,
    });
    // Two agents advertising the same inbox would make "who controls this" ambiguous, which is
    // exactly the impersonation this registry exists to prevent.
    await expectRevert(
      handles.write.attest([second, Kind.Email, "shared.example", NEVER, "", ZERO32], {
        account: p.validator.account,
      }),
      "HandleTaken"
    );

    // Freed on revocation, so a genuine hand-over is possible.
    await handles.write.revoke([first, 0n], { account: p.validator.account });
    await handles.write.attest([second, Kind.Email, "shared.example", NEVER, "", ZERO32], {
      account: p.validator.account,
    });
    assert.equal(await handles.read.agentFor([Kind.Email, "shared.example"]), second);
  });

  it("stops vouching for a handle once the agent changes hands", async () => {
    const p = await deployProtocol();
    const handles = await withHandles(p);
    const id = await mintAgent(p, p.alice.account.address);
    await handles.write.attest([id, Kind.Email, "atlas.example", NEVER, "", ZERO32], {
      account: p.validator.account,
    });
    assert.equal(await handles.read.isFresh([id, 0n]), true);

    await p.anima.write.transferFrom([p.alice.account.address, p.bob.account.address, id], {
      account: p.alice.account,
    });

    // A verification made about the previous owner says nothing about the new one — the same
    // rule the token applies to operators and autonomy.
    assert.equal(await handles.read.isFresh([id, 0n]), false);
    assert.equal(await handles.read.controls([id, Kind.Email, "atlas.example"]), false);
  });

  it("expires an attestation on schedule", async () => {
    const p = await deployProtocol();
    const handles = await withHandles(p);
    const id = await mintAgent(p, p.alice.account.address);
    const expiry = BigInt(await p.networkHelpers.time.latest()) + 3600n;

    await handles.write.attest([id, Kind.Email, "atlas.example", expiry, "", ZERO32], {
      account: p.validator.account,
    });
    assert.equal(await handles.read.isFresh([id, 0n]), true);

    await p.networkHelpers.time.increase(3601);
    assert.equal(await handles.read.isFresh([id, 0n]), false);
    assert.equal(await handles.read.agentFor([Kind.Email, "atlas.example"]), 0n);
  });

  it("lets another agent reclaim an expired handle", async () => {
    const p = await deployProtocol();
    const handles = await withHandles(p);
    const first = await mintAgent(p, p.alice.account.address);
    const second = await mintAgent(p, p.bob.account.address);
    const expiry = BigInt(await p.networkHelpers.time.latest()) + 3600n;

    await handles.write.attest([first, Kind.Email, "recycled.example", expiry, "", ZERO32], {
      account: p.validator.account,
    });
    await p.networkHelpers.time.increase(3601);
    await handles.write.attest([second, Kind.Email, "recycled.example", NEVER, "", ZERO32], {
      account: p.validator.account,
    });

    assert.equal(await handles.read.controls([first, Kind.Email, "recycled.example"]), false);
    assert.equal(await handles.read.controls([second, Kind.Email, "recycled.example"]), true);
    assert.equal(await handles.read.agentFor([Kind.Email, "recycled.example"]), second);
  });

  it("lets another agent reclaim a handle made stale by transfer", async () => {
    const p = await deployProtocol();
    const handles = await withHandles(p);
    const first = await mintAgent(p, p.alice.account.address);
    const second = await mintAgent(p, p.carol.account.address);

    await handles.write.attest([first, Kind.Email, "handover.example", NEVER, "", ZERO32], {
      account: p.validator.account,
    });
    await p.anima.write.transferFrom([p.alice.account.address, p.bob.account.address, first], {
      account: p.alice.account,
    });
    await handles.write.attest([second, Kind.Email, "handover.example", NEVER, "", ZERO32], {
      account: p.validator.account,
    });

    assert.equal(await handles.read.agentFor([Kind.Email, "handover.example"]), second);
  });

  it("lets the agent's owner disown a claim they did not make", async () => {
    const p = await deployProtocol();
    const handles = await withHandles(p);
    const id = await mintAgent(p, p.alice.account.address);
    await handles.write.attest([id, Kind.Email, "atlas.example", NEVER, "", ZERO32], {
      account: p.validator.account,
    });

    await expectRevert(handles.write.revoke([id, 0n], { account: p.carol.account }), "NotAuthorised");
    await handles.write.revoke([id, 0n], { account: p.alice.account });
    assert.equal(await handles.read.controls([id, Kind.Email, "atlas.example"]), false);
  });

  it("carries a libp2p mesh peer identity, so a mesh can trust the chain instead of an IdP", async () => {
    const p = await deployProtocol();
    const handles = await withHandles(p);
    const id = await mintAgent(p, p.alice.account.address);
    const peerId = "12D3KooWL5rXbLPMEfoNQBnJUnzZC4pJfEK1J9zbBqYt6nYbFuGq";

    await handles.write.attest([id, Kind.MeshPeer, peerId, NEVER, "", ZERO32], {
      account: p.validator.account,
    });

    // A Sovereign Agent Mesh control plane binds a peer id to an OIDC subject. Publishing the
    // same peer id against the agent token gives a second, permissionless way to check it.
    assert.equal(await handles.read.agentFor([Kind.MeshPeer, peerId]), id);
    assert.equal(await handles.read.controls([id, Kind.MeshPeer, peerId]), true);
  });
});
