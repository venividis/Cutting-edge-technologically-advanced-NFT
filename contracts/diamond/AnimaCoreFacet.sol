// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AnimaBase} from "./AnimaBase.sol";
import {AnimaConfig} from "./IAnimaConfigured.sol";
import {AnimaStorage} from "./AnimaStorage.sol";
import {IDiamondLoupe} from "./IDiamond.sol";
import {AgentCore, AgentStatus} from "../interfaces/IAnima.sol";
import {IERC5192, IERC6454, IERC7572} from "../interfaces/IRentable.sol";
import {ITransferVerifier} from "../interfaces/ITransferVerifier.sol";

/**
 * @title AnimaCoreFacet — the ERC-721 face, the approval store, and protocol administration
 * @notice Everything a marketplace, wallet or indexer touches: ownership, transfer,
 *         approvals, royalties, locking, and the two-step owner's small set of pointers.
 * @dev The transfer entry points themselves are inherited unchanged from
 *      {ERC721Upgradeable}; what makes them ANIMA-shaped is {AnimaBase-_update}, which every
 *      facet shares. Locking is enforced there rather than here, so a token cannot be moved
 *      through some other facet's back door while it owes work.
 */
contract AnimaCoreFacet is AnimaBase, IERC5192, IERC6454, IERC7572 {
    constructor(AnimaConfig memory config) AnimaBase(config) {}

    /*//////////////////////////////////////////////////////////////
                        EXPIRING, REVOCABLE APPROVALS
    //////////////////////////////////////////////////////////////*/

    /*
     * ERC-721's `setApprovalForAll` is unbounded in time, unbounded in scope, and not
     * enumerable on-chain. It is the direct cause of the largest class of user losses in
     * NFTs: a grant made to a marketplace in 2021 is still live in 2026, and nobody can list
     * what they have outstanding. Two ecosystems arrived independently at the fix — ICRC-37
     * puts `expires_at` on every approval and supports batch revocation; CW-721 puts
     * `expires` on both `Approve` and `ApproveAll`.
     *
     * `setApprovalForAll` keeps its ERC-721 semantics and signature — an unbounded grant is
     * still expressible, because breaking it would break every marketplace. What is added is
     * a time-boxed form and an O(1) revoke-all. Enumeration is left to indexers via the
     * events.
     */

    /// @notice Approve an operator only until `expiresAt`. The form every long-lived grant
    ///         should use.
    function setApprovalForAllUntil(address operator, uint64 expiresAt) external {
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert SignatureExpired(expiresAt);
        _setTimedApproval(_msgSender(), operator, expiresAt);
    }

    /// @notice Revoke every operator approval this caller has granted, in one write.
    /// @dev The button ERC-721 never had. Approvals are keyed by epoch, so incrementing it
    ///      invalidates all of them at once regardless of how many there were or whether the
    ///      owner can still remember who they were granted to.
    function revokeAllApprovals() external {
        uint64 next;
        unchecked {
            next = ++_s().approvalEpoch[_msgSender()];
        }
        emit AllApprovalsRevoked(_msgSender(), next);
    }

    /// @notice When an operator's approval lapses. Zero means no live approval;
    ///         `type(uint64).max` means an unbounded ERC-721 grant.
    function approvalExpiryOf(address owner_, address operator) external view returns (uint64) {
        return _s().operatorExpiry[_approvalKey(owner_, operator)];
    }

    /// @notice Bumped by an owner to revoke every operator approval they have ever granted.
    function approvalEpoch(address owner_) external view returns (uint64) {
        return _s().approvalEpoch[owner_];
    }

    /*//////////////////////////////////////////////////////////////
                       ERC-5192  CONDITIONAL LOCKING
    //////////////////////////////////////////////////////////////*/

    /// @inheritdoc IERC5192
    /// @dev ANIMA's locking is *temporary and purposeful*, not soulbinding. An agent is
    ///      immovable exactly while it owes someone work or is answering for it.
    function locked(uint256 tokenId) public view returns (bool) {
        return _locked(tokenId);
    }

    /// @inheritdoc IERC6454
    /// @dev The precise counterpart to `locked`: same rule, but phrased as the question a
    ///      marketplace asks before offering a fill it would otherwise watch revert.
    function isTransferable(uint256 tokenId, address from, address to) external view returns (bool) {
        if (_ownerOf(tokenId) == address(0)) return false;
        if (from == address(0)) return true; // minting is always permitted
        to; // a burn is gated by exactly the same condition as a transfer
        return !_locked(tokenId);
    }

    /// @notice Increment an agent's lock count. Module-only.
    function lockAgent(uint256 agentId) external onlyModule {
        _requireOwned(agentId);
        AgentCore storage c = _s().core[agentId];
        bool wasLocked = _locked(agentId);
        c.lockCount += 1;
        emit AgentLockChanged(agentId, c.lockCount);
        if (!wasLocked) emit Locked(agentId);
    }

    /// @notice Decrement an agent's lock count. Module-only.
    function unlockAgent(uint256 agentId) external onlyModule {
        AgentCore storage c = _s().core[agentId];
        if (c.lockCount == 0) return;
        c.lockCount -= 1;
        emit AgentLockChanged(agentId, c.lockCount);
        if (!_locked(agentId)) emit Unlocked(agentId);
    }

    /// @notice Move an agent into or out of `Disputed`. Module-only.
    /// @dev Counted, not a boolean. An agent can owe several clients at once, and resolving
    ///      the first dispute must not hand its spending authority back while the others are
    ///      still open — that would make the kill switch a matter of timing.
    function setDisputed(uint256 agentId, bool disputed) external onlyModule {
        AgentCore storage c = _s().core[agentId];
        bool wasLocked = _locked(agentId);
        if (disputed) {
            c.disputeCount += 1;
            _setStatus(agentId, AgentStatus.Disputed);
            if (!wasLocked) emit Locked(agentId);
        } else {
            if (c.disputeCount != 0) c.disputeCount -= 1;
            if (c.disputeCount == 0 && c.status == AgentStatus.Disputed) _setStatus(agentId, AgentStatus.Paused);
            if (!_locked(agentId) && wasLocked) emit Unlocked(agentId);
        }
    }

    /*//////////////////////////////////////////////////////////////
                                  ADMIN
    //////////////////////////////////////////////////////////////*/

    function verifier() external view returns (ITransferVerifier) {
        return _s().verifier;
    }

    function setVerifier(ITransferVerifier verifier_) external onlyOwner {
        _setVerifier(verifier_);
    }

    /// @notice Protocol modules (escrow, marketplace, bridge) permitted to lock agents and
    ///         move them into `Disputed`. A small, explicit allowlist — never open-ended.
    function isModule(address module) external view returns (bool) {
        return _s().isModule[module];
    }

    function setModule(address module, bool allowed) external onlyOwner {
        _s().isModule[module] = allowed;
        emit ModuleSet(module, allowed);
    }

    /// @inheritdoc IERC7572
    function contractURI() external view returns (string memory) {
        return _s().contractURI;
    }

    function setContractURI(string calldata newURI) external onlyOwner {
        _s().contractURI = newURI;
        emit ContractURIUpdated();
    }

    /// @dev A declaration, not an entitlement. ERC-2981's own abstract says payment "must be
    ///      voluntary", and by 2026 that is the observed reality: OpenSea made royalties
    ///      optional when the Operator Filter sunset (2023-08-31 for new collections,
    ///      2024-02-29 for existing), Blur enforces only a 0.5% floor on immutable
    ///      contracts, and only ERC-721C collections see enforcement on Magic Eden — at the
    ///      cost of being untradeable on Blur and most aggregators.
    ///
    ///      ANIMA therefore does not fight the secondary-market royalty war. It captures
    ///      value where it actually controls the chokepoint: escrow settlement fees,
    ///      launchpad fees, and per-call metering. This hook exists so marketplaces that do
    ///      pay have somewhere to send it, and for no stronger promise than that.
    function setDefaultRoyalty(address receiver, uint96 feeNumerator) external onlyOwner {
        _setDefaultRoyalty(receiver, feeNumerator);
    }

    function setTokenRoyalty(uint256 agentId, address receiver, uint96 feeNumerator) external onlyOwner {
        _setTokenRoyalty(agentId, receiver, feeNumerator);
    }

    function totalMinted() external view returns (uint256) {
        return _s().nextAgentId - 1;
    }

    /*//////////////////////////////////////////////////////////////
                                ERC-165
    //////////////////////////////////////////////////////////////*/

    /// @dev Identical to the monolith's answer plus one: this build genuinely implements the
    ///      EIP-2535 loupe, and a caller that wants to verify the code behind this address
    ///      is entitled to discover that from ERC-165 rather than by guessing.
    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(IDiamondLoupe).interfaceId || super.supportsInterface(interfaceId);
    }
}
