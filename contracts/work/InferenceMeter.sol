// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ExactERC20} from "../libraries/ExactERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

interface IAnimaMeterView {
    function isController(uint256 agentId, address account) external view returns (bool);
    function accountOf(uint256 agentId) external view returns (address);
}

/**
 * @title InferenceMeter — pay an agent per call, and keep the receipt
 * @notice Prepaid unidirectional payment channels for per-call agent billing, settling
 *         batches of work against a voucher the payer signed.
 *
 * @dev **The billing problem.** Per-call payment is the natural model for agent services and
 *      the one HTTP 402 / x402 assumes, but a settlement per call is absurd: the transaction
 *      costs more than the inference. The standard answer is a unidirectional payment
 *      channel, and that is what this is. The client escrows once; the agent accumulates
 *      signed vouchers off-chain, each stating a *cumulative* total; the agent settles
 *      on-chain whenever it likes, redeeming only the latest. A thousand calls cost one
 *      transaction, and an old voucher is worthless because cumulative totals only rise.
 *
 *      **The receipts are the interesting part.** Every settlement carries the batch of
 *      receipts it covers — request hash, response hash, model hash, and any attestation —
 *      and the voucher the client signed commits to exactly that batch. So the record is
 *      *bilateral*: the agent cannot invent work the client never asked for, and the client
 *      cannot later deny asking. That is a materially stronger provenance claim than
 *      anything an agent can assert about itself, and it is the raw material a dispute, an
 *      audit, or a reputation score actually needs.
 *
 *      **Closing is delayed on purpose.** A client who could withdraw instantly would simply
 *      do so after receiving work and before the agent settles. Closing therefore opens a
 *      challenge window during which the agent can still redeem outstanding vouchers.
 */
