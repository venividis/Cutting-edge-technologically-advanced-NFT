// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title AgentHandles — giving an agent a proper all-round account
 * @notice Verified off-chain identities bound to an ANIMA agent: an email address, a DNS
 *         domain, a DID, an ENS name, a social account, a libp2p mesh peer.
 *
 * @dev **Why an agent needs an email at all.** Roughly the entire consumer web gates signup on
 *      one flow: enter an address, receive a code, confirm. An agent without an inbox cannot
 *      complete it, so it cannot open accounts, recover them, or receive anything asynchronous —
 *      which is most of what "having an account" means. Agent-inbox providers solved the
 *      plumbing; SPF, DKIM and DMARC already make "this message really came from that domain"
 *      cryptographically checkable. What is missing is the other direction: a way for a
 *      *counterparty* to check that a given inbox belongs to a given agent, without asking the
 *      agent.
 *
 *      That is what this registry is. A verifier — an inbox provider, a DNS attester, a DID
 *      resolver — performs the challenge off-chain and records the result here. From then on
 *      "agent #7 controls the inbox atlas at example.com" is a public fact, and the mapping is enforced to
 *      be one-to-one so two agents cannot both claim it.
 *
 *      **Verification does not survive a sale.** The owner at attestation time is recorded, and
 *      {isFresh} returns false once the agent changes hands. This mirrors the rule the token
 *      itself applies to autonomy, and for the same reason: the credentials that actually
 *      control an inbox live in the agent's brain, and a buyer should re-establish that the
 *      handle still answers to them rather than inheriting a claim made about someone else.
 *
 *      **What a verifier attests to is off-chain and only as good as the verifier.** The
 *      registry records who said it, when, and until when. It does not pretend to have checked
 *      anything itself, and `evidenceHash` exists so the verifier's own record can be audited.
 */
