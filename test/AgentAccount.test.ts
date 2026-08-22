import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getAddress, parseEther, encodeAbiParameters, parseAbiParameters, keccak256, encodeFunctionData, hashMessage, zeroAddress } from "viem";
import { deployProtocol, mintAgent, expectRevert, AgentStatus, ZERO32 } from "./helpers.js";

const FOREVER = 2n ** 63n;

/** Deploy an agent's account, arm its policy, and hand `signer` a session. */
async function armedAgent(p: Awaited<ReturnType<typeof deployProtocol>>, opts: {
  perTxWei?: bigint;
  dailyWei?: bigint;
  sessionCap?: bigint;
  allowUnlisted?: boolean;
  allowDelegateCall?: boolean;
  fund?: bigint;
} = {}) {
  const id = await mintAgent(p, p.alice.account.address);
  await p.anima.write.deployAccount([id]);
  const accountAddress = await p.anima.read.accountOf([id]);
  const account = await p.viem.getContractAt("AgentAccount", accountAddress);

  await p.anima.write.setPolicy(
    [
      id,
      {
        perTxWei: opts.perTxWei ?? parseEther("1"),
        dailyWei: opts.dailyWei ?? parseEther("2"),
        expiry: 0n,
        allowDelegateCall: opts.allowDelegateCall ?? false,
        allowUnlistedTargets: opts.allowUnlisted ?? true,
        targetsRoot: ZERO32,
      },
    ],
    { account: p.alice.account }
  );
  await p.anima.write.setStatus([id, AgentStatus.Active], { account: p.alice.account });
  await account.write.grantSession(
    [p.carol.account.address, 0n, FOREVER, opts.sessionCap ?? parseEther("5")],
    { account: p.alice.account }
  );

  if (opts.fund !== undefined) {
    await p.alice.sendTransaction({ to: accountAddress, value: opts.fund });
  }
  return { id, account, accountAddress };
}

describe("AgentAccount — ERC-6551 identity", () => {
  it("reads its own token triple out of its proxy footer", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);
    await p.anima.write.deployAccount([id]);
    const account = await p.viem.getContractAt("AgentAccount", await p.anima.read.accountOf([id]));

    const [chainId, tokenContract, tokenId] = await account.read.token();
    assert.equal(chainId, BigInt(await p.publicClient.getChainId()));
    assert.equal(getAddress(tokenContract), getAddress(p.anima.address));
    assert.equal(tokenId, id);
    assert.equal(getAddress(await account.read.owner()), getAddress(p.alice.account.address));
  });

  it("returns no owner when the agent ends up owning its own account", async () => {
    const p = await deployProtocol();
    const id = await mintAgent(p, p.alice.account.address);
    await p.anima.write.deployAccount([id]);
    const accountAddress = await p.anima.read.accountOf([id]);
    const account = await p.viem.getContractAt("AgentAccount", accountAddress);

    // A closed authorisation loop with no human at the end of it.
    await p.anima.write.transferFrom([p.alice.account.address, accountAddress, id], {
      account: p.alice.account,
    });
    assert.equal(getAddress(await account.read.owner()), getAddress(zeroAddress));
    await expectRevert(
      account.write.grantSession([p.carol.account.address, 0n, FOREVER, 1n], { account: p.alice.account }),
      "OwnershipCycle"
    );
  });

  it("recognises only the owner as a valid ERC-6551 signer", async () => {
    const p = await deployProtocol();
    const { account } = await armedAgent(p);
    assert.equal(await account.read.isValidSigner([p.alice.account.address, "0x"]), "0x523e3260");
    assert.equal(await account.read.isValidSigner([p.carol.account.address, "0x"]), "0x00000000");
  });
});

