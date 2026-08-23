// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {ERC2981Upgradeable} from "@openzeppelin/contracts-upgradeable/token/common/ERC2981Upgradeable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {
    IAnima,
    IAnimaEvents,
    AgentStatus,
    SealPolicy,
    BrainShard,
    AgentCore,
    Lease
} from "../interfaces/IAnima.sol";
import {IIdentityRegistry} from "../interfaces/IERC8004.sol";
import {IERC4907} from "../interfaces/IRentable.sol";
import {ITransferVerifier} from "../interfaces/ITransferVerifier.sol";
import {AnimaStorage} from "./AnimaStorage.sol";

/**
 * @title AnimaBase — the invariants every ANIMA facet shares
 * @notice Holds the transfer hook, the authorisation predicates and the approval store, so
 *         that no facet can hold a different opinion about who controls an agent or what a
 *         sale does to it.
 *
 * @dev The failure mode of EIP-2535 is not storage collision — ERC-7201 settles that. It is
 *      *semantic drift*: two facets that each implement "is this caller allowed to write
 *      this agent" and slowly stop agreeing. So the rules live here exactly once and the
 *      facets are thin surfaces over them. In particular {_update} — which is where a sale
 *      revokes the seller's staff, lease, guardian and policy — is inherited by every facet
 *      that can move a token, and there is no way for one of them to opt out.
 *
 *      Unreferenced `internal` functions are stripped by the compiler, so a facet pays for
 *      only the parts of this base it actually reaches.
 */
