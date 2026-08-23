// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/interfaces/IERC721Receiver.sol";
import {IERC1155Receiver} from "@openzeppelin/contracts/interfaces/IERC1155Receiver.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {PackedUserOperation} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {IERC6551Account, IERC6551Executable} from "../interfaces/IERC6551.sol";
import {IAnima, AgentStatus, AutonomyPolicy} from "../interfaces/IAnima.sol";

/**
 * @title AgentAccount — the agent's own wallet, with a leash its owner can prove
 * @notice An ERC-6551 token bound account whose *session keys* — the keys an autonomous
 *         agent actually runs with — are bounded by the {AutonomyPolicy} published on the
 *         agent token. The owner keeps unrestricted control; the agent gets a budget.
 *
 * @dev The distinction this contract exists to make:
 *
 *      - **The owner** signs with their own wallet and is unrestricted. They can always
 *        rescue funds, even from a paused agent.
 *      - **The agent** signs with a session key. Every call it makes is checked against a
 *        per-session budget, a rolling daily cap, a per-transaction ceiling, a target
 *        allowlist, and the agent's live status. A paused agent cannot spend at all.
 *
 *      That asymmetry is the whole point. "Give the AI a wallet" is trivial; giving it a
 *      wallet whose limits a counterparty can read *before* trading with it is not, and it
 *      is what makes an autonomous agent safe to interact with.
 *
 *      Two footguns handled explicitly:
 *
 *      1. **Ownership cycles.** If the agent token ends up owned by this very account,
 *         `owner()` returns zero rather than allowing a self-authorising loop.
 *      2. **Selling a drained agent.** `state()` increments on every state-changing call,
 *         so a buyer can pin the exact account state their price was quoted against and
 *         have the purchase revert if the seller emptied it in between.
 */
