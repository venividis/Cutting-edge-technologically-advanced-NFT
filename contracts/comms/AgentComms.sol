// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IAnima} from "../interfaces/IAnima.sol";

interface IAnimaCommsView {
    function isController(uint256 agentId, address account) external view returns (bool);
    function accountOf(uint256 agentId) external view returns (address);
    function keyRegistry() external view returns (address);
}

/**
 * @title AgentComms — a market for agent attention
 * @notice Agent-to-agent messaging where the sender is provably a specific agent, the
 *         payload stays off-chain and encrypted, and a reply is a paid obligation rather
 *         than a hope.
 *
 * @dev Most "on-chain chat" is a string in an event, which is a worse version of a database
 *      and gets used by nobody. The parts of messaging that genuinely need a blockchain are
 *      narrow, and this contract implements only those:
 *
 *      **Authenticated identity.** A message carries `fromAgentId`, and the contract checks
 *      the sender actually controls that agent. Agent impersonation is otherwise trivial and
 *      is the attack that breaks every agent-to-agent protocol that assumes good faith.
 *
 *      **Priced attention with a refund.** An agent sets its own postage. A sender escrows
 *      it, and the agent collects it *only by replying* — if the reply window lapses, the
 *      sender takes the money back. Spam becomes expensive and ignoring paid mail becomes
 *      unprofitable, without anyone running a moderation service.
 *
 *      **Commitment, not content.** Only `keccak256(ciphertext)` and a transport URI go
 *      on-chain. The payload rides XMTP, Waku, or plain HTTPS, encrypted to the recipient's
 *      key from the {EncryptionKeyRegistry}. On-chain bytes are the most expensive storage
 *      ever built and the least private; putting conversations there is a category error.
 *
 *      What this deliberately does not do is ordering or delivery guarantees. Those are the
 *      transport's job, and a contract that pretended to provide them would be lying.
 */
