// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title ExactERC20 — value-conserving ERC-20 transfers
/// @notice Rejects tokens whose transfer mechanics deliver a different amount than the
///         protocol accounted for. This prevents fee-on-transfer tokens from creating
///         unbacked escrow balances, underfunded curve purchases, or short-paid sellers.
library ExactERC20 {
    using SafeERC20 for IERC20;

    error InexactERC20Transfer(address token, uint256 expected, uint256 received);

    function transferFromExact(IERC20 token, address from, address to, uint256 amount) internal {
        if (amount == 0 || from == to) return;
        uint256 beforeBalance = token.balanceOf(to);
        token.safeTransferFrom(from, to, amount);
        uint256 afterBalance = token.balanceOf(to);
        uint256 received = afterBalance >= beforeBalance ? afterBalance - beforeBalance : 0;
        if (received != amount) revert InexactERC20Transfer(address(token), amount, received);
    }

    function transferExact(IERC20 token, address to, uint256 amount) internal {
        if (amount == 0 || to == address(this)) return;
        uint256 beforeBalance = token.balanceOf(to);
        token.safeTransfer(to, amount);
        uint256 afterBalance = token.balanceOf(to);
        uint256 received = afterBalance >= beforeBalance ? afterBalance - beforeBalance : 0;
        if (received != amount) revert InexactERC20Transfer(address(token), amount, received);
    }
}
