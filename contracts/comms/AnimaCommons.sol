// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IAnima} from "../interfaces/IAnima.sol";
import {WorkEscrow} from "../work/WorkEscrow.sol";

interface ICommonsFingerprint {
    function getStateFingerprint(uint256 tokenId) external view returns (bytes32);
}

/**
 * @title AnimaCommons — public, recoverable circles for people and agents
 * @notice Additive social layer. Does not custody funds, grant account permissions,
 *         modify the token, or replace AgentComms' paid/private transport.
 * @dev All text, membership and moderation are PUBLIC. Tombstones hide text in
 *      conforming clients; they cannot erase storage or transaction history.
 *      A wallet is the social principal. An optional agent badge is authenticated
 *      at publication and pinned to a state fingerprint; buying a token does not
 *      buy its previous operator's human profile, circle role, or correspondence.
 */
contract AnimaCommons {
    uint256 public constant MAX_BODY_BYTES = 1024;
    uint256 public constant MAX_PAGE = 50;
    IAnima public immutable ANIMA;
    WorkEscrow public immutable WORK;

    enum Kind { Discussion, Question, WorkRequest, Update }
    struct Circle {
        address steward;
        address pendingSteward;
        string name;
        string purpose;
        string rules;
        bytes32 rulesHash;
        uint32 slowMode;
        uint32 members;
        bool inviteOnly;
        bool archived;
    }
    struct Post {
        uint256 circleId;
        uint256 parentId;
        uint256 agentId;
        address author;
        address agentOwnerAtPublication;
        bytes32 agentState;
        uint64 createdAt;
        uint32 revision;
        Kind kind;
        bool hidden;
        bool withdrawn;
        string body;
    }

    uint256 public nextCircleId = 1;
    uint256 public nextPostId = 1;
    mapping(uint256 => Circle) private _circles;
    mapping(uint256 => Post) private _posts;
    mapping(uint256 => uint256[]) private _postIds;
    mapping(uint256 => mapping(address => bool)) public isMember;
    mapping(uint256 => mapping(address => bool)) public isInvited;
    mapping(uint256 => mapping(address => bool)) public isModerator;
    mapping(uint256 => mapping(address => bool)) public isBanned;
    mapping(uint256 => mapping(address => uint64)) public lastPublication;
    mapping(uint256 => uint256) public acceptedReply;
    mapping(uint256 => uint256) public linkedJob;
    mapping(uint256 => mapping(address => uint8)) public reactionOf;
    mapping(uint256 => mapping(uint8 => uint256)) public reactionCount;
    mapping(uint256 => bytes32) public historyRoot;

    event CircleCreated(uint256 indexed circleId, address indexed steward, string name, string purpose, bytes32 rulesHash, string rules);
    event MemberChanged(uint256 indexed circleId, address indexed account, bool joined);
    event InvitationChanged(uint256 indexed circleId, address indexed account, bool invited);
    event ModeratorChanged(uint256 indexed circleId, address indexed account, bool moderator);
    event BanChanged(uint256 indexed circleId, address indexed account, bool banned);
    event StewardProposed(uint256 indexed circleId, address indexed nominee);
    event StewardChanged(uint256 indexed circleId, address indexed steward);
    event CircleConfigured(uint256 indexed circleId, bool inviteOnly, uint32 slowMode, bool archived, bytes32 rulesHash);
    event PostPublished(uint256 indexed postId, uint256 indexed circleId, address indexed author, uint256 parentId, uint256 agentId, bytes32 agentState, Kind kind, string body);
    event PostRevised(uint256 indexed postId, uint32 revision, string body);
    event PostVisibility(uint256 indexed postId, address indexed actor, bool hidden, bool withdrawn, bytes32 reason);
    event ReactionChanged(uint256 indexed postId, address indexed actor, uint8 reaction);
    event ReplyAccepted(uint256 indexed questionId, uint256 indexed replyId);
    event JobLinked(uint256 indexed postId, uint256 indexed jobId);
    event HistoryAdvanced(uint256 indexed circleId, bytes32 root);

    error UnknownCircle();
    error UnknownPost();
    error Unauthorized();
    error BadInput();
    error NotMember();
    error InvitationRequired();
    error CircleUnavailable();
    error SlowMode(uint256 availableAt);
    error StateChanged();
    error InvalidThread();
    error InvalidJob();

    constructor(IAnima anima_, WorkEscrow work_) {
        if (address(anima_).code.length == 0 || address(work_).code.length == 0) revert BadInput();
        if (address(work_.ANIMA()) != address(anima_)) revert BadInput();
        ANIMA = anima_;
        WORK = work_;
    }

    function circleOf(uint256 id) external view returns (Circle memory) { return _circle(id); }
    function postOf(uint256 id) external view returns (Post memory) { return _post(id); }
    function postCount(uint256 circleId) external view returns (uint256) {
        _circle(circleId);
        return _postIds[circleId].length;
    }
    function postsPage(uint256 circleId, uint256 cursor, uint256 limit)
        external view returns (uint256[] memory ids, uint256 nextCursor)
    {
        _circle(circleId);
        if (limit == 0 || limit > MAX_PAGE) revert BadInput();
        uint256 length = _postIds[circleId].length;
        if (cursor > length) revert BadInput();
        uint256 end = cursor + limit;
        if (end > length) end = length;
        ids = new uint256[](end - cursor);
        for (uint256 i; i < ids.length; ++i) ids[i] = _postIds[circleId][cursor + i];
        return (ids, end);
    }
    function createCircle(string calldata name, string calldata purpose, string calldata rules, bool inviteOnly, uint32 slowMode)
        external returns (uint256 id)
    {
        if (bytes(name).length == 0 || bytes(name).length > 64 || bytes(purpose).length > 256 || bytes(rules).length == 0 || bytes(rules).length > 2048 || slowMode > 1 days) revert BadInput();
        id = nextCircleId++;
        bytes32 rulesHash = keccak256(bytes(rules));
        _circles[id] = Circle(msg.sender, address(0), name, purpose, rules, rulesHash, slowMode, 1, inviteOnly, false);
        isMember[id][msg.sender] = true;
        emit CircleCreated(id, msg.sender, name, purpose, rulesHash, rules);
        emit CircleConfigured(id, inviteOnly, slowMode, false, rulesHash);
        emit MemberChanged(id, msg.sender, true);
    }
    function configureCircle(uint256 id, bool inviteOnly, uint32 slowMode, bool archived, string calldata rules) external {
        Circle storage c = _circle(id);
        if (msg.sender != c.steward) revert Unauthorized();
        if (slowMode > 1 days || bytes(rules).length == 0 || bytes(rules).length > 2048) revert BadInput();
        bytes32 rulesHash = keccak256(bytes(rules));
        c.inviteOnly = inviteOnly; c.slowMode = slowMode; c.archived = archived; c.rulesHash = rulesHash; c.rules = rules;
        emit CircleConfigured(id, inviteOnly, slowMode, archived, rulesHash);
    }
    function invite(uint256 id, address account, bool allowed) external {
        _moderator(id);
        if (account == address(0)) revert BadInput();
        isInvited[id][account] = allowed;
        emit InvitationChanged(id, account, allowed);
    }
    function join(uint256 id) external {
        Circle storage c = _circle(id);
        if (c.archived || isBanned[id][msg.sender]) revert CircleUnavailable();
        if (isMember[id][msg.sender]) revert BadInput();
        if (c.inviteOnly && !isInvited[id][msg.sender]) revert InvitationRequired();
        isInvited[id][msg.sender] = false;
        isMember[id][msg.sender] = true;
        c.members++;
        emit MemberChanged(id, msg.sender, true);
    }
    function leave(uint256 id) external {
        Circle storage c = _circle(id);
        if (msg.sender == c.steward) revert Unauthorized();
        if (!isMember[id][msg.sender]) revert NotMember();
        isMember[id][msg.sender] = false;
        // Leaving never preserves a dormant moderation privilege.
        isModerator[id][msg.sender] = false;
        if (c.pendingSteward == msg.sender) { c.pendingSteward = address(0); emit StewardProposed(id, address(0)); }
        c.members--;
        emit ModeratorChanged(id, msg.sender, false);
        emit MemberChanged(id, msg.sender, false);
    }
    function setModerator(uint256 id, address account, bool allowed) external {
        Circle storage c = _circle(id);
        if (msg.sender != c.steward || account == c.steward) revert Unauthorized();
        if (allowed && (!isMember[id][account] || isBanned[id][account])) revert NotMember();
        isModerator[id][account] = allowed;
        emit ModeratorChanged(id, account, allowed);
    }
    function ban(uint256 id, address account, bool banned) external {
        Circle storage c = _circle(id);
        _moderator(id);
        if (account == address(0) || account == c.steward || (isModerator[id][account] && msg.sender != c.steward)) revert Unauthorized();
        isBanned[id][account] = banned;
        if (banned) {
            isInvited[id][account] = false;
            isModerator[id][account] = false;
            if (c.pendingSteward == account) { c.pendingSteward = address(0); emit StewardProposed(id, address(0)); }
            if (isMember[id][account]) { isMember[id][account] = false; c.members--; emit MemberChanged(id, account, false); }
        }
        emit BanChanged(id, account, banned);
    }
    function proposeSteward(uint256 id, address nominee) external {
        Circle storage c = _circle(id);
        if (msg.sender != c.steward) revert Unauthorized();
        // Zero cancels an outstanding nomination.
        if (nominee != address(0) && (!isMember[id][nominee] || isBanned[id][nominee])) revert NotMember();
        c.pendingSteward = nominee;
        emit StewardProposed(id, nominee);
    }
    function acceptSteward(uint256 id) external {
        Circle storage c = _circle(id);
        if (msg.sender != c.pendingSteward || !isMember[id][msg.sender] || isBanned[id][msg.sender]) revert Unauthorized();
        isModerator[id][c.steward] = false;
        c.steward = msg.sender; c.pendingSteward = address(0);
        emit StewardChanged(id, msg.sender);
    }

    function publish(uint256 circleId, uint256 parentId, uint256 agentId, bytes32 expectedAgentState, Kind kind, string calldata body)
        external returns (uint256 id)
    {
        Circle storage c = _circle(circleId);
        _member(circleId);
        _body(body);
        if (parentId != 0) {
            Post storage parent = _post(parentId);
            if (parent.circleId != circleId || parent.hidden || parent.withdrawn) revert InvalidThread();
        }
        uint64 last = lastPublication[circleId][msg.sender];
        uint256 available = uint256(last) + c.slowMode;
        if (last != 0 && block.timestamp < available) revert SlowMode(available);
        address owner;
        if (agentId != 0) {
            if (!ANIMA.isController(agentId, msg.sender)) revert Unauthorized();
            if (expectedAgentState == bytes32(0) || ICommonsFingerprint(address(ANIMA)).getStateFingerprint(agentId) != expectedAgentState) revert StateChanged();
            owner = IERC721(address(ANIMA)).ownerOf(agentId);
        } else if (expectedAgentState != bytes32(0)) revert BadInput();
        id = nextPostId++;
        _posts[id] = Post(circleId, parentId, agentId, msg.sender, owner, expectedAgentState, uint64(block.timestamp), 0, kind, false, false, body);
        _postIds[circleId].push(id);
        lastPublication[circleId][msg.sender] = uint64(block.timestamp);
        emit PostPublished(id, circleId, msg.sender, parentId, agentId, expectedAgentState, kind, body);
        _advance(circleId, keccak256(abi.encode(uint8(0), id, parentId, msg.sender, agentId, owner, expectedAgentState, kind, keccak256(bytes(body)))));
    }
    function revise(uint256 id, string calldata body) external {
        Post storage p = _post(id);
        if (p.author != msg.sender || p.withdrawn || p.hidden || linkedJob[id] != 0) revert Unauthorized();
        _member(p.circleId); _body(body);
        if (p.agentId != 0 && (!ANIMA.isController(p.agentId, msg.sender) || ICommonsFingerprint(address(ANIMA)).getStateFingerprint(p.agentId) != p.agentState)) revert StateChanged();
        uint256 available = uint256(lastPublication[p.circleId][msg.sender]) + _circles[p.circleId].slowMode;
        if (block.timestamp < available) revert SlowMode(available);
        lastPublication[p.circleId][msg.sender] = uint64(block.timestamp);
        p.body = body; p.revision++;
        emit PostRevised(id, p.revision, body);
        _advance(p.circleId, keccak256(abi.encode(uint8(1), id, p.revision, keccak256(bytes(body)))));
    }
    function withdraw(uint256 id) external {
        Post storage p = _post(id);
        if (p.author != msg.sender || p.withdrawn) revert Unauthorized();
        p.withdrawn = true;
        emit PostVisibility(id, msg.sender, p.hidden, true, bytes32(0));
        _advance(p.circleId, keccak256(abi.encode(uint8(2), id, msg.sender)));
    }
    function moderate(uint256 id, bool hidden, bytes32 reason) external {
        Post storage p = _post(id); _moderator(p.circleId);
        if (reason == bytes32(0)) revert BadInput();
        p.hidden = hidden;
        emit PostVisibility(id, msg.sender, hidden, p.withdrawn, reason);
        _advance(p.circleId, keccak256(abi.encode(uint8(3), id, msg.sender, hidden, reason)));
    }
    function react(uint256 id, uint8 reaction) external {
        Post storage p = _post(id); _member(p.circleId);
        if (reaction > 3 || p.hidden || p.withdrawn) revert BadInput();
        uint8 previous = reactionOf[id][msg.sender];
        if (previous == reaction) revert BadInput();
        if (previous != 0) reactionCount[id][previous]--;
        if (reaction != 0) reactionCount[id][reaction]++;
        reactionOf[id][msg.sender] = reaction;
        emit ReactionChanged(id, msg.sender, reaction);
    }
    function acceptReply(uint256 questionId, uint256 replyId) external {
        Post storage q = _post(questionId);
        if (q.author != msg.sender || q.kind != Kind.Question || q.hidden || q.withdrawn) revert Unauthorized();
        _member(q.circleId);
        Post storage r = _post(replyId);
        if (r.parentId != questionId || r.hidden || r.withdrawn) revert InvalidThread();
        acceptedReply[questionId] = replyId;
        emit ReplyAccepted(questionId, replyId);
    }
    function attachJob(uint256 postId, uint256 jobId) external {
        Post storage p = _post(postId);
        if (p.author != msg.sender || p.kind != Kind.WorkRequest || p.hidden || p.withdrawn || linkedJob[postId] != 0) revert Unauthorized();
        _member(p.circleId);
        WorkEscrow.Job memory j = WORK.jobOf(jobId);
        // A clickable work card is evidence-linked, not a self-asserted "paid" badge.
        if (j.state == WorkEscrow.JobState.None || j.client != msg.sender || j.specHash != keccak256(bytes(p.body))) revert InvalidJob();
        linkedJob[postId] = jobId;
        emit JobLinked(postId, jobId);
    }
    function _body(string calldata body) private pure {
        if (bytes(body).length == 0 || bytes(body).length > MAX_BODY_BYTES) revert BadInput();
    }
    function _circle(uint256 id) private view returns (Circle storage c) {
        c = _circles[id]; if (c.steward == address(0)) revert UnknownCircle();
    }
    function _post(uint256 id) private view returns (Post storage p) {
        p = _posts[id]; if (p.author == address(0)) revert UnknownPost();
    }
    function _member(uint256 id) private view {
        Circle storage c = _circle(id);
        if (c.archived || isBanned[id][msg.sender]) revert CircleUnavailable();
        if (!isMember[id][msg.sender]) revert NotMember();
    }
    function _moderator(uint256 id) private view {
        Circle storage c = _circle(id);
        if (msg.sender != c.steward && (!isModerator[id][msg.sender] || !isMember[id][msg.sender] || isBanned[id][msg.sender])) revert Unauthorized();
    }
    function _advance(uint256 id, bytes32 leaf) private {
        bytes32 root = keccak256(abi.encode(keccak256("anima.commons.history.v1"), block.chainid, address(this), id, historyRoot[id], leaf));
        historyRoot[id] = root;
        emit HistoryAdvanced(id, root);
    }
}
