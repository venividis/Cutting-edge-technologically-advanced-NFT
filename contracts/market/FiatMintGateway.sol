// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IAnima, ModelIdentity, BrainShard, SealPolicy} from "../interfaces/IAnima.sol";
import {MetadataEntry} from "../interfaces/IERC8004.sol";
import {ExactERC20} from "../libraries/ExactERC20.sol";

/**
 * @title FiatMintGateway — atomic fulfilment for cash-funded ANIMA purchases
 * @notice A payment processor records a completed fiat payment by minting an NFT and funding
 *         its ERC-6551 account with aUSD (or another configured dollar asset) in one transaction.
 *
 * @dev Card and bank payments cannot be verified by the EVM. A deliberately explicit processor
 *      role is therefore the trust boundary: it calls this contract only after payment is final.
 *      The on-chain reserve must separately approve this gateway for the promised stablecoins.
 *      Unique settlement ids make webhook retries harmless, and `minimumNetAmount` protects the
 *      customer's quote from an unexpectedly large fee or changed conversion amount.
 */
contract FiatMintGateway is Ownable2Step, ReentrancyGuardTransient {
    using ExactERC20 for IERC20;

    struct Purchase {
        bytes32 settlementId;
        address recipient;
        uint256 cashAmountUsdCents;
        uint256 stableAmount;
        uint256 minimumNetAmount;
        uint16 feeBps;
        string agentURI;
        bytes32 manifestHash;
        ModelIdentity model;
        BrainShard[] shards;
        SealPolicy seal;
        MetadataEntry[] metadata;
    }

    uint16 public constant MAX_FEE_BPS = 1_000; // permanent 10% safety ceiling
    uint256 private constant BPS = 10_000;

    IAnima public immutable ANIMA;
    IERC20 public immutable AUSD;
    address public immutable FUNDING_SOURCE;
    address public feeRecipient;

    mapping(address processor => bool) public isProcessor;
    mapping(bytes32 settlementId => bool) public settled;

    event ProcessorSet(address indexed processor, bool allowed);
    event FeeRecipientSet(address indexed feeRecipient);
    event FiatPurchaseSettled(
        bytes32 indexed settlementId,
        uint256 indexed agentId,
        address indexed recipient,
        uint256 cashAmountUsdCents,
        uint256 grossStableAmount,
        uint256 feeAmount,
        uint256 netStableAmount,
        address agentAccount
    );

    error NotProcessor(address caller);
    error InvalidSettlementId();
    error SettlementAlreadyUsed(bytes32 settlementId);
    error InvalidAmount();
    error FeeTooHigh(uint16 feeBps);
    error NetAmountBelowMinimum(uint256 netAmount, uint256 minimumNetAmount);
    error ZeroAddress();

    constructor(IAnima anima_, IERC20 ausd_, address fundingSource_, address feeRecipient_, address owner_)
        Ownable(owner_)
    {
        if (
            address(anima_) == address(0) || address(ausd_) == address(0) || fundingSource_ == address(0)
                || feeRecipient_ == address(0) || owner_ == address(0)
        ) revert ZeroAddress();
        ANIMA = anima_;
        AUSD = ausd_;
        FUNDING_SOURCE = fundingSource_;
        feeRecipient = feeRecipient_;
    }

    modifier onlyProcessor() {
        if (!isProcessor[msg.sender]) revert NotProcessor(msg.sender);
        _;
    }

    function setProcessor(address processor, bool allowed) external onlyOwner {
        if (processor == address(0)) revert ZeroAddress();
        isProcessor[processor] = allowed;
        emit ProcessorSet(processor, allowed);
    }

    function setFeeRecipient(address recipient) external onlyOwner {
        if (recipient == address(0)) revert ZeroAddress();
        feeRecipient = recipient;
        emit FeeRecipientSet(recipient);
    }

    /// @notice Fulfil one final fiat payment. The processor supplies stablecoin quote output;
    ///         `stableAmount` is gross and the token-bound account receives the computed net.
    function settleAndMint(Purchase calldata purchase)
        external
        onlyProcessor
        nonReentrant
        returns (uint256 agentId, address agentAccount, uint256 netAmount)
    {
        if (purchase.settlementId == bytes32(0)) revert InvalidSettlementId();
        if (settled[purchase.settlementId]) revert SettlementAlreadyUsed(purchase.settlementId);
        if (purchase.recipient == address(0)) revert ZeroAddress();
        if (purchase.cashAmountUsdCents == 0 || purchase.stableAmount == 0) revert InvalidAmount();
        if (purchase.feeBps > MAX_FEE_BPS) revert FeeTooHigh(purchase.feeBps);

        uint256 feeAmount = (purchase.stableAmount * purchase.feeBps) / BPS;
        netAmount = purchase.stableAmount - feeAmount;
        if (netAmount < purchase.minimumNetAmount) {
            revert NetAmountBelowMinimum(netAmount, purchase.minimumNetAmount);
        }

        // Effects precede external calls; any downstream revert rolls this marker back.
        settled[purchase.settlementId] = true;
        agentId = ANIMA.mintAgent(
            purchase.recipient,
            purchase.agentURI,
            purchase.manifestHash,
            purchase.model,
            purchase.shards,
            purchase.seal,
            purchase.metadata
        );
        agentAccount = ANIMA.deployAccount(agentId);

        AUSD.transferFromExact(FUNDING_SOURCE, agentAccount, netAmount);
        AUSD.transferFromExact(FUNDING_SOURCE, feeRecipient, feeAmount);

        emit FiatPurchaseSettled(
            purchase.settlementId,
            agentId,
            purchase.recipient,
            purchase.cashAmountUsdCents,
            purchase.stableAmount,
            feeAmount,
            netAmount,
            agentAccount
        );
    }
}
