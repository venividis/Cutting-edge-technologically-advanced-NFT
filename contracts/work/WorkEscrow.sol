// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IAnima} from "../interfaces/IAnima.sol";
import {BondVault} from "../registry/BondVault.sol";
import {ReputationRegistry} from "../registry/ReputationRegistry.sol";
import {ValidationRegistry} from "../registry/ValidationRegistry.sol";

interface IAnimaLocking {
    function lockAgent(uint256 agentId) external;
    function unlockAgent(uint256 agentId) external;
    function setDisputed(uint256 agentId, bool disputed) external;
    function accountOf(uint256 agentId) external view returns (address);
    function isController(uint256 agentId, address account) external view returns (bool);
}

/**
 * @title WorkEscrow — hiring an agent, with consequences
 * @notice The settlement loop that turns the rest of ANIMA into something a stranger can
 *         safely transact with: escrowed payment, reserved collateral, a delivery
 *         commitment, an independent validator, and feedback that only a real customer can
 *         write.
 *
 * @dev The state machine is designed around the observation that in any two-party escrow,
 *      *both* sides can grief the other by simply doing nothing. So every wait has a timer
 *      and every timer has a default winner:
 *
 *        - Client opens and funds a job → the agent may ignore it, so the client can
 *          withdraw at any time before acceptance. No lock-up for an offer nobody took.
 *        - Agent accepts → collateral is reserved and the agent becomes untradeable. It
 *          cannot be sold out from under the client mid-job.
 *        - Agent goes quiet past the deadline → the client is refunded *and* takes the
 *          reserved coverage. Missing a deadline costs money, not just standing.
 *        - Client goes quiet past the review window → the agent is paid automatically.
 *          Refusing to click "accept" is not a free option.
 *        - Client disputes → an independent validator named at open time decides. Neither
 *          party picks the referee after seeing the result.
 *
 *      Feedback is written here, not by the client directly, which is what lets the
 *      reputation registry mark it attested and weight it by the value actually settled.
 */