abstract contract AnimaBase is
    IAnimaEvents,
    ERC721Upgradeable,
    ERC2981Upgradeable,
    EIP712Upgradeable,
    Ownable2StepUpgradeable
{
    /*//////////////////////////////////////////////////////////////
                                 CONSTANTS
    //////////////////////////////////////////////////////////////*/

    bytes32 internal constant _WALLET_BINDING_TYPEHASH =
        keccak256("AgentWalletBinding(uint256 agentId,address wallet,uint256 nonce,uint256 deadline)");

    bytes4 internal constant _INTERFACE_ID_ERC4906 = 0x49064906;
    bytes4 internal constant _INTERFACE_ID_ERC4907 = 0xad092b5c;
    bytes4 internal constant _INTERFACE_ID_ERC5192 = 0xb45a3c0e;
    bytes4 internal constant _INTERFACE_ID_ERC6454 = 0x91a6262f;
    /// @dev ERC-7572 publishes no interfaceId; this is the community-computed value.
    bytes4 internal constant _INTERFACE_ID_ERC7572 = 0xe8a3d485;
    bytes4 internal constant _INTERFACE_ID_ERC5646 = 0xf5112315;

    /*//////////////////////////////////////////////////////////////
                             EVENTS / ERRORS
    //////////////////////////////////////////////////////////////*/

    event VerifierSet(address indexed verifier, SealPolicy policy);
    event ModuleSet(address indexed module, bool allowed);
    event AgentLockChanged(uint256 indexed agentId, uint32 lockCount);
    event OperatorApprovalTimed(address indexed owner, address indexed operator, uint64 expiresAt);
    event AllApprovalsRevoked(address indexed owner, uint64 epoch);

    error NotModule(address caller);
    error NotOwnerOf(uint256 agentId, address caller);
    error EmptyBrain();
    error VerificationFailed();
    error NotGuardian(uint256 agentId, address caller);

    /*//////////////////////////////////////////////////////////////
                                  STORAGE
    //////////////////////////////////////////////////////////////*/

    function _s() internal pure returns (AnimaStorage.Layout storage) {
        return AnimaStorage.layout();
    }

    /*//////////////////////////////////////////////////////////////
                              ACCESS CONTROL
    //////////////////////////////////////////////////////////////*/

    modifier onlyModule() {
        if (!_s().isModule[msg.sender]) revert NotModule(msg.sender);
        _;
    }

    function _requireOwnerOf(uint256 agentId) internal view {
        if (_requireOwned(agentId) != msg.sender) revert NotOwnerOf(agentId, msg.sender);
    }

    function _requireController(uint256 agentId) internal view {
        if (!_isController(agentId, msg.sender)) revert NotAgentController(agentId, msg.sender);
    }

    function _isController(uint256 agentId, address account) internal view returns (bool) {
        if (account == address(0)) return false;
        if (_ownerOf(agentId) == account) return true;
        AnimaStorage.Layout storage $ = _s();
        Lease storage l = $.lease[agentId];
        if (l.user == account && l.expires >= block.timestamp) return true;
        return $.operator[agentId][$.core[agentId].operatorEpoch][account];
    }

    function _isOperator(uint256 agentId, address operator) internal view returns (bool) {
        AnimaStorage.Layout storage $ = _s();
        return $.operator[agentId][$.core[agentId].operatorEpoch][operator];
    }

    /*//////////////////////////////////////////////////////////////
                            LIFECYCLE HELPERS
    //////////////////////////////////////////////////////////////*/

    function _locked(uint256 tokenId) internal view returns (bool) {
        AgentCore storage c = _s().core[tokenId];
        return c.lockCount != 0 || c.disputeCount != 0;
    }

    function _setStatus(uint256 agentId, AgentStatus status) internal {
        AgentCore storage c = _s().core[agentId];
        AgentStatus previous = c.status;
        if (previous == status) return;
        c.status = status;
        emit StatusChanged(agentId, previous, status);
    }

    function _setMetadata(uint256 agentId, string memory key, bytes memory value) internal {
        _s().metadata[agentId][keccak256(bytes(key))] = value;
        emit IIdentityRegistry.MetadataSet(agentId, key, key, value);
    }

    function _setVerifier(ITransferVerifier verifier_) internal {
        if (address(verifier_) == address(0)) revert ZeroAddress();
        _s().verifier = verifier_;
        emit VerifierSet(address(verifier_), verifier_.sealPolicy());
    }

    /// @dev Single `memory` implementation shared by mint, update and sealed transfer.
    ///      Duplicating it per data location is what pushed the monolith over the size
    ///      limit; the one-time calldata copy at the call boundary is the cheaper trade.
    function _writeShards(uint256 agentId, BrainShard[] memory shards) internal {
        BrainShard[] storage s = _s().shards[agentId];
        uint256 n = shards.length;
        uint256 existing = s.length;
        for (uint256 i; i < n; ++i) {
            if (i < existing) s[i] = shards[i];
            else s.push(shards[i]);
        }
        for (uint256 i = existing; i > n; --i) {
            s.pop();
        }
    }

    /// @inheritdoc ERC721Upgradeable
    /// @dev Shared with the approval overrides for the same reason: one definition, so no
    ///      facet can serve a different card for the same agent.
    function tokenURI(uint256 agentId) public view override returns (string memory) {
        _requireOwned(agentId);
        return _s().agentURI[agentId];
    }

    /*//////////////////////////////////////////////////////////////
                        EXPIRING, REVOCABLE APPROVALS
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IERC721
    /// @dev Overridden in the shared base rather than in the facet that publishes it,
    ///      because {ERC721Upgradeable-_isAuthorized} calls this on every transfer. A facet
    ///      that inherited the stock implementation would read an approval store nothing
    ///      writes to, and silently reject legitimate operators.
    function isApprovedForAll(address owner_, address operator) public view override returns (bool) {
        uint64 expiresAt = _s().operatorExpiry[_approvalKey(owner_, operator)];
        return expiresAt != 0 && expiresAt >= block.timestamp;
    }

    /// @inheritdoc IERC721
    function setApprovalForAll(address operator, bool approved) public override {
        _setTimedApproval(_msgSender(), operator, approved ? type(uint64).max : 0);
    }

    function _setTimedApproval(address owner_, address operator, uint64 expiresAt) internal {
        if (operator == address(0)) revert ZeroAddress();
        _s().operatorExpiry[_approvalKey(owner_, operator)] = expiresAt;
        emit ApprovalForAll(owner_, operator, expiresAt != 0);
        emit OperatorApprovalTimed(owner_, operator, expiresAt);
    }

    function _approvalKey(address owner_, address operator) internal view returns (bytes32) {
        return keccak256(abi.encode(owner_, _s().approvalEpoch[owner_], operator));
    }

    /*//////////////////////////////////////////////////////////////
                             TRANSFER HOOK
    //////////////////////////////////////////////////////////////*/

    /// @dev Deliberately not `virtual`, as are the three overrides above it. This is the hook
    ///      where a sale revokes the seller's staff, lease, guardian and policy, and where a
    ///      locked agent is refused permission to move at all. Sealing it means a facet cannot
    ///      opt out of those rules even by accident — the compiler refuses the attempt rather
    ///      than the reviewer having to notice it.

    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        address previousOwner = _ownerOf(tokenId);

        if (previousOwner != address(0)) {
            // Applies to burns as well: an agent that owes work cannot be destroyed either.
            if (_locked(tokenId)) revert AgentLocked(tokenId);
        }

        from = super._update(to, tokenId, auth);

        if (previousOwner != address(0) && to != address(0)) {
            AnimaStorage.Layout storage $ = _s();
            AgentCore storage c = $.core[tokenId];
            unchecked {
                c.operatorEpoch += 1; // wipes every operator the seller authorised
            }
            c.guardian = address(0);
            delete $.policy[tokenId];
            delete $.lease[tokenId];
            delete $.boundWallet[tokenId];
            emit IERC4907.UpdateUser(tokenId, address(0), 0);
            emit PolicyUpdated(tokenId, $.policy[tokenId]);
            emit GuardianSet(tokenId, address(0));
            // Autonomy does not survive a change of ownership. The buyer must consciously
            // re-arm the agent, having read what it is about to be allowed to do.
            _setStatus(tokenId, AgentStatus.Paused);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                  ERC-165
    //////////////////////////////////////////////////////////////*/

    function supportsInterface(bytes4 interfaceId)
        public
        view
        virtual
        override(ERC721Upgradeable, ERC2981Upgradeable)
        returns (bool)
    {
        return interfaceId == type(IAnima).interfaceId || interfaceId == type(IIdentityRegistry).interfaceId
            || interfaceId == _INTERFACE_ID_ERC4906 || interfaceId == _INTERFACE_ID_ERC4907
            || interfaceId == _INTERFACE_ID_ERC5192 || interfaceId == _INTERFACE_ID_ERC6454
            || interfaceId == _INTERFACE_ID_ERC7572 || interfaceId == _INTERFACE_ID_ERC5646
            || super.supportsInterface(interfaceId);
    }
}
