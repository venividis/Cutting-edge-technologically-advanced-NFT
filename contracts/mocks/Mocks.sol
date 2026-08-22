// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ILiquidityDeployer} from "../market/ILiquidityDeployer.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _decimals = d;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice A venue that swaps at a fixed rate, for exercising {AgentSwapRouter}.
contract MockVenue {
    using SafeERC20 for IERC20;

    uint256 public rateBps = 10_000; // 1:1 by default
    bool public shortChange; // deliver less than promised, to prove the delta check bites

    function setRate(uint256 bps) external {
        rateBps = bps;
    }

    function setShortChange(bool on) external {
        shortChange = on;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn) external {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        uint256 out = (amountIn * rateBps) / 10_000;
        if (shortChange) out = out / 2;
        IERC20(tokenOut).safeTransfer(msg.sender, out);
    }

    /// @dev Consumes only part of its allowance, to prove approvals are zeroed afterwards.
    function partialSwap(address tokenIn, address tokenOut, uint256 amountIn) external {
        uint256 take = amountIn / 2;
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), take);
        IERC20(tokenOut).safeTransfer(msg.sender, (take * rateBps) / 10_000);
    }
}

contract MockLiquidityDeployer is ILiquidityDeployer {
    using SafeERC20 for IERC20;

    address public lastPool;
    uint256 public lastTokenAmount;
    uint256 public lastQuoteAmount;
    address public lastLpRecipient;

    function deployLiquidity(address token, address quote, uint256 tokenAmount, uint256 quoteAmount, address lpRecipient)
        external
        returns (address pool, uint256 lpAmount)
    {
        IERC20(token).safeTransferFrom(msg.sender, address(this), tokenAmount);
        IERC20(quote).safeTransferFrom(msg.sender, address(this), quoteAmount);
        lastTokenAmount = tokenAmount;
        lastQuoteAmount = quoteAmount;
        lastLpRecipient = lpRecipient;
        lastPool = address(this);
        return (address(this), tokenAmount + quoteAmount);
    }
}

/// @notice Reverts on receiving ETH, for testing payout failure paths.
contract RevertingReceiver {
    receive() external payable {
        revert("no");
    }
}