contract AgentComms is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /*//////////////////////////////////////////////////////////////
                                  TYPES
    //////////////////////////////////////////////////////////////*/

    struct Inbox {
        address feeToken; //     zero means the agent accepts no paid mail
        uint128 postage; //      what it costs to be read
        uint64 replyWindow; //   reply within this or the sender is refunded
        bool open; //            false: only allowlisted senders may write at all
        bool configured;
    }

    struct Message {
        uint256 fromAgentId; //  zero when the sender is a plain account, not an agent
        address sender;
        uint256 toAgentId;
        uint128 postage;
        address feeToken;
        uint64 sentAt;
        uint64 replyBy;
        bool answered;
        bool refunded;
        bytes32 payloadHash;
        bytes32 threadId;
    }

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    uint64 public constant MIN_REPLY_WINDOW = 5 minutes;
    uint64 public constant MAX_REPLY_WINDOW = 30 days;

    IERC721 public immutable AGENTS;
    IAnimaCommsView public immutable ANIMA;

    mapping(uint256 agentId => Inbox) public inboxOf;
    mapping(uint256 agentId => mapping(address sender => bool)) public isAllowed;
    mapping(uint256 agentId => mapping(uint256 senderAgentId => bool)) public isAllowedAgent;

    uint256 private _nextMessageId = 1;
    mapping(uint256 messageId => Message) private _messages;

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event InboxConfigured(uint256 indexed agentId, address feeToken, uint128 postage, uint64 replyWindow, bool open);
    event SenderAllowed(uint256 indexed agentId, address indexed sender, bool allowed);
    event AgentSenderAllowed(uint256 indexed agentId, uint256 indexed senderAgentId, bool allowed);

    /// @param transportURI Where the ciphertext lives: an XMTP topic, a Waku content topic,
    ///        an ipfs:// CID, or an https:// endpoint. Consumers MUST verify the fetched
    ///        bytes hash to `payloadHash` before trusting a word of it.
    event MessageSent(
        uint256 indexed messageId,
        uint256 indexed toAgentId,
        uint256 indexed fromAgentId,
        address sender,
        bytes32 threadId,
        bytes32 payloadHash,
        uint128 postage,
        uint64 replyBy,
        string transportURI
    );
    event MessageAnswered(
        uint256 indexed messageId, uint256 indexed toAgentId, bytes32 payloadHash, uint256 postage, string transportURI
    );
    event PostageRefunded(uint256 indexed messageId, address indexed to, uint256 amount);
    event Broadcast(uint256 indexed fromAgentId, bytes32 indexed topic, bytes32 payloadHash, string transportURI);

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error NotAgentOwner(uint256 agentId, address caller);
    error NotAgentController(uint256 agentId, address caller);
    error InboxClosed(uint256 agentId);
    error SenderNotAllowed(uint256 agentId, address sender);
    error NoSuchMessage(uint256 messageId);
    error AlreadyAnswered(uint256 messageId);
    error AlreadyRefunded(uint256 messageId);
    error ReplyWindowClosed(uint64 replyBy);
    error ReplyWindowOpen(uint64 replyBy);
    error BadReplyWindow(uint64 window);
    error EmptyPayload();

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    constructor(IERC721 agents_, IAnimaCommsView anima_) {
        AGENTS = agents_;
        ANIMA = anima_;
    }

    function messageOf(uint256 messageId) external view returns (Message memory) {
        return _messages[messageId];
    }

    /*//////////////////////////////////////////////////////////////
                                 INBOX
    //////////////////////////////////////////////////////////////*/

    function configureInbox(uint256 agentId, address feeToken, uint128 postage, uint64 replyWindow, bool open)
        external
    {
        if (AGENTS.ownerOf(agentId) != msg.sender) revert NotAgentOwner(agentId, msg.sender);
        if (replyWindow < MIN_REPLY_WINDOW || replyWindow > MAX_REPLY_WINDOW) revert BadReplyWindow(replyWindow);
        inboxOf[agentId] =
            Inbox({feeToken: feeToken, postage: postage, replyWindow: replyWindow, open: open, configured: true});
        emit InboxConfigured(agentId, feeToken, postage, replyWindow, open);
    }

    function setSenderAllowed(uint256 agentId, address sender, bool allowed) external {
        if (AGENTS.ownerOf(agentId) != msg.sender) revert NotAgentOwner(agentId, msg.sender);
        isAllowed[agentId][sender] = allowed;
        emit SenderAllowed(agentId, sender, allowed);
    }

    /// @notice Allow another *agent* to write, by id rather than by address. Agents rotate
    ///         session keys; an address allowlist would have to be rewritten every time.
    function setAgentSenderAllowed(uint256 agentId, uint256 senderAgentId, bool allowed) external {
        if (AGENTS.ownerOf(agentId) != msg.sender) revert NotAgentOwner(agentId, msg.sender);
        isAllowedAgent[agentId][senderAgentId] = allowed;
        emit AgentSenderAllowed(agentId, senderAgentId, allowed);
    }

    /*//////////////////////////////////////////////////////////////
                                  SEND
    //////////////////////////////////////////////////////////////*/

    /// @notice Write to an agent, escrowing its postage.
    /// @param fromAgentId The agent you are writing *as*, or zero to write as yourself. The
    ///        contract verifies you control it, which is what makes the identity worth
    ///        anything to the recipient.
    /// @param threadId Free-form conversation key. Reuse it to continue a thread; derive it
    ///        however you like — this contract never interprets it.
    function send(
        uint256 toAgentId,
        uint256 fromAgentId,
        bytes32 threadId,
        bytes32 payloadHash,
        string calldata transportURI
    ) external nonReentrant returns (uint256 messageId) {
        if (payloadHash == bytes32(0)) revert EmptyPayload();
        AGENTS.ownerOf(toAgentId); // reverts for an agent that does not exist

        if (fromAgentId != 0 && !ANIMA.isController(fromAgentId, msg.sender)) {
            revert NotAgentController(fromAgentId, msg.sender);
        }

        Inbox memory box = inboxOf[toAgentId];
        if (!box.configured) revert InboxClosed(toAgentId);
        if (!box.open) {
            bool permitted =
                isAllowed[toAgentId][msg.sender] || (fromAgentId != 0 && isAllowedAgent[toAgentId][fromAgentId]);
            if (!permitted) revert SenderNotAllowed(toAgentId, msg.sender);
        }

        messageId = _nextMessageId++;
        uint64 replyBy = uint64(block.timestamp) + box.replyWindow;

        _messages[messageId] = Message({
            fromAgentId: fromAgentId,
            sender: msg.sender,
            toAgentId: toAgentId,
            postage: box.postage,
            feeToken: box.feeToken,
            sentAt: uint64(block.timestamp),
            replyBy: replyBy,
            answered: false,
            refunded: false,
            payloadHash: payloadHash,
            threadId: threadId
        });

        if (box.postage != 0) {
            IERC20(box.feeToken).safeTransferFrom(msg.sender, address(this), box.postage);
        }

        emit MessageSent(
            messageId, toAgentId, fromAgentId, msg.sender, threadId, payloadHash, box.postage, replyBy, transportURI
        );
    }

    /*//////////////////////////////////////////////////////////////
                                 REPLY
    //////////////////////////////////////////////////////////////*/

    /// @notice Answer a message and collect its postage. Paid to the agent's own account, so
    ///         an agent's correspondence funds the agent rather than its owner's wallet.
    function reply(uint256 messageId, bytes32 payloadHash, string calldata transportURI) external nonReentrant {
        Message storage m = _messages[messageId];
        if (m.sender == address(0)) revert NoSuchMessage(messageId);
        if (m.answered) revert AlreadyAnswered(messageId);
        if (m.refunded) revert AlreadyRefunded(messageId);
        if (block.timestamp > m.replyBy) revert ReplyWindowClosed(m.replyBy);
        if (!ANIMA.isController(m.toAgentId, msg.sender)) revert NotAgentController(m.toAgentId, msg.sender);
        if (payloadHash == bytes32(0)) revert EmptyPayload();

        m.answered = true;
        uint256 postage = m.postage;

        if (postage != 0) {
            IERC20(m.feeToken).safeTransfer(ANIMA.accountOf(m.toAgentId), postage);
        }

        emit MessageAnswered(messageId, m.toAgentId, payloadHash, postage, transportURI);
    }

    /// @notice Reclaim postage from a message that was never answered. Permissionless, so a
    ///         sender is never left chasing an unresponsive agent for their own money.
    function refund(uint256 messageId) external nonReentrant {
        Message storage m = _messages[messageId];
        if (m.sender == address(0)) revert NoSuchMessage(messageId);
        if (m.answered) revert AlreadyAnswered(messageId);
        if (m.refunded) revert AlreadyRefunded(messageId);
        if (block.timestamp <= m.replyBy) revert ReplyWindowOpen(m.replyBy);

        m.refunded = true;
        uint256 postage = m.postage;
        if (postage != 0) {
            IERC20(m.feeToken).safeTransfer(m.sender, postage);
        }
        emit PostageRefunded(messageId, m.sender, postage);
    }

    /*//////////////////////////////////////////////////////////////
                                BROADCAST
    //////////////////////////////////////////////////////////////*/

    /// @notice Publish an authenticated public message from an agent. No postage, no
    ///         recipient — the agent-to-many channel for status, offers and results.
    function broadcast(uint256 fromAgentId, bytes32 topic, bytes32 payloadHash, string calldata transportURI)
        external
    {
        if (!ANIMA.isController(fromAgentId, msg.sender)) revert NotAgentController(fromAgentId, msg.sender);
        if (payloadHash == bytes32(0)) revert EmptyPayload();
        emit Broadcast(fromAgentId, topic, payloadHash, transportURI);
    }
}
