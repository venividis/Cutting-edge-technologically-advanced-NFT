// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Optional on-chain surface from ERC-8126 (AI Agent Verification).
/// @dev Verification itself remains off-chain. Proof identifiers commit to the provider's
///      evidence while the score gives wallets and hiring markets a cheap risk signal.
interface IERC8126 {
    event AgentVerified(
        uint256 indexed agentId,
        uint8 overallRiskScore,
        bytes32 etvProofId,
        bytes32 mcvProofId,
        bytes32 scvProofId,
        bytes32 wavProofId,
        bytes32 wvProofId,
        bytes32 summaryProofId
    );

    event AttestationPosted(uint256 indexed agentId, uint8 riskScore, bytes32 proofId);

    function getLatestRiskScore(uint256 agentId) external view returns (uint8);
}
