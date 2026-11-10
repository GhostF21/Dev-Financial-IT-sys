// Where the DApp finds the contract.
// 1. Vite env vars (blockchain/dapp/.env.local) win if set:
//      VITE_CONTRACT_ADDRESS=0x...
//      VITE_CHAIN_ID=31337
//      VITE_RPC_URL=http://127.0.0.1:8545
//      VITE_NETWORK_NAME=Hardhat Localhost
//      VITE_DEPLOY_BLOCK=0
// 2. Otherwise public/finnova-config.json, which `npm run deploy:local`
//    (or deploy:ganache) writes after every deployment.
import { isAddress } from "ethers";

export async function loadConfig() {
  const env = import.meta.env;
  if (env.VITE_CONTRACT_ADDRESS) {
    return validate({
      contractAddress: env.VITE_CONTRACT_ADDRESS,
      chainId: Number(env.VITE_CHAIN_ID || 31337),
      rpcUrl: env.VITE_RPC_URL || "http://127.0.0.1:8545",
      networkName: env.VITE_NETWORK_NAME || "Local chain",
      deployBlock: Number(env.VITE_DEPLOY_BLOCK || 0),
      source: ".env",
    });
  }

  let res;
  try {
    res = await fetch(`${env.BASE_URL}finnova-config.json`, { cache: "no-store" });
  } catch {
    res = null;
  }
  if (!res || !res.ok) {
    throw new Error(
      "No contract configured. Start a local chain and run `npm run deploy:local` in blockchain/, or set VITE_CONTRACT_ADDRESS in dapp/.env.local."
    );
  }
  return validate({ ...(await res.json()), source: "finnova-config.json" });
}

function validate(cfg) {
  if (!isAddress(cfg.contractAddress)) throw new Error(`Configured contract address is invalid: ${cfg.contractAddress}`);
  if (!Number.isInteger(cfg.chainId) || cfg.chainId <= 0) throw new Error(`Configured chain id is invalid: ${cfg.chainId}`);
  return { deployBlock: 0, networkName: `Chain ${cfg.chainId}`, ...cfg };
}