describe("AgentAccount — the leash", () => {
  it("lets the owner spend without limit, including past the agent's own caps", async () => {
    const p = await deployProtocol();
    const { account, accountAddress } = await armedAgent(p, { fund: parseEther("10") });

    const before = await p.publicClient.getBalance({ address: p.bob.account.address });
    // Far beyond perTxWei: the owner must always be able to rescue funds.
    await account.write.execute([p.bob.account.address, parseEther("5"), "0x", 0], {
      account: p.alice.account,
    });
    const after = await p.publicClient.getBalance({ address: p.bob.account.address });
    assert.equal(after - before, parseEther("5"));
    assert.equal(await p.publicClient.getBalance({ address: accountAddress }), parseEther("5"));
  });

  it("rejects a caller with no session at all", async () => {
    const p = await deployProtocol();
    const { account } = await armedAgent(p, { fund: parseEther("1") });
    await expectRevert(
      account.write.execute([p.bob.account.address, 1n, "0x", 0], { account: p.deployer.account }),
      "SessionNotValid"
    );
  });

  it("enforces the per-transaction cap on a session key", async () => {
    const p = await deployProtocol();
    const { account } = await armedAgent(p, { perTxWei: parseEther("1"), fund: parseEther("10") });

    await account.write.execute([p.bob.account.address, parseEther("1"), "0x", 0], {
      account: p.carol.account,
    });
    await expectRevert(
      account.write.execute([p.bob.account.address, parseEther("1.1"), "0x", 0], {
        account: p.carol.account,
      }),
      "PerTxCapExceeded"
    );
  });

  it("enforces the daily cap across several transactions", async () => {
    const p = await deployProtocol();
    const { account } = await armedAgent(p, {
      perTxWei: parseEther("1"),
      dailyWei: parseEther("1.5"),
      fund: parseEther("10"),
    });

    await account.write.execute([p.bob.account.address, parseEther("1"), "0x", 0], {
      account: p.carol.account,
    });
    await expectRevert(
      account.write.execute([p.bob.account.address, parseEther("0.6"), "0x", 0], {
        account: p.carol.account,
      }),
      "DailyCapExceeded"
    );
    // ...and resets on the next day.
    await p.networkHelpers.time.increase(86400);
    await account.write.execute([p.bob.account.address, parseEther("1"), "0x", 0], {
      account: p.carol.account,
    });
  });

  it("enforces the lifetime session cap independently of the daily cap", async () => {
    const p = await deployProtocol();
    const { account } = await armedAgent(p, {
      perTxWei: parseEther("1"),
      dailyWei: parseEther("100"),
      sessionCap: parseEther("1.5"),
      fund: parseEther("10"),
    });

    await account.write.execute([p.bob.account.address, parseEther("1"), "0x", 0], {
      account: p.carol.account,
    });
    await expectRevert(
      account.write.execute([p.bob.account.address, parseEther("1"), "0x", 0], {
        account: p.carol.account,
      }),
      "SessionCapExceeded"
    );
  });

  it("stops a session key dead when the agent is paused — the kill switch is real", async () => {
    const p = await deployProtocol();
    const { id, account } = await armedAgent(p, { fund: parseEther("5") });

    await p.anima.write.setGuardian([id, p.guardian.account.address], { account: p.alice.account });
    await p.anima.write.guardianPause([id], { account: p.guardian.account });

    await expectRevert(
      account.write.execute([p.bob.account.address, 1n, "0x", 0], { account: p.carol.account }),
      "AgentNotActive"
    );
    // The owner can still rescue what is inside.
    await account.write.execute([p.bob.account.address, parseEther("1"), "0x", 0], {
      account: p.alice.account,
    });
  });

  it("honours the target allowlist when unlisted targets are disallowed", async () => {
    const p = await deployProtocol();
    const { id, account } = await armedAgent(p, { allowUnlisted: false, fund: parseEther("5") });
    const token = await p.viem.deployContract("MockERC20", ["T", "T", 18]);

    const mintCall = encodeFunctionData({
      abi: token.abi,
      functionName: "mint",
      args: [p.bob.account.address, 1n],
    });

    await expectRevert(
      account.write.execute([token.address, 0n, mintCall, 0], { account: p.carol.account }),
      "TargetNotAllowed"
    );

    await account.write.setAllowedCall([token.address, mintCall.slice(0, 10) as `0x${string}`, true], {
      account: p.alice.account,
    });
    await account.write.execute([token.address, 0n, mintCall, 0], { account: p.carol.account });
    assert.equal(await token.read.balanceOf([p.bob.account.address]), 1n);
  });

  it("refuses delegatecall from a session key unless the policy allows it", async () => {
    const p = await deployProtocol();
    const { account } = await armedAgent(p, { allowDelegateCall: false });
    await expectRevert(
      account.write.execute([p.bob.account.address, 0n, "0x", 1], { account: p.carol.account }),
      "DelegateCallNotAllowed"
    );
  });

  it("lets a guardian revoke a session without waking the owner", async () => {
    const p = await deployProtocol();
    const { id, account } = await armedAgent(p, { fund: parseEther("5") });
    await p.anima.write.setGuardian([id, p.guardian.account.address], { account: p.alice.account });

    await account.write.revokeSession([p.carol.account.address], { account: p.guardian.account });
    await expectRevert(
      account.write.execute([p.bob.account.address, 1n, "0x", 0], { account: p.carol.account }),
      "SessionNotValid"
    );
  });
});

