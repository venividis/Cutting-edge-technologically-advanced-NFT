// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title ERC-8004 Trustless Agents — registry interfaces
 * @notice Verbatim-compatible interfaces for the ERC-8004 Identity, Reputation and
 *         Validation registries (Draft, created 2025-08-13; requires EIP-155, EIP-712,
 *         EIP-721, EIP-1271). See https://eips.ethereum.org/EIPS/eip-8004.
 *
 *         ANIMA implements `IIdentityRegistry` directly on the agent token rather than
 *         in a side registry, so `agentId == tokenId` and the ERC-721 owner is the
 *         canonical controller. Global agent identifiers therefore resolve as
 *         `eip155:<chainId>:<animaAddress>` + tokenId, exactly as ERC-8004 specifies.
 */

/// @dev A single off-chain-addressable key/value pair attached to an agent.
struct MetadataEntry {
    string metadataKey;
    bytes metadataValue;
}

interface IIdentityRegistry {
    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);
    event MetadataSet(
        uint256 indexed agentId,
        string indexed indexedMetadataKey,
        string metadataKey,
        bytes metadataValue
    );

    function register(string calldata agentURI, MetadataEntry[] calldata metadata)
        external
        returns (uint256 agentId);

    function register(string calldata agentURI) external returns (uint256 agentId);

    function register() external returns (uint256 agentId);

    function setAgentURI(uint256 agentId, string calldata newURI) external;

    function getMetadata(uint256 agentId, string calldata metadataKey) external view returns (bytes memory);

    function setMetadata(uint256 agentId, string calldata metadataKey, bytes calldata metadataValue) external;

    /// @notice Binds an operational wallet to an agent. `signature` is an EIP-712 (or
    ///         EIP-1271) attestation *from the wallet* proving it consents to the binding,
    ///         which prevents an agent from claiming a wallet it does not control.
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature)
        external;

    function getAgentWallet(uint256 agentId) external view returns (address);

    function unsetAgentWallet(uint256 agentId) external;
}

interface IReputationRegistry {
    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string indexed indexedTag1,
        string tag1,
        string tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash
    );
    event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex);
    event ResponseAppended(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        address indexed responder,
        string responseURI,
        bytes32 responseHash
    );

    function getIdentityRegistry() external view returns (address identityRegistry);

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;

    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external;

    function appendResponse(
        uint256 agentId,
        address clientAddress,
        uint64 feedbackIndex,
        string calldata responseURI,
        bytes32 responseHash
    ) external;

    function getSummary(
        uint256 agentId,
        address[] calldata clientAddresses,
        string calldata tag1,
        string calldata tag2
    ) external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);

    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked);

    function getClients(uint256 agentId) external view returns (address[] memory);

    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64);
}

interface IValidationRegistry {
    event ValidationRequest(
        address indexed validatorAddress, uint256 indexed agentId, string requestURI, bytes32 indexed requestHash
    );
    event ValidationResponse(
        address indexed validatorAddress,
        uint256 indexed agentId,
        bytes32 indexed requestHash,
        uint8 response,
        string responseURI,
        bytes32 responseHash,
        string tag
    );

    function getIdentityRegistry() external view returns (address identityRegistry);

    function validationRequest(
        address validatorAddress,
        uint256 agentId,
        string calldata requestURI,
        bytes32 requestHash
    ) external;

    /// @param response Score in [0,100]. ERC-8004 leaves the scale to the tag; ANIMA
    ///        treats >= 50 as "passed" for bond-release purposes.
    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external;

    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (
            address validatorAddress,
            uint256 agentId,
            uint8 response,
            bytes32 responseHash,
            string memory tag,
            uint256 lastUpdate
        );

    function getSummary(uint256 agentId, address[] calldata validatorAddresses, string calldata tag)
        external
        view
        returns (uint64 count, uint8 averageResponse);

    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory requestHashes);

    function getValidatorRequests(address validatorAddress) external view returns (bytes32[] memory requestHashes);
}