contract AgentAccount is
    IERC165,
    IERC1271,
    IERC6551Account,
    IERC6551Executable,
    IERC721Receiver,
    IERC1155Receiver,
    ReentrancyGuardTransient
{
    /*//////////////////////////////////////////////////////////////
                                  TYPES
    //////////////////////////////////////////////////////////////*/

    struct Session {
        uint64 validAfter;
        uint64 validUntil;
        uint128 spendCapWei; //  lifetime native budget for this key
        uint128 spentWei;
        bool revoked;
        /// @dev The owner who granted it. A session is void the moment the agent changes
        ///      hands, which is the same rule the token applies to operators and autonomy —
        ///      and necessary for the same reason: otherwise a seller keeps a live, funded key
        ///      on the buyer's wallet, invisible to every integrity check the sale performed.
        address grantedBy;
    }

    struct Call {
        address to;
        uint256 value;
        bytes data;
    }

    /*//////////////////////////////////////////////////////////////
                                CONSTANTS
    //////////////////////////////////////////////////////////////*/

    bytes4 internal constant MAGIC_VALUE_SIGNER = 0x523e3260; // IERC6551Account.isValidSigner.selector
    bytes4 internal constant MAGIC_VALUE_1271 = 0x1626ba7e;
    uint256 internal constant SIG_VALIDATION_FAILED = 1;
    uint256 internal constant SIG_VALIDATION_SUCCESS = 0;

    /// @dev ERC-6551 proxy footer layout: 10 (header) + 20 (impl) + 15 (footer) + 32 (salt)
    ///      = 77 bytes, after which sit chainId, tokenContract and tokenId.
    uint256 internal constant _FOOTER_OFFSET = 0x4d;

    address public immutable ENTRY_POINT;

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    uint256 private _state;

    mapping(address signer => Session) private _sessions;
    /// @dev Namespaced by the owner who set it, so a buyer inherits an empty allowlist rather
    ///      than whatever surface the seller opened up.
    mapping(address grantedBy => mapping(address target => mapping(bytes4 selector => bool))) private _allowedCall;

    uint64 private _spendDay;
    uint128 private _spentToday;

    /// @notice Head of a hash chain over every call this account has ever executed.
    /// @dev Provenance is the thing a second-hand agent is missing. A buyer can be handed
    ///      the full emitted `AuditEntry` log, replay the chain off-line, and check it ends
    ///      exactly here — so a seller cannot prune the embarrassing entries, splice in
    ///      flattering ones, or reorder history. One warm SSTORE per call buys a verifiable
    ///      operating record, which is worth considerably more than the gas.
    bytes32 public auditRoot;

    /*//////////////////////////////////////////////////////////////
                             EVENTS / ERRORS
    //////////////////////////////////////////////////////////////*/

    event SessionGranted(address indexed signer, uint64 validAfter, uint64 validUntil, uint128 spendCapWei);
    event SessionRevoked(address indexed signer);
    event CallAllowed(address indexed target, bytes4 indexed selector, bool allowed);
    event Executed(address indexed signer, address indexed to, uint256 value, bytes4 selector, uint8 operation);
    event AuditEntry(
        bytes32 indexed root,
        bytes32 previousRoot,
        address indexed signer,
        address indexed to,
        uint256 value,
        bytes4 selector,
        bytes32 dataHash,
        uint256 state
    );

    error NotAuthorized(address caller);
    error NotEntryPoint(address caller);
    error OwnershipCycle();
    error AgentNotActive(AgentStatus status);
    error PolicyExpired(uint64 expiry);
    error PerTxCapExceeded(uint256 value, uint128 cap);
    error DailyCapExceeded(uint256 wouldBe, uint128 cap);
    error SessionCapExceeded(uint256 wouldBe, uint128 cap);
    error SessionNotValid(address signer);
    error TargetNotAllowed(address to, bytes4 selector);
    error DelegateCallNotAllowed();
    error UnsupportedOperation(uint8 operation);
    error InvalidUserOpCallData();
    error UseExecuteUserOp();

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    /// @param entryPoint The ERC-4337 EntryPoint this account trusts, or zero to disable
    ///        the 4337 path entirely. Immutable in the implementation and therefore shared
    ///        by every ERC-1167 clone the registry deploys.
    constructor(address entryPoint) {
        ENTRY_POINT = entryPoint;
    }

    receive() external payable {}

    /*//////////////////////////////////////////////////////////////
                              ERC-6551 CORE
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IERC6551Account
    function token() public view returns (uint256 chainId, address tokenContract, uint256 tokenId) {
        bytes memory footer = new bytes(0x60);
        assembly ("memory-safe") {
            extcodecopy(address(), add(footer, 0x20), _FOOTER_OFFSET, 0x60)
        }
        return abi.decode(footer, (uint256, address, uint256));
    }

    /// @inheritdoc IERC6551Account
    function state() external view returns (uint256) {
        return _state;
    }

    /// @notice The current holder of the agent token, or zero if it is not held on this
    ///         chain or the account has been made to own itself.
    function owner() public view returns (address) {
        (uint256 chainId, address tokenContract, uint256 tokenId) = token();
        if (chainId != block.chainid) return address(0);
        address holder = IERC721(tokenContract).ownerOf(tokenId);
        // An account authorised by a token it itself holds would be a closed loop with no
        // human at the end of it.
        return holder == address(this) ? address(0) : holder;
    }

    function anima() public view returns (IAnima) {
        (, address tokenContract,) = token();
        return IAnima(tokenContract);
    }

    function agentId() public view returns (uint256 tokenId) {
        (,, tokenId) = token();
    }

    /// @inheritdoc IERC6551Account
    function isValidSigner(address signer, bytes calldata) external view returns (bytes4) {
        if (signer != address(0) && signer == owner()) return MAGIC_VALUE_SIGNER;
        return bytes4(0);
    }

    /*//////////////////////////////////////////////////////////////
                                 SESSIONS
    //////////////////////////////////////////////////////////////*/

    function sessionOf(address signer) external view returns (Session memory) {
        return _sessions[signer];
    }

    /// @notice Grant the agent a key to operate with. Owner only.
    function grantSession(address signer, uint64 validAfter, uint64 validUntil, uint128 spendCapWei) external {
        _requireOwner();
        if (signer == address(0)) revert NotAuthorized(signer);
        _sessions[signer] = Session({
            validAfter: validAfter,
            validUntil: validUntil,
            spendCapWei: spendCapWei,
            spentWei: 0,
            revoked: false,
            grantedBy: msg.sender
        });
        unchecked {
            ++_state;
        }
        emit SessionGranted(signer, validAfter, validUntil, spendCapWei);
    }

    /// @notice Revoke a session key immediately.
    /// @dev Callable by the owner *or* the agent's guardian, so the emergency stop does not
    ///      depend on the owner being awake.
    function revokeSession(address signer) external {
        address holder = owner();
        if (msg.sender != holder && msg.sender != anima().guardianOf(agentId())) revert NotAuthorized(msg.sender);
        _sessions[signer].revoked = true;
        unchecked {
            ++_state;
        }
        emit SessionRevoked(signer);
    }

    /// @notice Allowlist a (target, selector) pair for session keys. Owner only.
    /// @dev Bumps `state()`. Widening what a key may do is a change to this account's
    ///      authorisation surface, and a buyer pinning `expectedAccountState` is asking exactly
    ///      "has anything about this wallet changed since I quoted it?". A silent widening
    ///      would let a seller re-arm a dormant key after the pin was taken.
    function setAllowedCall(address target, bytes4 selector, bool allowed) external {
        _requireOwner();
        _allowedCall[msg.sender][target][selector] = allowed;
        unchecked {
            ++_state;
        }
        emit CallAllowed(target, selector, allowed);
    }

    /// @notice Whether session keys granted by the current owner may call this target.
    function allowedCall(address target, bytes4 selector) public view returns (bool) {
        address holder = owner();
        return holder != address(0) && _allowedCall[holder][target][selector];
    }

    function _requireOwner() private view {
        address holder = owner();
        if (holder == address(0)) revert OwnershipCycle();
        if (msg.sender != holder) revert NotAuthorized(msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                                EXECUTION
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IERC6551Executable
    function execute(address to, uint256 value, bytes calldata data, uint8 operation)
        external
        payable
        nonReentrant
        returns (bytes memory)
    {
        _authorize(msg.sender, to, value, data, operation, new bytes32[](0));
        unchecked {
            ++_state;
        }
        return _exec(msg.sender, to, value, data, operation);
    }

    /// @notice Execute against a target proven to be in the policy's merkle allowlist.
    /// @dev Lets an owner commit to a large allowlist in one 32-byte root instead of paying
    ///      for a storage slot per entry.
    function executeWithProof(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        bytes32[] calldata proof
    ) external payable nonReentrant returns (bytes memory) {
        _authorize(msg.sender, to, value, data, operation, proof);
        unchecked {
            ++_state;
        }
        return _exec(msg.sender, to, value, data, operation);
    }

    /// @notice Atomic batch. Agents plan multi-step actions; forcing them to be separate
    ///         transactions is what creates the half-executed states that lose money.
    function executeBatch(Call[] calldata calls) external payable nonReentrant returns (bytes[] memory results) {
        results = new bytes[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            _authorize(msg.sender, calls[i].to, calls[i].value, calls[i].data, 0, new bytes32[](0));
            results[i] = _exec(msg.sender, calls[i].to, calls[i].value, calls[i].data, 0);
        }
        unchecked {
            ++_state;
        }
    }

    function _exec(address signer, address to, uint256 value, bytes calldata data, uint8 operation)
        private
        returns (bytes memory result)
    {
        bool ok;
        if (operation == 0) {
            (ok, result) = to.call{value: value}(data);
        } else if (operation == 1) {
            (ok, result) = to.delegatecall(data);
        } else {
            revert UnsupportedOperation(operation);
        }
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(result, 0x20), mload(result))
            }
        }
        bytes4 sel = data.length >= 4 ? bytes4(data[:4]) : bytes4(0);
        _audit(signer, to, value, sel, keccak256(data), operation);
        emit Executed(signer, to, value, sel, operation);
    }

    /// @dev Chains chainId and this address into every link so a record from one deployment
    ///      can never be replayed as evidence about another.
    function _audit(address signer, address to, uint256 value, bytes4 selector, bytes32 dataHash, uint8 operation)
        private
    {
        bytes32 previous = auditRoot;
        bytes32 next = keccak256(
            abi.encode(
                previous, block.chainid, address(this), signer, to, value, selector, dataHash, operation, _state, block.timestamp
            )
        );
        auditRoot = next;
        emit AuditEntry(next, previous, signer, to, value, selector, dataHash, _state);
    }

    /*//////////////////////////////////////////////////////////////
                            POLICY ENFORCEMENT
    //////////////////////////////////////////////////////////////*/

    function _authorize(
        address caller,
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        bytes32[] memory proof
    ) private {
        // The EntryPoint is never a principal. An earlier version waved it through here on the
        // reasoning that `executeUserOp` had already charged the responsible session key — but
        // nothing forced a user operation to *use* `executeUserOp`. A session key could point
        // its callData straight at `execute`, arrive with `msg.sender == ENTRY_POINT`, and skip
        // every cap, the target allowlist, and the paused-agent check in one move. All ERC-4337
        // traffic must enter through `executeUserOp`, which resolves the real signer first.
        if (ENTRY_POINT != address(0) && caller == ENTRY_POINT) revert UseExecuteUserOp();

        address holder = owner();
        if (holder == address(0)) revert OwnershipCycle();

        // The owner is not on a leash. They must be able to rescue a paused or
        // misconfigured agent's funds without asking anyone.
        if (caller == holder) return;

        _enforceSession(caller, to, value, data, operation, proof);
    }

    function _enforceSession(
        address signer,
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        bytes32[] memory proof
    ) private {
        Session storage s = _sessions[signer];
        if (s.revoked || s.validUntil == 0) revert SessionNotValid(signer);
        if (block.timestamp < s.validAfter) revert SessionNotValid(signer);
        if (block.timestamp > s.validUntil) revert SessionNotValid(signer);
        // A key granted by a previous owner is dead, whatever its expiry says.
        if (s.grantedBy != owner()) revert SessionNotValid(signer);

        IAnima a = anima();
        uint256 id = agentId();

        // A paused or disputed agent has no spending authority at all. This is what makes
        // the guardian's kill switch real rather than advisory.
        AgentStatus status = a.statusOf(id);
        if (status != AgentStatus.Active) revert AgentNotActive(status);

        AutonomyPolicy memory p = a.policyOf(id);
        if (p.expiry != 0 && block.timestamp > p.expiry) revert PolicyExpired(p.expiry);

        if (operation == 1 && !p.allowDelegateCall) revert DelegateCallNotAllowed();
        if (operation > 1) revert UnsupportedOperation(operation);

        bytes4 selector = data.length >= 4 ? bytes4(data[:4]) : bytes4(0);
        if (!p.allowUnlistedTargets && !allowedCall(to, selector)) {
            bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(to, selector))));
            if (p.targetsRoot == bytes32(0) || !MerkleProof.verify(proof, p.targetsRoot, leaf)) {
                revert TargetNotAllowed(to, selector);
            }
        }

        if (value != 0) {
            if (value > p.perTxWei) revert PerTxCapExceeded(value, p.perTxWei);

            uint64 today = uint64(block.timestamp / 1 days);
            uint128 spent = _spendDay == today ? _spentToday : 0;
            uint256 wouldBe = uint256(spent) + value;
            if (wouldBe > p.dailyWei) revert DailyCapExceeded(wouldBe, p.dailyWei);
            _spendDay = today;
            _spentToday = uint128(wouldBe);

            uint256 sessionWouldBe = uint256(s.spentWei) + value;
            if (sessionWouldBe > s.spendCapWei) revert SessionCapExceeded(sessionWouldBe, s.spendCapWei);
            s.spentWei = uint128(sessionWouldBe);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                 ERC-1271
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IERC1271
    /// @dev Only the owner's signature makes the *account* speak. Session keys deliberately
    ///      cannot produce ERC-1271 signatures: a budget cap means nothing if the key can
    ///      instead sign an unbounded off-chain order that some other protocol honours.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        address holder = owner();
        if (holder != address(0) && SignatureChecker.isValidSignatureNow(holder, hash, signature)) {
            return MAGIC_VALUE_1271;
        }
        return bytes4(0);
    }

    /*//////////////////////////////////////////////////////////////
                                 ERC-4337
    //////////////////////////////////////////////////////////////*/

    modifier onlyEntryPoint() {
        if (ENTRY_POINT == address(0) || msg.sender != ENTRY_POINT) revert NotEntryPoint(msg.sender);
        _;
    }

    /// @notice ERC-4337 validation. Touches only this account's own storage, so it stays
    ///         inside the ERC-7562 rules bundlers enforce for unstaked accounts.
    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 missingAccountFunds)
        external
        onlyEntryPoint
        returns (uint256 validationData)
    {
        (address signer, bytes memory sig) = abi.decode(userOp.signature, (address, bytes));

        if (!SignatureChecker.isValidSignatureNow(signer, userOpHash, sig)) {
            validationData = SIG_VALIDATION_FAILED;
        } else if (signer == owner()) {
            validationData = SIG_VALIDATION_SUCCESS;
        } else if (userOp.callData.length < 4 || bytes4(userOp.callData[:4]) != this.executeUserOp.selector) {
            // Defence in depth alongside the guard in `_authorize`: a session key's operation
            // must route through `executeUserOp` so the responsible signer is resolved and
            // charged. Reject anything else at validation, before it costs the account gas.
            validationData = SIG_VALIDATION_FAILED;
        } else {
            Session storage s = _sessions[signer];
            if (s.revoked || s.validUntil == 0 || s.grantedBy != owner()) {
                validationData = SIG_VALIDATION_FAILED;
            } else {
                // Pack the session window into validationData so the bundler — not this
                // contract — rejects the op outside its validity period.
                validationData = (uint256(s.validUntil) << 160) | (uint256(s.validAfter) << 208);
            }
        }

        if (missingAccountFunds != 0) {
            (bool ok,) = msg.sender.call{value: missingAccountFunds}("");
            ok; // EntryPoint reverts on shortfall; swallowing here keeps validation cheap
        }
    }

    /// @notice ERC-4337 execution hook. The EntryPoint hands back the full user operation,
    ///         which lets the account recover *which* session key is responsible and charge
    ///         the spend to it — impossible with a bare `execute` in a bundled transaction.
    function executeUserOp(PackedUserOperation calldata userOp, bytes32) external onlyEntryPoint nonReentrant {
        (address signer,) = abi.decode(userOp.signature, (address, bytes));

        bytes calldata cd = userOp.callData;
        if (cd.length < 4) revert InvalidUserOpCallData();
        bytes4 sel = bytes4(cd[:4]);

        if (sel == this.execute.selector) {
            (address to, uint256 value, bytes memory data, uint8 op) =
                abi.decode(cd[4:], (address, uint256, bytes, uint8));
            _authorizeMemory(signer, to, value, data, op);
            unchecked {
                ++_state;
            }
            _execMemory(signer, to, value, data, op);
        } else if (sel == this.executeBatch.selector) {
            Call[] memory calls = abi.decode(cd[4:], (Call[]));
            for (uint256 i; i < calls.length; ++i) {
                _authorizeMemory(signer, calls[i].to, calls[i].value, calls[i].data, 0);
                _execMemory(signer, calls[i].to, calls[i].value, calls[i].data, 0);
            }
            unchecked {
                ++_state;
            }
        } else {
            revert InvalidUserOpCallData();
        }
    }

    /*//////////////////////////////////////////////////////////////
                          MEMORY-ARG VARIANTS
    //////////////////////////////////////////////////////////////*/

    /// @dev Same rules as the calldata path. Solidity cannot share one implementation
    ///      across `calldata` and `memory` arguments without an external self-call, which
    ///      would cost more gas than the duplication saves. The two paths are kept
    ///      line-for-line identical so a change to one is obvious if not mirrored.
    function _authorizeMemory(address signer, address to, uint256 value, bytes memory data, uint8 operation) private {
        address holder = owner();
        if (holder == address(0)) revert OwnershipCycle();
        if (signer == holder) return;
        _enforceSessionMemory(signer, to, value, data, operation);
    }

    function _enforceSessionMemory(address signer, address to, uint256 value, bytes memory data, uint8 operation)
        private
    {
        Session storage s = _sessions[signer];
        if (s.revoked || s.validUntil == 0) revert SessionNotValid(signer);
        if (block.timestamp < s.validAfter || block.timestamp > s.validUntil) revert SessionNotValid(signer);
        if (s.grantedBy != owner()) revert SessionNotValid(signer);

        IAnima a = anima();
        uint256 id = agentId();
        AgentStatus status = a.statusOf(id);
        if (status != AgentStatus.Active) revert AgentNotActive(status);

        AutonomyPolicy memory p = a.policyOf(id);
        if (p.expiry != 0 && block.timestamp > p.expiry) revert PolicyExpired(p.expiry);
        if (operation == 1 && !p.allowDelegateCall) revert DelegateCallNotAllowed();
        if (operation > 1) revert UnsupportedOperation(operation);

        bytes4 selector = _selectorOf(data);
        if (!p.allowUnlistedTargets && !allowedCall(to, selector)) revert TargetNotAllowed(to, selector);

        if (value != 0) {
            if (value > p.perTxWei) revert PerTxCapExceeded(value, p.perTxWei);
            uint64 today = uint64(block.timestamp / 1 days);
            uint128 spent = _spendDay == today ? _spentToday : 0;
            uint256 wouldBe = uint256(spent) + value;
            if (wouldBe > p.dailyWei) revert DailyCapExceeded(wouldBe, p.dailyWei);
            _spendDay = today;
            _spentToday = uint128(wouldBe);

            uint256 sessionWouldBe = uint256(s.spentWei) + value;
            if (sessionWouldBe > s.spendCapWei) revert SessionCapExceeded(sessionWouldBe, s.spendCapWei);
            s.spentWei = uint128(sessionWouldBe);
        }
    }

    function _execMemory(address signer, address to, uint256 value, bytes memory data, uint8 operation) private {
        bool ok;
        bytes memory result;
        if (operation == 0) {
            (ok, result) = to.call{value: value}(data);
        } else if (operation == 1) {
            (ok, result) = to.delegatecall(data);
        } else {
            revert UnsupportedOperation(operation);
        }
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(result, 0x20), mload(result))
            }
        }
        bytes4 sel = _selectorOf(data);
        _audit(signer, to, value, sel, keccak256(data), operation);
        emit Executed(signer, to, value, sel, operation);
    }

    function _selectorOf(bytes memory data) private pure returns (bytes4 sel) {
        if (data.length < 4) return bytes4(0);
        assembly ("memory-safe") {
            sel := mload(add(data, 0x20))
        }
    }

    /*//////////////////////////////////////////////////////////////
                                RECEIVERS
    //////////////////////////////////////////////////////////////*/

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC1155Receiver.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return IERC1155Receiver.onERC1155BatchReceived.selector;
    }

    function supportsInterface(bytes4 interfaceId) public pure returns (bool) {
        return interfaceId == type(IERC165).interfaceId || interfaceId == type(IERC6551Account).interfaceId
            || interfaceId == type(IERC6551Executable).interfaceId || interfaceId == type(IERC1271).interfaceId
            || interfaceId == type(IERC721Receiver).interfaceId || interfaceId == type(IERC1155Receiver).interfaceId;
    }
}