describe("AgentAccount — ERC-1271", () => {
  it("validates the owner's signature and refuses a session key's", async () => {
    const p = await deployProtocol();
    const { account } = await armedAgent(p);
    const message = "hire me";
    // signMessage applies the EIP-191 prefix, so the hash presented to the contract is the
    // prefixed one — that is what an ERC-1271 consumer would pass.
    const digest = hashMessage(message);

    const ownerSig = await p.alice.signMessage({ message });
    assert.equal(await account.read.isValidSignature([digest, ownerSig]), "0x1626ba7e");

    // A budget cap means nothing if the key can instead sign an unbounded off-chain order,
    // so session keys deliberately cannot make the account speak.
    const sessionSig = await p.carol.signMessage({ message });
    assert.notEqual(await account.read.isValidSignature([digest, sessionSig]), "0x1626ba7e");
  });
});

describe("AgentAccount — audit chain", () => {
  it("advances a hash chain that an off-chain replay can reproduce exactly", async () => {
    const p = await deployProtocol();
    const { account, accountAddress } = await armedAgent(p, { fund: parseEther("5") });

    assert.equal(await account.read.auditRoot(), ZERO32);

    const value = parseEther("0.5");
    const hash = await account.write.execute([p.bob.account.address, value, "0x", 0], {
      account: p.carol.account,
    });
    const receipt = await p.publicClient.waitForTransactionReceipt({ hash });
    const block = await p.publicClient.getBlock({ blockNumber: receipt.blockNumber });

    const onChain = await account.read.auditRoot();
    // The chain commits to the post-increment state, which is also the state after the call.
    const stateAfter = await account.read.state();
    const expected = keccak256(
      encodeAbiParameters(
        parseAbiParameters(
          "bytes32, uint256, address, address, address, uint256, bytes4, bytes32, uint8, uint256, uint256"
        ),
        [
          ZERO32,
          BigInt(await p.publicClient.getChainId()),
          accountAddress,
          p.carol.account.address,
          p.bob.account.address,
          value,
          "0x00000000",
          keccak256("0x"),
          0,
          stateAfter,
          block.timestamp,
        ]
      )
    );
    assert.equal(onChain, expected, "auditRoot must be reproducible from public data");
  });

  it("produces a different root for an identical repeated call", async () => {
    const p = await deployProtocol();
    const { account } = await armedAgent(p, { fund: parseEther("5") });

    await account.write.execute([p.bob.account.address, 1n, "0x", 0], { account: p.carol.account });
    const first = await account.read.auditRoot();
    await account.write.execute([p.bob.account.address, 1n, "0x", 0], { account: p.carol.account });
    const second = await account.read.auditRoot();

    assert.notEqual(first, second, "history must not be collapsible by repeating a call");
  });

  it("increments ERC-6551 state on every execution so a buyer can detect a drain", async () => {
    const p = await deployProtocol();
    const { account } = await armedAgent(p, { fund: parseEther("5") });
    const before = await account.read.state();
    await account.write.execute([p.bob.account.address, 1n, "0x", 0], { account: p.carol.account });
    assert.equal(await account.read.state(), before + 1n);
  });
});
