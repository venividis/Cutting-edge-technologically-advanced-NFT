// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title ILiquidityDeployer
 * @notice Seam between the launch curve and whatever AMM a deployment actually uses.
 * @dev Kept abstract on purpose. Uniswap v2, v3, v4 hooks, Balancer and every L2's local
 *      fork all want different call shapes, and hard-coding one would date this contract the
 *      moment the venue changed. The launchpad's job ends at "here are the tokens and the
 *      quote, put them in a pool and send the LP position somewhere it cannot be pulled".
 */
interface ILiquidityDeployer {
    /// @param lpRecipient Where the LP position goes. A locker, a timelock, or a burn
    ///        address for a permanent lock — the launchpad does not care, but it does record
    ///        which one was used so buyers can check before they buy.
    function deployLiquidity(
        address token,
        address quote,
        uint256 tokenAmount,
        uint256 quoteAmount,
        address lpRecipient
    ) external returns (address pool, uint256 lpAmount);
}
