// Deploys FinNovaBank to the selected network and writes everything the React
// DApp needs:
//   dapp/public/finnova-config.json  - address, chain id, deploy block (read at runtime)
//   dapp/src/abi/FinNovaBank.json    - contract ABI (bundled into the app)
//
//   npm run node            (terminal 1: local Hardhat chain)
//   npm run deploy:local    (terminal 2)
//   npm run deploy:ganache  (Ganache on 127.0.0.1:7545 instead)
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const { ethers, network } = hre;
  const [deployer] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();

  console.log(`Network:  ${network.name} (chain id ${chainId})`);
  console.log(`Deployer: ${deployer.address}`);

  const bank = await ethers.deployContract("FinNovaBank");
  await bank.waitForDeployment();
  const address = await bank.getAddress();
  const receipt = await bank.deploymentTransaction().wait();

  console.log(`FinNovaBank deployed at ${address} (block ${receipt.blockNumber})`);

  const dappDir = path.join(__dirname, "..", "dapp");
  const config = {
    contractAddress: address,
    chainId: Number(chainId),
    networkName: network.name === "localhost" ? "Hardhat Localhost" : network.name === "ganache" ? "Ganache" : network.name,
    rpcUrl: network.config.url || "http://127.0.0.1:8545",
    deployBlock: receipt.blockNumber,
    deployedAt: new Date().toISOString(),
  };
  writeJson(path.join(dappDir, "public", "finnova-config.json"), config);

  const artifact = await hre.artifacts.readArtifact("FinNovaBank");
  writeJson(path.join(dappDir, "src", "abi", "FinNovaBank.json"), artifact.abi);

  console.log("Wrote dapp/public/finnova-config.json and dapp/src/abi/FinNovaBank.json");
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
