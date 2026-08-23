import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAddress, toHex, zeroAddress } from "viem";
import { deployProtocol, mintAgent, expectRevert, DAY } from "./helpers.js";

const YEAR = 365n * DAY;

async function withRoles(p: Awaited<ReturnType<typeof deployProtocol>>) {
  const roles = await p.viem.deployContract("AnimaRoles", [p.anima.address]);
  // The registry freezes agents in place instead of escrowing them, which needs the module hook.
  await p.anima.write.setModule([roles.address, true]);
  const id = await mintAgent(p, p.alice.account.address);
  const now = BigInt(await p.networkHelpers.time.latest());
  return { roles, id, now };
}

function role(overrides: Record<string, unknown>) {
  return {
    roleId: "0x" + "00".repeat(32),
    tokenAddress: zeroAddress,
    tokenId: 0n,
    recipient: zeroAddress,
    expirationDate: 0n,
    revocable: true,
    data: "0x" as `0x${string}`,
    ...overrides,
  };
}

describe("AnimaRoles — ERC-7432 without touching the token", () => {
  it("advertises the interface id the spec publishes", async () => {
    const p = await deployProtocol();
    const { roles } = await withRoles(p);
    assert.equal(await roles.read.supportsInterface(["0xd00ca5cf"]), true);
  });

  it("holds four distinct roles at once — the thing ERC-4907 cannot express", async () => {
    const p = await deployProtocol();
    const { roles, id, now } = await withRoles(p);

    const grants = [
      { key: await roles.read.OPERATOR(), to: p.bob, until: now + 30n * DAY },
      { key: await roles.read.PAYER(), to: p.carol, until: now + 7n * DAY },
      { key: await roles.read.AUDITOR(), to: p.validator, until: now + 90n * DAY },
      { key: await roles.read.TRAINER(), to: p.guardian, until: now + 60n * DAY },
    ];

    for (const g of grants) {
      await roles.write.grantRole(
        [
          role({
            roleId: g.key,
            tokenAddress: p.anima.address,
            tokenId: id,
            recipient: g.to.account.address,
            expirationDate: g.until,
          }),
        ],
        { account: p.alice.account }
      );
    }

    for (const g of grants) {
      assert.equal(
        getAddress(await roles.read.recipientOf([p.anima.address, id, g.key])),
        getAddress(g.to.account.address)
      );
      assert.equal(await roles.read.hasRole([id, g.key, g.to.account.address]), true);
    }
    // ERC-4907's single `user` slot would have held exactly one of these.
    assert.equal(getAddress(await p.anima.read.userOf([id])), getAddress(zeroAddress));
  });

  it("freezes the agent in place rather than taking custody of it", async () => {
    const p = await deployProtocol();
    const { roles, id, now } = await withRoles(p);
    const key = await roles.read.OPERATOR();

    await roles.write.grantRole(
      [
        role({
          roleId: key,
          tokenAddress: p.anima.address,
          tokenId: id,
          recipient: p.bob.account.address,
          expirationDate: now + 30n * DAY,
        }),
      ],
      { account: p.alice.account }
    );

    // The owner still holds it — it is visible to every marketplace and indexer.
    assert.equal(getAddress(await p.anima.read.ownerOf([id])), getAddress(p.alice.account.address));
    assert.equal(getAddress(await roles.read.ownerOf([p.anima.address, id])), getAddress(p.alice.account.address));
    // It just cannot be sold out from under the grantee.
    assert.equal(await p.anima.read.locked([id]), true);
    await expectRevert(
      p.anima.write.transferFrom([p.alice.account.address, p.deployer.account.address, id], {
        account: p.alice.account,
      }),
      "AgentLocked"
    );
  });

  it("returns the agent to circulation once roles are cleared", async () => {
    const p = await deployProtocol();
    const { roles, id, now } = await withRoles(p);
    const key = await roles.read.OPERATOR();

    await roles.write.grantRole(
      [
        role({
          roleId: key,
          tokenAddress: p.anima.address,
          tokenId: id,
          recipient: p.bob.account.address,
          expirationDate: now + 30n * DAY,
        }),
      ],
      { account: p.alice.account }
    );
    await roles.write.revokeRole([p.anima.address, id, key], { account: p.alice.account });

    // Permissionless: an owner should not need their grantees' cooperation to sell.
    await roles.write.unlockToken([p.anima.address, id], { account: p.deployer.account });
    assert.equal(await p.anima.read.locked([id]), false);
    await p.anima.write.transferFrom([p.alice.account.address, p.deployer.account.address, id], {
      account: p.alice.account,
    });
  });

  it("caps an irrevocable role, so a grant cannot lock an agent forever", async () => {
    const p = await deployProtocol();
    const { roles, id, now } = await withRoles(p);
    const key = await roles.read.OPERATOR();

    await expectRevert(
      roles.write.grantRole(
        [
          role({
            roleId: key,
            tokenAddress: p.anima.address,
            tokenId: id,
            recipient: p.bob.account.address,
            expirationDate: now + YEAR + 2n * DAY,
            revocable: false,
          }),
        ],
        { account: p.alice.account }
      ),
      "IrrevocableTooLong"
    );

    // A revocable role may run as long as the owner likes — they can end it whenever.
    await roles.write.grantRole(
      [
        role({
          roleId: key,
          tokenAddress: p.anima.address,
          tokenId: id,
          recipient: p.bob.account.address,
          expirationDate: now + 10n * YEAR,
          revocable: true,
        }),
      ],
      { account: p.alice.account }
    );
  });

  it("holds an irrevocable role against the owner until it expires", async () => {
    const p = await deployProtocol();
    const { roles, id, now } = await withRoles(p);
    const key = await roles.read.AUDITOR();

    await roles.write.grantRole(
      [
        role({
          roleId: key,
          tokenAddress: p.anima.address,
          tokenId: id,
          recipient: p.bob.account.address,
          expirationDate: now + 10n * DAY,
          revocable: false,
        }),
      ],
      { account: p.alice.account }
    );

    await expectRevert(
      roles.write.revokeRole([p.anima.address, id, key], { account: p.alice.account }),
      "RoleNotRevocable"
    );
    await expectRevert(roles.write.unlockToken([p.anima.address, id]), "StillLocked");

    // The grantee may always walk away from their own role.
    await roles.write.revokeRole([p.anima.address, id, key], { account: p.bob.account });
    assert.equal(getAddress(await roles.read.recipientOf([p.anima.address, id, key])), getAddress(zeroAddress));

    // The lock still runs its term — the owner sold that certainty and cannot un-sell it.
    await expectRevert(roles.write.unlockToken([p.anima.address, id]), "StillLocked");
    await p.networkHelpers.time.increase(Number(10n * DAY) + 1);
    await roles.write.unlockToken([p.anima.address, id]);
    assert.equal(await p.anima.read.locked([id]), false);
  });

  it("lapses a role on its own expiry", async () => {
    const p = await deployProtocol();
    const { roles, id, now } = await withRoles(p);
    const key = await roles.read.TRAINER();

    await roles.write.grantRole(
      [
        role({
          roleId: key,
          tokenAddress: p.anima.address,
          tokenId: id,
          recipient: p.bob.account.address,
          expirationDate: now + 3600n,
          data: toHex("lora-v3"),
        }),
      ],
      { account: p.alice.account }
    );
    assert.equal(await roles.read.hasRole([id, key, p.bob.account.address]), true);
    assert.equal(await roles.read.roleData([p.anima.address, id, key]), toHex("lora-v3"));

    await p.networkHelpers.time.increase(3601);
    assert.equal(await roles.read.hasRole([id, key, p.bob.account.address]), false);
    assert.equal(getAddress(await roles.read.recipientOf([p.anima.address, id, key])), getAddress(zeroAddress));
  });

  it("lets an approved operator grant on the owner's behalf, and nobody else", async () => {
    const p = await deployProtocol();
    const { roles, id, now } = await withRoles(p);
    const key = await roles.read.PAYER();
    const grant = role({
      roleId: key,
      tokenAddress: p.anima.address,
      tokenId: id,
      recipient: p.bob.account.address,
      expirationDate: now + 30n * DAY,
    });

    await expectRevert(roles.write.grantRole([grant], { account: p.carol.account }), "NotOwnerOrApproved");

    await roles.write.setRoleApprovalForAll([p.anima.address, p.carol.account.address, true], {
      account: p.alice.account,
    });
    assert.equal(
      await roles.read.isRoleApprovedForAll([p.anima.address, p.alice.account.address, p.carol.account.address]),
      true
    );
    await roles.write.grantRole([grant], { account: p.carol.account });
  });

  it("refuses to answer for a collection it does not represent", async () => {
    const p = await deployProtocol();
    const { roles, id, now } = await withRoles(p);
    await expectRevert(
      roles.write.grantRole(
        [
          role({
            roleId: await roles.read.OPERATOR(),
            tokenAddress: p.usdc.address,
            tokenId: id,
            recipient: p.bob.account.address,
            expirationDate: now + DAY,
          }),
        ],
        { account: p.alice.account }
      ),
      "UnsupportedCollection"
    );
  });

  it("rejects an expiry already in the past", async () => {
    const p = await deployProtocol();
    const { roles, id } = await withRoles(p);
    await expectRevert(
      roles.write.grantRole(
        [
          role({
            roleId: await roles.read.OPERATOR(),
            tokenAddress: p.anima.address,
            tokenId: id,
            recipient: p.bob.account.address,
            expirationDate: 1n,
          }),
        ],
        { account: p.alice.account }
      ),
      "ExpirationInThePast"
    );
  });
});