contract AgentHandles is Ownable2Step {
    /*//////////////////////////////////////////////////////////////
                                  TYPES
    //////////////////////////////////////////////////////////////*/

    enum HandleKind {
        Email, //     an inbox address — the handle that unlocks the rest of the web
        Domain, //    "agents.example", SPF/DKIM/DMARC-backed
        DID, //       "did:pkh:eip155:1:0x...", "did:web:..."
        ENS, //       "atlas.eth"
        Social, //    "x.com/atlas", "github.com/atlas"
        MeshPeer, //  a libp2p peer id, e.g. a Sovereign Agent Mesh node identity
        Phone,
        ApiKeyId //   an opaque provider-side account identifier
    }

    struct Handle {
        HandleKind kind;
        address verifier;
        address ownerAtAttestation;
        uint64 verifiedAt;
        uint64 expiresAt; //  0 means no expiry
        bool revoked;
        bytes32 evidenceHash;
        string value;
    }

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    IERC721 public immutable AGENTS;

    /// @notice Verifiers are authorised per kind: an inbox provider should not be able to
    ///         certify DNS ownership just because it can certify email.
    mapping(HandleKind kind => mapping(address verifier => bool)) public isVerifier;

    mapping(uint256 agentId => Handle[]) private _handles;

    /// @notice keccak256(kind, value) => the agent currently holding it, or zero.
    mapping(bytes32 handleKey => uint256 agentId) public claimedBy;

    /*//////////////////////////////////////////////////////////////
                             EVENTS / ERRORS
    //////////////////////////////////////////////////////////////*/

    event VerifierSet(HandleKind indexed kind, address indexed verifier, bool allowed);
    event HandleAttested(
        uint256 indexed agentId,
        uint256 indexed index,
        HandleKind indexed kind,
        address verifier,
        string value,
        uint64 expiresAt,
        string evidenceURI,
        bytes32 evidenceHash
    );
    event HandleRevoked(uint256 indexed agentId, uint256 indexed index, address indexed by);

    error NotAVerifier(HandleKind kind, address caller);
    error NotAuthorised(uint256 agentId, address caller);
    error HandleTaken(bytes32 handleKey, uint256 heldBy);
    error NoSuchHandle(uint256 agentId, uint256 index);
    error AlreadyRevoked(uint256 agentId, uint256 index);
    error EmptyValue();
    error ExpiryInPast(uint64 expiresAt);

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    constructor(IERC721 agents_, address owner_) Ownable(owner_) {
        AGENTS = agents_;
    }

    function setVerifier(HandleKind kind, address verifier, bool allowed) external onlyOwner {
        isVerifier[kind][verifier] = allowed;
        emit VerifierSet(kind, verifier, allowed);
    }

    function handleKey(HandleKind kind, string memory value) public pure returns (bytes32) {
        return keccak256(abi.encode(uint8(kind), value));
    }

    /*//////////////////////////////////////////////////////////////
                                ATTESTING
    //////////////////////////////////////////////////////////////*/

    /// @notice Record that this agent controls an off-chain identity.
    /// @param value MUST already be normalised by the verifier — lowercased, punycode-decoded,
    ///        no display name. The registry hashes it verbatim, so an address differing only in
    ///        case would otherwise be a different handle and the uniqueness guarantee would be
    ///        void.
    /// @param evidenceHash Commitment to the verifier's own record of the challenge, so the
    ///        attestation can be audited later rather than merely believed.
    function attest(
        uint256 agentId,
        HandleKind kind,
        string calldata value,
        uint64 expiresAt,
        string calldata evidenceURI,
        bytes32 evidenceHash
    ) external returns (uint256 index) {
        if (!isVerifier[kind][msg.sender]) revert NotAVerifier(kind, msg.sender);
        if (bytes(value).length == 0) revert EmptyValue();
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert ExpiryInPast(expiresAt);

        address holder = AGENTS.ownerOf(agentId); // reverts for an agent that does not exist

        bytes32 key = handleKey(kind, value);
        uint256 heldBy = claimedBy[key];
        // One handle, one agent. Without this, two agents could both advertise the same inbox
        // and a counterparty checking "who controls this address" would get an ambiguous answer
        // — which is exactly the impersonation this registry exists to prevent.
        if (heldBy != 0 && heldBy != agentId) revert HandleTaken(key, heldBy);
        claimedBy[key] = agentId;

        index = _handles[agentId].length;
        _handles[agentId].push(
            Handle({
                kind: kind,
                verifier: msg.sender,
                ownerAtAttestation: holder,
                verifiedAt: uint64(block.timestamp),
                expiresAt: expiresAt,
                revoked: false,
                evidenceHash: evidenceHash,
                value: value
            })
        );

        emit HandleAttested(agentId, index, kind, msg.sender, value, expiresAt, evidenceURI, evidenceHash);
    }

    /// @notice Withdraw an attestation. Callable by the verifier that made it or by the agent's
    ///         current owner — a new owner must be able to disown a claim they did not make.
    function revoke(uint256 agentId, uint256 index) external {
        Handle[] storage list = _handles[agentId];
        if (index >= list.length) revert NoSuchHandle(agentId, index);
        Handle storage h = list[index];
        if (h.revoked) revert AlreadyRevoked(agentId, index);
        if (msg.sender != h.verifier && msg.sender != AGENTS.ownerOf(agentId)) {
            revert NotAuthorised(agentId, msg.sender);
        }

        h.revoked = true;
        bytes32 key = handleKey(h.kind, h.value);
        if (claimedBy[key] == agentId) claimedBy[key] = 0;

        emit HandleRevoked(agentId, index, msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                                 READING
    //////////////////////////////////////////////////////////////*/

    function handlesOf(uint256 agentId) external view returns (Handle[] memory) {
        return _handles[agentId];
    }

    function handleCount(uint256 agentId) external view returns (uint256) {
        return _handles[agentId].length;
    }

    /// @notice Whether an attestation is still worth anything: unrevoked, unexpired, and made
    ///         about the agent's *current* owner.
    function isFresh(uint256 agentId, uint256 index) public view returns (bool) {
        Handle[] storage list = _handles[agentId];
        if (index >= list.length) return false;
        Handle storage h = list[index];
        if (h.revoked) return false;
        if (h.expiresAt != 0 && block.timestamp > h.expiresAt) return false;
        // A verification made about the previous owner says nothing about the new one.
        return h.ownerAtAttestation == AGENTS.ownerOf(agentId);
    }

    /// @notice The question a counterparty actually asks: does this agent control this identity?
    function controls(uint256 agentId, HandleKind kind, string calldata value) external view returns (bool) {
        if (claimedBy[handleKey(kind, value)] != agentId) return false;
        Handle[] storage list = _handles[agentId];
        bytes32 key = handleKey(kind, value);
        for (uint256 i = list.length; i > 0; --i) {
            Handle storage h = list[i - 1];
            if (handleKey(h.kind, h.value) == key) return isFresh(agentId, i - 1);
        }
        return false;
    }

    /// @notice Reverse lookup: which agent, if any, holds this identity.
    function agentFor(HandleKind kind, string calldata value) external view returns (uint256) {
        return claimedBy[handleKey(kind, value)];
    }
}