contract WorkEscrow is Ownable2Step, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /*//////////////////////////////////////////////////////////////
                                  TYPES
    //////////////////////////////////////////////////////////////*/

    enum JobState {
        None,
        Offered, //   funded by the client, not yet accepted
        Active, //    accepted; collateral reserved, agent locked
        Delivered, // agent submitted; client is in the review window
        Disputed, //  awaiting a validator's verdict
        Settled, //   terminal: someone got paid
        Cancelled //  terminal: refunded before acceptance
    }

    struct Job {
        uint256 agentId;
        address client;
        address payee; //             snapshotted at accept; cannot be redirected mid-job
        uint128 amount; //            escrowed payment
        uint128 coverage; //          bond reserved against failure
        uint64 deadline; //           deliver by
        uint64 reviewWindow; //       seconds the client has to accept or dispute
        uint64 deliveredAt;
        JobState state;
        address validator; //         named at open; decides disputes
        bytes32 specHash; //          commitment to what was asked for
        bytes32 deliveryHash; //      commitment to what was handed over
        bytes32 validationRequest;
    }

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    uint64 public constant MIN_REVIEW_WINDOW = 1 hours;
    uint64 public constant MAX_REVIEW_WINDOW = 30 days;
    uint16 public constant MAX_FEE_BPS = 1000; // 10%, a hard ceiling governance cannot exceed

    IERC20 public immutable ASSET;
    IAnima public immutable ANIMA;
    BondVault public immutable BONDS;
    ReputationRegistry public immutable REPUTATION;
    ValidationRegistry public immutable VALIDATION;

    uint16 public feeBps;
    address public feeRecipient;

    uint256 private _nextJobId = 1;
    mapping(uint256 jobId => Job) private _jobs;
    mapping(bytes32 validationRequest => uint256 jobId) public jobOfValidation;

    /*//////////////////////////////////////////////////////////////
                             EVENTS / ERRORS
    //////////////////////////////////////////////////////////////*/

    event JobOffered(
        uint256 indexed jobId,
        uint256 indexed agentId,
        address indexed client,
        uint256 amount,
        uint256 coverage,
        uint64 deadline,
        address validator,
        bytes32 specHash,
        string specURI
    );
    event JobAccepted(uint256 indexed jobId, uint256 indexed agentId, address payee);
    event JobCancelled(uint256 indexed jobId);
    event JobDelivered(uint256 indexed jobId, bytes32 deliveryHash, string deliveryURI);
    event JobSettled(uint256 indexed jobId, address indexed paidTo, uint256 amount, uint256 fee, bool agentPaid);
    event JobDisputed(uint256 indexed jobId, bytes32 validationRequest, string reasonURI);
    event JobSlashed(uint256 indexed jobId, uint256 indexed agentId, uint256 coverage);
    event FeeSet(uint16 feeBps, address recipient);
    event FeedbackSkipped(uint256 indexed jobId, uint256 indexed agentId);

    error BadState(uint256 jobId, JobState state);
    error NotClient(uint256 jobId, address caller);
    error NotAgentController(uint256 jobId, address caller);
    error DeadlinePassed(uint64 deadline);
    error DeadlineNotPassed(uint64 deadline);
    error ReviewOpen(uint64 until);
    error ReviewClosed(uint64 until);
    error BadReviewWindow(uint64 window);
    error FeeTooHigh(uint16 bps);
    error ZeroAmount();
    error ZeroAddress();
    error VerdictPending(bytes32 validationRequest);

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    constructor(
        IERC20 asset_,
        IAnima anima_,
        BondVault bonds_,
        ReputationRegistry reputation_,
        ValidationRegistry validation_,
        address owner_,
        uint16 feeBps_,
        address feeRecipient_
    ) Ownable(owner_) {
        ASSET = asset_;
        ANIMA = anima_;
        BONDS = bonds_;
        REPUTATION = reputation_;
        VALIDATION = validation_;
        _setFee(feeBps_, feeRecipient_);
    }

    function setFee(uint16 feeBps_, address recipient) external onlyOwner {
        _setFee(feeBps_, recipient);
    }

    function _setFee(uint16 feeBps_, address recipient) private {
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh(feeBps_);
        if (feeBps_ != 0 && recipient == address(0)) revert ZeroAddress();
        feeBps = feeBps_;
        feeRecipient = recipient;
        emit FeeSet(feeBps_, recipient);
    }

    function jobOf(uint256 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }

    /*//////////////////////////////////////////////////////////////
                                  OPEN
    //////////////////////////////////////////////////////////////*/

    /// @notice Fund a job offer for a specific agent.
    /// @param coverage How much of the agent's bond must stand behind this job. The client
    ///        chooses it; the agent either has it free or cannot accept. This is the number
    ///        that converts an agent's promise into a priced guarantee.
    function offerJob(
        uint256 agentId,
        uint256 amount,
        uint256 coverage,
        uint64 deadline,
        uint64 reviewWindow,
        address validator,
        bytes32 specHash,
        string calldata specURI
    ) external nonReentrant returns (uint256 jobId) {
        if (amount == 0) revert ZeroAmount();
        if (deadline <= block.timestamp) revert DeadlinePassed(deadline);
        if (reviewWindow < MIN_REVIEW_WINDOW || reviewWindow > MAX_REVIEW_WINDOW) revert BadReviewWindow(reviewWindow);

        jobId = _nextJobId++;
        Job storage j = _jobs[jobId];
        j.agentId = agentId;
        j.client = msg.sender;
        j.amount = amount.toUint128();
        j.coverage = coverage.toUint128();
        j.deadline = deadline;
        j.reviewWindow = reviewWindow;
        j.validator = validator;
        j.specHash = specHash;
        j.state = JobState.Offered;

        ASSET.safeTransferFrom(msg.sender, address(this), amount);

        emit JobOffered(jobId, agentId, msg.sender, amount, coverage, deadline, validator, specHash, specURI);
    }

    /// @notice Withdraw an offer the agent never took. Available right up until acceptance,
    ///         so making an offer never risks funds being held hostage.
    function cancelOffer(uint256 jobId) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (j.state != JobState.Offered) revert BadState(jobId, j.state);
        if (j.client != msg.sender) revert NotClient(jobId, msg.sender);

        j.state = JobState.Cancelled;
        uint256 amount = j.amount;
        ASSET.safeTransfer(j.client, amount);
        emit JobCancelled(jobId);
    }

    /// @notice Take the job. Reserves collateral and locks the agent for the duration.
    /// @dev Acceptance is the agent's choice, which is why `offerJob` reserves nothing:
    ///      otherwise anyone could pin an agent's entire bond with a stream of offers it
    ///      never wanted — a denial-of-service on the agent's ability to earn.
    function acceptJob(uint256 jobId) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (j.state != JobState.Offered) revert BadState(jobId, j.state);
        if (block.timestamp >= j.deadline) revert DeadlinePassed(j.deadline);
        if (!IAnimaLocking(address(ANIMA)).isController(j.agentId, msg.sender)) {
            revert NotAgentController(jobId, msg.sender);
        }

        j.state = JobState.Active;
        // Snapshot the payout address now. Reading it at settlement would let an owner
        // redirect a job's proceeds after the work was already commissioned.
        j.payee = IAnimaLocking(address(ANIMA)).accountOf(j.agentId);

        if (j.coverage != 0) BONDS.reserve(j.agentId, j.coverage);
        IAnimaLocking(address(ANIMA)).lockAgent(j.agentId);

        emit JobAccepted(jobId, j.agentId, j.payee);
    }

    /*//////////////////////////////////////////////////////////////
                              DELIVER / SETTLE
    //////////////////////////////////////////////////////////////*/

    function deliver(uint256 jobId, bytes32 deliveryHash, string calldata deliveryURI) external {
        Job storage j = _jobs[jobId];
        if (j.state != JobState.Active) revert BadState(jobId, j.state);
        if (block.timestamp > j.deadline) revert DeadlinePassed(j.deadline);
        if (!IAnimaLocking(address(ANIMA)).isController(j.agentId, msg.sender)) {
            revert NotAgentController(jobId, msg.sender);
        }

        j.state = JobState.Delivered;
        j.deliveryHash = deliveryHash;
        j.deliveredAt = uint64(block.timestamp);
        emit JobDelivered(jobId, deliveryHash, deliveryURI);
    }

    /// @notice Client accepts the work: the agent is paid and gets attested feedback.
    /// @param rating Score in the client's own precision, e.g. 95 with `ratingDecimals` 0,
    ///        or 9500 with 2. Recorded weighted by the value actually settled.
    function acceptDelivery(
        uint256 jobId,
        int128 rating,
        uint8 ratingDecimals,
        string calldata tag,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (j.state != JobState.Delivered) revert BadState(jobId, j.state);
        if (j.client != msg.sender) revert NotClient(jobId, msg.sender);

        _payAgent(jobId, j);
        _fileFeedback(jobId, j, rating, ratingDecimals, tag, feedbackURI, feedbackHash);
    }

    /// @dev Filing feedback is deliberately NOT wrapped in try/catch.
    ///
    ///      An earlier version was, on the reasoning that an optional side effect should
    ///      never brick a settlement. That is sound in principle and wrong in practice:
    ///      `eth_estimateGas` binary-searches for the *cheapest* gas at which the call
    ///      succeeds, and with a swallowing catch the cheapest success is the one where the
    ///      inner call runs out of gas and the feedback is skipped. Every wallet-estimated
    ///      settlement would silently lose its reputation record, and nothing would look
    ///      wrong. A test caught it; a production deployment might not have.
    ///
    ///      Instead the one condition the registry actually rejects — the agent's own holder
    ///      posing as its customer — is checked here, explicitly. Anything else reverting is
    ///      a misconfiguration that deserves to be loud, and even then no money is trapped:
    ///      `claimUnreviewed` settles the same job without touching the registry.
    function _fileFeedbackSafely(
        uint256 agentId,
        address client,
        int128 rating,
        uint8 ratingDecimals,
        string calldata tag,
        string calldata feedbackURI,
        bytes32 feedbackHash,
        uint128 weight,
        bytes32 jobRef
    ) private {
        if (client == IERC721(address(ANIMA)).ownerOf(agentId)) {
            emit FeedbackSkipped(uint256(jobRef), agentId);
            return;
        }
        REPUTATION.giveAttestedFeedback(
            agentId, client, rating, ratingDecimals, tag, "", "", feedbackURI, feedbackHash, weight, jobRef
        );
    }

    /// @notice Settle in the agent's favour once the review window lapses with no response.
    ///         Permissionless: an agent should not need its client's cooperation to be paid
    ///         for work the client never complained about.
    function claimUnreviewed(uint256 jobId) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (j.state != JobState.Delivered) revert BadState(jobId, j.state);
        uint64 until = j.deliveredAt + j.reviewWindow;
        if (block.timestamp <= until) revert ReviewOpen(until);
        _payAgent(jobId, j);
    }

    /// @notice Refund the client and take the agent's coverage when a deadline is missed.
    ///         Permissionless for the same reason as above, in the other direction.
    function claimMissedDeadline(uint256 jobId) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (j.state != JobState.Active) revert BadState(jobId, j.state);
        if (block.timestamp <= j.deadline) revert DeadlineNotPassed(j.deadline);
        _refundClient(jobId, j, true);
    }

    /*//////////////////////////////////////////////////////////////
                                 DISPUTE
    //////////////////////////////////////////////////////////////*/

    /// @notice Contest a delivery within the review window. Opens a validation request with
    ///         the validator named when the job was created.
    /// @param contentHash Commitment to the complaint itself, as ERC-8004 intends.
    /// @dev The registry key is derived from the job rather than taken raw, so a client
    ///      cannot accidentally (or deliberately) collide with an existing request and make
    ///      their own dispute un-openable.
    function dispute(uint256 jobId, bytes32 contentHash, string calldata reasonURI) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (j.state != JobState.Delivered) revert BadState(jobId, j.state);
        if (j.client != msg.sender) revert NotClient(jobId, msg.sender);
        uint64 until = j.deliveredAt + j.reviewWindow;
        if (block.timestamp > until) revert ReviewClosed(until);
        if (j.validator == address(0)) revert ZeroAddress();

        bytes32 requestHash = keccak256(abi.encode(address(this), jobId, contentHash));

        j.state = JobState.Disputed;
        j.validationRequest = requestHash;
        jobOfValidation[requestHash] = jobId;

        IAnimaLocking(address(ANIMA)).setDisputed(j.agentId, true);
        VALIDATION.validationRequestWithExpiry(j.validator, j.agentId, reasonURI, requestHash, uint64(block.timestamp + 14 days));

        emit JobDisputed(jobId, requestHash, reasonURI);
    }

    /// @notice Apply the validator's verdict. Anyone may call once an answer exists.
    /// @dev If the validator never answers, `resolveStaleDispute` splits the difference
    ///      rather than letting the funds sit forever.
    function resolveDispute(uint256 jobId) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (j.state != JobState.Disputed) revert BadState(jobId, j.state);

        ValidationRegistry.Request memory r = VALIDATION.requestOf(j.validationRequest);
        if (!r.answered) revert VerdictPending(j.validationRequest);

        IAnimaLocking(address(ANIMA)).setDisputed(j.agentId, false);

        if (r.response >= VALIDATION.PASS_THRESHOLD()) {
            _payAgent(jobId, j);
        } else {
            _refundClient(jobId, j, true);
        }
    }

    /// @notice Escape hatch for a validator that never responds: the client is refunded but
    ///         the agent's collateral is returned untouched. Nobody proved anything, so
    ///         nobody is punished — the money simply goes home.
    function resolveStaleDispute(uint256 jobId) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (j.state != JobState.Disputed) revert BadState(jobId, j.state);

        ValidationRegistry.Request memory r = VALIDATION.requestOf(j.validationRequest);
        if (r.answered || block.timestamp <= r.expiry) revert VerdictPending(j.validationRequest);

        IAnimaLocking(address(ANIMA)).setDisputed(j.agentId, false);
        _refundClient(jobId, j, false);
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNALS
    //////////////////////////////////////////////////////////////*/

    function _payAgent(uint256 jobId, Job storage j) private {
        uint256 amount = j.amount;
        uint256 coverage = j.coverage;
        uint256 agentId = j.agentId;
        address payee = j.payee;

        j.state = JobState.Settled;

        _releaseHold(agentId, coverage);

        uint256 fee = (amount * feeBps) / 10_000;
        uint256 net = amount - fee;
        if (fee != 0) ASSET.safeTransfer(feeRecipient, fee);
        ASSET.safeTransfer(payee, net);

        emit JobSettled(jobId, payee, net, fee, true);
    }

    function _refundClient(uint256 jobId, Job storage j, bool slashCoverage) private {
        uint256 amount = j.amount;
        uint256 coverage = j.coverage;
        uint256 agentId = j.agentId;
        address client = j.client;

        j.state = JobState.Settled;

        _releaseHold(agentId, coverage);

        // Slashing happens after the reservation is released so the vault draws from free
        // collateral first, leaving other clients' reserved coverage intact.
        if (slashCoverage && coverage != 0) {
            uint256 slashable = BONDS.slashableOf(agentId);
            uint256 toSlash = coverage < slashable ? coverage : slashable;
            if (toSlash != 0) {
                BONDS.slash(agentId, toSlash, client, bytes32(jobId));
                emit JobSlashed(jobId, agentId, toSlash);
            }
        }

        ASSET.safeTransfer(client, amount);
        emit JobSettled(jobId, client, amount, 0, false);
    }

    /// @dev Both calls are clamped to the vault's actual state. An earlier slash on another
    ///      job can legitimately have eaten into this job's reservation; releasing more than
    ///      exists would revert and strand the escrowed payment forever.
    function _releaseHold(uint256 agentId, uint256 coverage) private {
        if (coverage != 0) {
            uint256 reserved = BONDS.bondOf(agentId).reserved;
            uint256 toRelease = coverage < reserved ? coverage : reserved;
            if (toRelease != 0) BONDS.release(agentId, toRelease);
        }
        IAnimaLocking(address(ANIMA)).unlockAgent(agentId);
    }

    function _fileFeedback(
        uint256 jobId,
        Job storage j,
        int128 rating,
        uint8 ratingDecimals,
        string calldata tag,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) private {
        _fileFeedbackSafely(
            j.agentId, j.client, rating, ratingDecimals, tag, feedbackURI, feedbackHash, j.amount, bytes32(jobId)
        );
    }
}
