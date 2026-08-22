// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

/**
 * @title ERC-8217 Agent NFT Identity Bindings
 * @notice interface as specified by ERC-8217 (Draft, 2026-04-05, requires ERC-8004).
 */
interface IERCAgentBindings {
    enum TokenStandard {
        ERC721,
        ERC1155,
        ERC6909
    }

    struct Binding {
        TokenStandard standard;
        address tokenContract;
        uint256 tokenId;
    }

    event AgentBound(
        uint256 indexed agentId,
        TokenStandard indexed standard,
        address indexed tokenContract,
        uint256 tokenId,
        address registeredBy
    );

    function bindingOf(uint256 agentId) external view returns (Binding memory);
}

/**
 * @title AnimaBindings — letting the canonical registry point back at a real NFT
 * @notice ERC-8217 binding contract. Attaches an entry in the chain's singleton ERC-8004
 *         Identity Registry to a master NFT — an ANIMA agent, or any ERC-721/1155 — so that
 *         whoever owns the NFT controls the agent, and control follows sales automatically.
 *
 * @dev ANIMA implements ERC-8004's Identity Registry directly on its own token, which is the
 *      right design for a collection that wants its agents to *be* the NFTs. But the
 *      ecosystem is converging on one singleton registry per chain, and an agent that is not
 *      in it is invisible to indexers and clients that only look there.
 *
 *      This contract is the bridge. Register in the singleton, bind that registration here,
 *      and the agent is discoverable through the canonical path while its ownership,
 *      economics and accountability continue to live on the ANIMA token. Nothing about the
 *      ANIMA contract changes, and no duplicate source of truth is created: the 8004 record
 *      stores only this contract's address under the reserved `agent-binding` key, and this
 *      contract is the single place the token triple can be read.
 *
 *      **Bindings are immutable**, as ERC-8217 requires. A mutable binding would let an
 *      agent accumulate reputation under one NFT and then re-point at another, which is
 *      identity laundering with extra steps.
 *
 *      The binder must own the master token at bind time. ERC-8217 does not require this;
 *      without it anyone could bind their own agent id to someone else's blue-chip NFT and
 *      borrow its standing.
 */
contract AnimaBindings is IERCAgentBindings {
    /// @notice The reserved ERC-8004 metadata key whose 20-byte value must be this address.
    string public constant BINDING_METADATA_KEY = "agent-binding";

    mapping(uint256 agentId => Binding) private _bindings;

    error AlreadyBound(uint256 agentId);
    error NotTokenOwner(address tokenContract, uint256 tokenId, address caller);
    error UnsupportedStandard(TokenStandard standard);
    error ZeroAddress();

    /// @notice Bind an ERC-8004 agent id to a master NFT. Permanent.
    function bind(uint256 agentId, TokenStandard standard, address tokenContract, uint256 tokenId) external {
        if (tokenContract == address(0)) revert ZeroAddress();
        if (_bindings[agentId].tokenContract != address(0)) revert AlreadyBound(agentId);

        if (standard == TokenStandard.ERC721) {
            if (IERC721(tokenContract).ownerOf(tokenId) != msg.sender) {
                revert NotTokenOwner(tokenContract, tokenId, msg.sender);
            }
        } else if (standard == TokenStandard.ERC1155) {
            if (IERC1155(tokenContract).balanceOf(msg.sender, tokenId) == 0) {
                revert NotTokenOwner(tokenContract, tokenId, msg.sender);
            }
        } else {
            // ERC-6909 is in the spec's enum but has no settled ownership check for a
            // single-owner token; refusing is better than guessing at one.
            revert UnsupportedStandard(standard);
        }

        _bindings[agentId] = Binding({standard: standard, tokenContract: tokenContract, tokenId: tokenId});
        emit AgentBound(agentId, standard, tokenContract, tokenId, msg.sender);
    }

    /// @inheritdoc IERCAgentBindings
    function bindingOf(uint256 agentId) external view returns (Binding memory) {
        return _bindings[agentId];
    }

    /// @notice Who currently controls a bound agent: the holder of its master NFT.
    /// @dev Returns the zero address for an unbound agent or an ERC-1155 binding, where
    ///      "the owner" is not a well-defined single address.
    function controllerOf(uint256 agentId) external view returns (address) {
        Binding storage b = _bindings[agentId];
        if (b.tokenContract == address(0) || b.standard != TokenStandard.ERC721) return address(0);
        return IERC721(b.tokenContract).ownerOf(b.tokenId);
    }

    /// @notice The exact 20-byte value to write under `agent-binding` in the ERC-8004 record.
    function bindingMetadataValue() external view returns (bytes memory) {
        return abi.encodePacked(address(this));
    }
}