contract InferenceMeter is EIP712, ReentrancyGuardTransient {
    using ExactERC20 for IERC20;
    using SafeCast for uint256;

    /*//////////////////////////////////////////////////////////////
                                  TYPES
    //////////////////////////////////////////////////////////////*/

    struct Channel {
        address client;
        address token;
        uint256 agentId;
        uint128 deposited;
        uint128 claimed;
        uint64 closesAt; //  zero while open; set when the client starts closing
    }

    /// @notice One unit of billable work and whatever can be proven about it.
    struct Receipt {
        bytes32 requestHash; //   commitment to the prompt/input
        bytes32 responseHash; //  commitment to the output
        bytes32 modelHash; //     which model claimed to produce it
        uint64 units; //          tokens, seconds, calls — the agent's own unit
        uint8 attestationKind; // see AttestationKind in IAnima
        bytes32 attestation; //   digest of a TEE quote or proof, or zero
    }

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    bytes32 private constant _VOUCHER_TYPEHASH =
        keccak256("Voucher(uint256 channelId,uint256 cumulativeAmount,bytes32 workRoot,uint256 deadline)");

    /// @notice How long after a close request the agent can still settle. Must comfortably
    ///         exceed the agent's batching interval or honest work goes unpaid.
    uint64 public immutable CHALLENGE_WINDOW;

    IAnimaMeterView public immutable ANIMA;

    uint256 private _nextChannelId = 1;
    mapping(uint256 channelId => Channel) private _channels;

    /// @notice Hash chain over every receipt batch this agent has ever settled.
    mapping(uint256 agentId => bytes32) public workLog;

    /*//////////////////////////////////////////////////////////////
                             EVENTS / ERRORS
    //////////////////////////////////////////////////////////////*/

    event ChannelOpened(uint256 indexed channelId, uint256 indexed agentId, address indexed client, address token, uint256 amount);
    event ChannelFunded(uint256 indexed channelId, uint256 amount, uint256 deposited);
    event CloseRequested(uint256 indexed channelId, uint64 closesAt);
    event ChannelClosed(uint256 indexed channelId, address indexed client, uint256 refunded);
    event Settled(
        uint256 indexed channelId,
        uint256 indexed agentId,
        uint256 cumulativeAmount,
        uint256 paid,
        bytes32 workRoot,
        bytes32 workLogRoot
    );
    event WorkReceipt(
        uint256 indexed agentId,
        uint256 indexed channelId,
        bytes32 indexed requestHash,
        bytes32 responseHash,
        bytes32 modelHash,
        uint64 units,
        uint8 attestationKind,
        bytes32 attestation
    );

    error NoSuchChannel(uint256 channelId);
    error NotClient(uint256 channelId, address caller);
    error NotAgentController(uint256 agentId, address caller);
    error ChannelClosing(uint256 channelId, uint64 closesAt);
    error ChannelNotClosing(uint256 channelId);
    error ChallengeWindowOpen(uint256 channelId, uint64 closesAt);
    error VoucherExpired(uint256 deadline);
    error NotMonotonic(uint256 cumulative, uint128 claimed);
    error ExceedsDeposit(uint256 cumulative, uint128 deposited);
    error WorkRootMismatch(bytes32 expected, bytes32 actual);
    error InvalidSignature();
    error ZeroAmount();

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    constructor(IAnimaMeterView anima_, uint64 challengeWindow_) EIP712("AnimaInferenceMeter", "1") {
        ANIMA = anima_;
        CHALLENGE_WINDOW = challengeWindow_;
    }

    function channelOf(uint256 channelId) external view returns (Channel memory) {
        return _channels[channelId];
    }

    /// @notice Funds still available to the agent on this channel.
    function remaining(uint256 channelId) external view returns (uint256) {
        Channel storage c = _channels[channelId];
        return c.deposited - c.claimed;
    }

    /*//////////////////////////////////////////////////////////////
                                 FUNDING
    //////////////////////////////////////////////////////////////*/

    function openChannel(uint256 agentId, address token, uint256 amount)
        external
        nonReentrant
        returns (uint256 channelId)
    {
        if (amount == 0) revert ZeroAmount();
        channelId = _nextChannelId++;
        _channels[channelId] =
            Channel({client: msg.sender, token: token, agentId: agentId, deposited: amount.toUint128(), claimed: 0, closesAt: 0});

        IERC20(token).transferFromExact(msg.sender, address(this), amount);
        emit ChannelOpened(channelId, agentId, msg.sender, token, amount);
    }

    function topUp(uint256 channelId, uint256 amount) external nonReentrant {
        Channel storage c = _channels[channelId];
        if (c.client == address(0)) revert NoSuchChannel(channelId);
        if (c.closesAt != 0) revert ChannelClosing(channelId, c.closesAt);
        if (amount == 0) revert ZeroAmount();

        c.deposited += amount.toUint128();
        IERC20(c.token).transferFromExact(msg.sender, address(this), amount);
        emit ChannelFunded(channelId, amount, c.deposited);
    }

    /*//////////////////////////////////////////////////////////////
                                SETTLEMENT
    //////////////////////////////////////////////////////////////*/

    /// @notice Redeem the latest voucher and publish the work it covers.
    /// @param cumulativeAmount Total owed since the channel opened, not the delta. Monotonic
    ///        totals make every superseded voucher worthless without any nonce bookkeeping.
    /// @param receipts The batch this voucher pays for. Their hash must match the `workRoot`
    ///        the client signed, which is what makes the record bilateral rather than the
    ///        agent's unilateral claim about itself.
    function settle(
        uint256 channelId,
        uint256 cumulativeAmount,
        uint256 deadline,
        bytes calldata signature,
        Receipt[] calldata receipts
    ) external nonReentrant returns (uint256 paid) {
        Channel storage c = _channels[channelId];
        if (c.client == address(0)) revert NoSuchChannel(channelId);
        if (!ANIMA.isController(c.agentId, msg.sender)) revert NotAgentController(c.agentId, msg.sender);
        if (block.timestamp > deadline) revert VoucherExpired(deadline);
        if (cumulativeAmount <= c.claimed) revert NotMonotonic(cumulativeAmount, c.claimed);
        if (cumulativeAmount > c.deposited) revert ExceedsDeposit(cumulativeAmount, c.deposited);

        bytes32 workRoot = keccak256(abi.encode(receipts));
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(_VOUCHER_TYPEHASH, channelId, cumulativeAmount, workRoot, deadline))
        );
        if (!SignatureChecker.isValidSignatureNow(c.client, digest, signature)) revert InvalidSignature();

        paid = cumulativeAmount - c.claimed;
        c.claimed = cumulativeAmount.toUint128();

        bytes32 logRoot = keccak256(abi.encode(workLog[c.agentId], channelId, workRoot, cumulativeAmount));
        workLog[c.agentId] = logRoot;

        // Earnings go to the agent's own account, not its owner's wallet: an agent that funds
        // itself can pay for its own inference, top up its own bond, and buy its own tools.
        IERC20(c.token).transferExact(ANIMA.accountOf(c.agentId), paid);

        emit Settled(channelId, c.agentId, cumulativeAmount, paid, workRoot, logRoot);
        for (uint256 i; i < receipts.length; ++i) {
            Receipt calldata r = receipts[i];
            emit WorkReceipt(
                c.agentId, channelId, r.requestHash, r.responseHash, r.modelHash, r.units, r.attestationKind, r.attestation
            );
        }
    }

    /// @notice Convenience for building the digest a client must sign off-chain.
    function voucherDigest(uint256 channelId, uint256 cumulativeAmount, bytes32 workRoot, uint256 deadline)
        external
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(_VOUCHER_TYPEHASH, channelId, cumulativeAmount, workRoot, deadline)));
    }

    function workRootOf(Receipt[] calldata receipts) external pure returns (bytes32) {
        return keccak256(abi.encode(receipts));
    }

    /*//////////////////////////////////////////////////////////////
                                 CLOSING
    //////////////////////////////////////////////////////////////*/

    /// @notice Start closing. Opens the challenge window rather than paying out immediately,
    ///         so a client cannot take back money for work already delivered.
    function requestClose(uint256 channelId) external {
        Channel storage c = _channels[channelId];
        if (c.client == address(0)) revert NoSuchChannel(channelId);
        if (c.client != msg.sender) revert NotClient(channelId, msg.sender);
        if (c.closesAt != 0) revert ChannelClosing(channelId, c.closesAt);

        uint64 closesAt = uint64(block.timestamp) + CHALLENGE_WINDOW;
        c.closesAt = closesAt;
        emit CloseRequested(channelId, closesAt);
    }

    /// @notice Withdraw whatever the agent did not claim. Permissionless once the window has
    ///         passed — the refund is the client's regardless of who submits the transaction.
    function close(uint256 channelId) external nonReentrant returns (uint256 refunded) {
        Channel storage c = _channels[channelId];
        if (c.client == address(0)) revert NoSuchChannel(channelId);
        if (c.closesAt == 0) revert ChannelNotClosing(channelId);
        if (block.timestamp < c.closesAt) revert ChallengeWindowOpen(channelId, c.closesAt);

        refunded = c.deposited - c.claimed;
        address client = c.client;
        address token = c.token;

        c.deposited = c.claimed;

        if (refunded != 0) IERC20(token).transferExact(client, refunded);
        emit ChannelClosed(channelId, client, refunded);
    }
}
