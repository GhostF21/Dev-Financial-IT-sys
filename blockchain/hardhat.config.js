require("@nomicfoundation/hardhat-toolbox");

/**
 * FinNova Bank - Hardhat config.
 *  - "hardhat": in-process chain used by `npm test`
 *  - "localhost": `npm run node` (Hardhat node, chain id 31337, port 8545)
 *  - "ganache": Ganache GUI/CLI (chain id 1337, port 7545 by default)
 */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    localhost: { url: "http://127.0.0.1:8545", chainId: 31337 },
    ganache: {
      url: process.env.GANACHE_URL || "http://127.0.0.1:7545",
      chainId: Number(process.env.GANACHE_CHAIN_ID || 1337),
    },
  },
};
