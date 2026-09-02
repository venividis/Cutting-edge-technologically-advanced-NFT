// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IERC7432} from "../interfaces/IERC7432.sol";

interface IAnimaRoleLocking {
    function lockAgent(uint256 agentId) external;
    function unlockAgent(uint256 agentId) external;
    function locked(uint256 tokenId) external view returns (bool);
}

/**
 * @title AnimaRoles — many roles per agent, without touching the token
 * @notice ERC-7432 roles registry for ANIMA agents: operator, payer, auditor, trainer, or any
 *         other `bytes32` a deployment cares to define — each with its own recipient, its own
 *         expiry, and its own revocability.
 *
 * @dev **Why this is a separate contract, and why that is not a compromise.**
 *
 *      `AnimaAgent` compiles to 23,971 of the 24,576 bytes EIP-170 allows. ERC-7432 will not fit
 *      in what is left, and none of the usual escapes help: stripping the metadata trailer buys
 *      53 bytes, and dropping the optimizer to `runs: 1` buys another 376 while taxing every
 *      call the contract will ever serve. Measured, not assumed.
 *
 *      But ERC-7432 was designed for exactly this. From its Rationale, verbatim: *"ERC-7432 IS
 *      NOT an extension of ERC-721. The main reason behind this decision is to enable it to be
 *      implemented externally or on the same contract as the NFT."* Every function takes
 *      `tokenAddress` beside `tokenId` precisely so a standalone contract can be the
 *      authoritative source of roles for a token that knows nothing about them. So the token
 *      needs no change at all, and generic ERC-7432 tooling reads this without special-casing.
 *
 *      **Locking instead of escrow.** The spec's own suggestion is that a registry take custody
 *      of the NFT so a role cannot be sold out from under its holder. ANIMA does better: it
 *      already has a module-gated lock, so this registry is registered as a module and freezes
 *      the agent in place. The owner keeps the token in their own wallet, it stays visible to
 *      every marketplace and indexer, and it simply cannot move while a role is live. Escrow
 *      would have achieved the same guarantee by making the owner look like they had sold it.
 *
 *      **Irrevocable roles are capped.** A permanent role would make an agent permanently
 *      unsellable, which is the same "authorisation outliving its relationship" defect that the
 *      security review found nine times over. Revocable roles may run as long as the owner
 *      likes, because the owner can end them; irrevocable ones cannot exceed
 *      {MAX_IRREVOCABLE_DURATION}.
 *
 *      **Roles do not survive a sale, structurally.** While any role is live the agent is
 *      locked, so it cannot be sold at all. There is no window in which a buyer inherits the
 *      seller's grantees.
 */
