import type { HardhatUserConfig } from "hardhat/config";
import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";

/**
 * The deployer key is read from the environment and never from a file in this repository.
 * `.gitignore` covers `.env*`; nothing here should ever hold a key literal.
 */
const deployerKey = process.env.DEPLOYER_PRIVATE_KEY;
const accounts = deployerKey ? [deployerKey as `0x${string}`] : [];

const config: HardhatUserConfig = {
  plugins: [hardhatToolboxViem],
  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
        settings: {
          optimizer: { enabled: true, runs: 200 },
          viaIR: true,
          evmVersion: "cancun",
        },
      },
    },
  },
  networks: {
    unichainSepolia: {
      type: "http",
      chainType: "op",
      url: process.env.UNICHAIN_SEPOLIA_RPC ?? "https://sepolia.unichain.org",
      chainId: 1301,
      accounts,
    },
    robinhoodTestnet: {
      type: "http",
      chainType: "generic",
      url: process.env.ROBINHOOD_TESTNET_RPC ?? "https://rpc.testnet.chain.robinhood.com",
      chainId: 46630,
      accounts,
    },
    bscTestnet: {
      type: "http",
      chainType: "generic",
      url: process.env.BSC_TESTNET_RPC ?? "https://bsc-testnet-rpc.publicnode.com",
      chainId: 97,
      accounts,
    },
    baseSepolia: {
      type: "http",
      chainType: "op",
      url: process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org",
      chainId: 84532,
      accounts,
    },
    opSepolia: {
      type: "http",
      chainType: "op",
      url: process.env.OP_SEPOLIA_RPC ?? "https://sepolia.optimism.io",
      chainId: 11155420,
      accounts,
    },
    arbitrumSepolia: {
      type: "http",
      chainType: "generic",
      url: process.env.ARBITRUM_SEPOLIA_RPC ?? "https://sepolia-rollup.arbitrum.io/rpc",
      chainId: 421614,
      accounts,
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: process.env.SEPOLIA_RPC ?? "https://ethereum-sepolia-rpc.publicnode.com",
      chainId: 11155111,
      accounts,
    },
  },
};

export default config;
