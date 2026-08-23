// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {IERC6551Executable} from "../interfaces/IERC6551.sol";
import {BrainShard} from "../interfaces/IAnima.sol";

interface IAnimaStrip {
    function updateBrain(uint256 agentId, BrainShard[] calldata shards, uint64 expectedEpoch) external;
    function setApprovalForAll(address operator, bool approved) external;
    function accountOf(uint256 agentId) external view returns (address);
    function brainEpoch(uint256 agentId) external view returns (uint64);
}

interface IBondsStrip {
    function requestUnbond(uint256 agentId, uint256 amount) external;
}

/**
 * @notice A seller that tries to hollow out its own agent from inside the payment callback.
 * @dev Models the critical bug found in review: if a marketplace pays the maker before moving
 *      the token, the maker is still `ownerOf(agentId)` when it receives control, and an owner
 *      can drain the bound account, queue the whole bond for withdrawal to itself, and wipe the
 *      brain — all after the integrity checks passed. Every attempt is wrapped so the fill
 *      itself still completes; the test then asserts none of them worked.
 */
contract MaliciousSeller is IERC1271 {
    IAnimaStrip public immutable ANIMA;
    IBondsStrip public immutable BONDS;
    IERC20 public immutable ASSET;
    address public immutable BENEFICIARY;

    uint256 public agentId;
    bool public armed;

    bool public drainSucceeded;
    bool public unbondSucceeded;
    bool public wipeSucceeded;

    constructor(address anima_, address bonds_, address asset_, address beneficiary_) {
        ANIMA = IAnimaStrip(anima_);
        BONDS = IBondsStrip(bonds_);
        ASSET = IERC20(asset_);
        BENEFICIARY = beneficiary_;
    }

    /// @dev Signs anything, which is all an ERC-1271 maker needs to do to place an order.
    function isValidSignature(bytes32, bytes memory) external pure returns (bytes4) {
        return 0x1626ba7e;
    }

    function arm(uint256 agentId_, address market) external {
        agentId = agentId_;
        armed = true;
        ANIMA.setApprovalForAll(market, true);
    }

    receive() external payable {
        if (!armed) return;
        armed = false;

        address account = ANIMA.accountOf(agentId);

        try IERC6551Executable(account).execute(
            address(ASSET), 0, abi.encodeCall(IERC20.transfer, (BENEFICIARY, ASSET.balanceOf(account))), 0
        ) {
            drainSucceeded = true;
        } catch {}

        try BONDS.requestUnbond(agentId, 1) {
            unbondSucceeded = true;
        } catch {}

        BrainShard[] memory wiped = new BrainShard[](1);
        wiped[0] = BrainShard({
            dataHash: bytes32(uint256(1)),
            keyCommitment: bytes32(0),
            size: 0,
            kind: 1,
            uri: "",
            description: "wiped"
        });
        try ANIMA.updateBrain(agentId, wiped, ANIMA.brainEpoch(agentId)) {
            wipeSucceeded = true;
        } catch {}
    }
}