contract AnimaRoles is IERC7432, IERC165 {
    /*//////////////////////////////////////////////////////////////
                             ROLE VOCABULARY
    //////////////////////////////////////////////////////////////*/

    /// @notice Drives the agent day to day: submits and delivers work.
    bytes32 public constant OPERATOR = keccak256("anima.role.operator");
    /// @notice Funds it — tops up channels, posts bond, settles fees.
    bytes32 public constant PAYER = keccak256("anima.role.payer");
    /// @notice Reads its private state for compliance without operating it.
    bytes32 public constant AUDITOR = keccak256("anima.role.auditor");
    /// @notice May update the brain: fine-tuning, memory curation, evaluation.
    bytes32 public constant TRAINER = keccak256("anima.role.trainer");

    /// @notice The longest an irrevocable role may run. A grant the owner cannot end is a lock
    ///         the owner cannot lift, so it is bounded rather than left to good intentions.
    uint64 public constant MAX_IRREVOCABLE_DURATION = 365 days;

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    struct RoleRecord {
        address recipient;
        uint64 expirationDate;
        bool revocable;
        bytes data;
    }

    /// @notice The one ANIMA collection this registry speaks for.
    address public immutable AGENTS;

    mapping(uint256 tokenId => mapping(bytes32 roleId => RoleRecord)) private _roles;
    /// @notice Latest expiry among this token's irrevocable roles; it cannot unlock before then.
    mapping(uint256 tokenId => uint64) public lockedUntil;
    mapping(uint256 tokenId => uint256) public activeRoleCount;
    mapping(uint256 tokenId => bool) public isLockedHere;
    mapping(address owner => mapping(address operator => bool)) private _approvals;

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error UnsupportedCollection(address tokenAddress);
    error NotOwnerOrApproved(uint256 tokenId, address caller);
    error ExpirationInThePast(uint64 expirationDate);
    error IrrevocableTooLong(uint64 duration, uint64 maximum);
    error RoleNotRevocable(uint256 tokenId, bytes32 roleId);
    error StillLocked(uint256 tokenId, uint64 until);
    error ZeroRecipient();

    /*//////////////////////////////////////////////////////////////
                               CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    constructor(address agents_) {
        AGENTS = agents_;
    }

    /// @dev Accepted for ERC-7432 signature compatibility, then checked. Generic tooling passes
    ///      the collection address; this registry only ever answers for one.
    function _requireOurs(address tokenAddress) private view {
        if (tokenAddress != AGENTS) revert UnsupportedCollection(tokenAddress);
    }

    function _requireAuthorised(uint256 tokenId) private view returns (address holder) {
        holder = IERC721(AGENTS).ownerOf(tokenId);
        if (msg.sender != holder && !_approvals[holder][msg.sender]) {
            revert NotOwnerOrApproved(tokenId, msg.sender);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                 GRANTING
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IERC7432
    function grantRole(Role calldata _role) external {
        _requireOurs(_role.tokenAddress);
        if (_role.recipient == address(0)) revert ZeroRecipient();
        if (_role.expirationDate <= block.timestamp) revert ExpirationInThePast(_role.expirationDate);

        address holder = _requireAuthorised(_role.tokenId);

        if (!_role.revocable) {
            uint64 duration = _role.expirationDate - uint64(block.timestamp);
            if (duration > MAX_IRREVOCABLE_DURATION) {
                revert IrrevocableTooLong(duration, MAX_IRREVOCABLE_DURATION);
            }
            if (_role.expirationDate > lockedUntil[_role.tokenId]) {
                lockedUntil[_role.tokenId] = _role.expirationDate;
            }
        }

        RoleRecord storage existing = _roles[_role.tokenId][_role.roleId];
        if (existing.recipient == address(0)) ++activeRoleCount[_role.tokenId];
        _roles[_role.tokenId][_role.roleId] = RoleRecord({
            recipient: _role.recipient,
            expirationDate: _role.expirationDate,
            revocable: _role.revocable,
            data: _role.data
        });

        // Freeze the agent in place rather than taking it into escrow. The owner keeps it; it
        // just cannot be sold out from under the grantee.
        if (!isLockedHere[_role.tokenId]) {
            isLockedHere[_role.tokenId] = true;
            IAnimaRoleLocking(AGENTS).lockAgent(_role.tokenId);
            emit TokenLocked(holder, AGENTS, _role.tokenId);
        }

        emit RoleGranted(
            AGENTS,
            _role.tokenId,
            _role.roleId,
            holder,
            _role.recipient,
            _role.expirationDate,
            _role.revocable,
            _role.data
        );
    }

    /// @inheritdoc IERC7432
    function revokeRole(address _tokenAddress, uint256 _tokenId, bytes32 _roleId) external {
        _requireOurs(_tokenAddress);
        RoleRecord storage r = _roles[_tokenId][_roleId];

        if (r.recipient == address(0)) return;

        // A grantee may always walk away; anyone may clear an expired role; the owner may
        // only end a live role that was granted as revocable.
        if (msg.sender != r.recipient && r.expirationDate > block.timestamp) {
            _requireAuthorised(_tokenId);
            if (!r.revocable) {
                revert RoleNotRevocable(_tokenId, _roleId);
            }
        }

        delete _roles[_tokenId][_roleId];
        --activeRoleCount[_tokenId];
        emit RoleRevoked(AGENTS, _tokenId, _roleId);
    }

    /// @inheritdoc IERC7432
    /// @dev Permissionless once nothing irrevocable is outstanding: an agent should return to
    ///      circulation without needing its grantees to cooperate.
    function unlockToken(address _tokenAddress, uint256 _tokenId) external {
        _requireOurs(_tokenAddress);
        if (activeRoleCount[_tokenId] != 0) revert StillLocked(_tokenId, lockedUntil[_tokenId]);
        uint64 until = lockedUntil[_tokenId];
        if (block.timestamp < until) revert StillLocked(_tokenId, until);
        if (!isLockedHere[_tokenId]) return;

        isLockedHere[_tokenId] = false;
        lockedUntil[_tokenId] = 0;
        IAnimaRoleLocking(AGENTS).unlockAgent(_tokenId);
        emit TokenUnlocked(IERC721(AGENTS).ownerOf(_tokenId), AGENTS, _tokenId);
    }

    /// @inheritdoc IERC7432
    function setRoleApprovalForAll(address _tokenAddress, address _operator, bool _approved) external {
        _requireOurs(_tokenAddress);
        _approvals[msg.sender][_operator] = _approved;
        emit RoleApprovalForAll(AGENTS, _operator, _approved);
    }

    /*//////////////////////////////////////////////////////////////
                                 READING
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IERC7432
    /// @dev The live ERC-721 holder. Because this registry locks rather than escrows, there is
    ///      no separate "original owner" to track — the answer never diverges from the token.
    function ownerOf(address _tokenAddress, uint256 _tokenId) external view returns (address) {
        _requireOurs(_tokenAddress);
        return IERC721(AGENTS).ownerOf(_tokenId);
    }

    /// @inheritdoc IERC7432
    function recipientOf(address _tokenAddress, uint256 _tokenId, bytes32 _roleId) public view returns (address) {
        _requireOurs(_tokenAddress);
        RoleRecord storage r = _roles[_tokenId][_roleId];
        return r.expirationDate > block.timestamp ? r.recipient : address(0);
    }

    /// @inheritdoc IERC7432
    function roleData(address _tokenAddress, uint256 _tokenId, bytes32 _roleId)
        external
        view
        returns (bytes memory)
    {
        _requireOurs(_tokenAddress);
        return _roles[_tokenId][_roleId].data;
    }

    /// @inheritdoc IERC7432
    function roleExpirationDate(address _tokenAddress, uint256 _tokenId, bytes32 _roleId)
        external
        view
        returns (uint64)
    {
        _requireOurs(_tokenAddress);
        return _roles[_tokenId][_roleId].expirationDate;
    }

    /// @inheritdoc IERC7432
    function isRoleRevocable(address _tokenAddress, uint256 _tokenId, bytes32 _roleId) external view returns (bool) {
        _requireOurs(_tokenAddress);
        return _roles[_tokenId][_roleId].revocable;
    }

    /// @inheritdoc IERC7432
    function isRoleApprovedForAll(address _tokenAddress, address _owner, address _operator)
        external
        view
        returns (bool)
    {
        _requireOurs(_tokenAddress);
        return _approvals[_owner][_operator];
    }

    /// @notice The question a module actually asks: does this address hold this role right now?
    function hasRole(uint256 _tokenId, bytes32 _roleId, address _account) external view returns (bool) {
        RoleRecord storage r = _roles[_tokenId][_roleId];
        return r.recipient == _account && r.expirationDate > block.timestamp;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IERC7432).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
