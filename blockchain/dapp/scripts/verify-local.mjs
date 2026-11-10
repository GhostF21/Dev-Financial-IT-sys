// End-to-end check of the DApp's contract code (src/lib/bank.js) against a
// running local chain, without a browser or MetaMask. Uses the node's
// unlocked test accounts #0 and #1 instead of MetaMask.
//
//   cd blockchain && npm run node          (terminal 1)
//   cd blockchain && npm run deploy:local  (terminal 2)
//   cd blockchain && npm run verify:local
import fs from "node:fs";
import { JsonRpcProvider, formatEther, parseEther } from "ethers";
import {
  deposit,
  fetchHistory,
  friendlyError,
  getBank,
  parseAmount,
  readBalances,
  transfer,
  withdraw,
} from "../src/lib/bank.js";

const cfgFile = new URL("../public/finnova-config.json", import.meta.url);
if (!fs.existsSync(cfgFile)) {
  console.error("public/finnova-config.json not found - run `npm run deploy:local` in blockchain/ first.");
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(cfgFile, "utf8"));

let failures = 0;
function check(label, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!condition) failures++;
}

const provider = new JsonRpcProvider(config.rpcUrl);
const { chainId } = await provider.getNetwork();
check("node chain id matches config", Number(chainId) === config.chainId, `node ${chainId}, config ${config.chainId}`);
check("contract code exists at configured address", (await provider.getCode(config.contractAddress)) !== "0x", config.contractAddress);

const alice = await provider.getSigner(0);
const bob = await provider.getSigner(1);
const A = await alice.getAddress();
const B = await bob.getAddress();
const bankA = getBank(config.contractAddress, alice);
const bankB = getBank(config.contractAddress, bob);

const before = await readBalances(bankA, provider, A);
const beforeB = await readBalances(bankB, provider, B);

// Deposit 1 ETH, transfer 0.25 ETH to Bob, withdraw 0.4 ETH.
const r1 = await deposit(bankA, parseAmount("1"));
const r2 = await transfer(bankA, B, parseAmount("0.25"));
const r3 = await withdraw(bankA, parseAmount("0.4"));
check("deposit / transfer / withdraw mined", [r1, r2, r3].every((r) => r.status === 1), `blocks ${r1.blockNumber}, ${r2.blockNumber}, ${r3.blockNumber}`);

const after = await readBalances(bankA, provider, A);
const afterB = await readBalances(bankB, provider, B);
check("Alice bank balance +0.35 ETH", after.bankBalance - before.bankBalance === parseEther("0.35"), `${formatEther(after.bankBalance)} ETH`);
check("Bob bank balance +0.25 ETH", afterB.bankBalance - beforeB.bankBalance === parseEther("0.25"), `${formatEther(afterB.bankBalance)} ETH`);
check("contract total +0.6 ETH", after.totalDeposits - before.totalDeposits === parseEther("0.6"), `${formatEther(after.totalDeposits)} ETH`);
check("checkBalance() (msg.sender) equals balanceOf()", (await bankA.checkBalance()) === after.bankBalance);

// Wallet: -1 + 0.4 ETH minus gas.
const walletDelta = after.walletBalance - before.walletBalance;
check("Alice wallet changed by about -0.6 ETH (plus gas)", walletDelta < -parseEther("0.6") && walletDelta > -parseEther("0.61"), `${formatEther(walletDelta)} ETH`);

// History, newest first.
const histA = await fetchHistory(bankA, A, config.deployBlock);
const top3 = histA.slice(0, 3).map((h) => h.type);
check("Alice history newest first: Withdrawal, Transfer out, Deposit", JSON.stringify(top3) === JSON.stringify(["Withdrawal", "Transfer out", "Deposit"]), top3.join(", "));
check("history rows carry tx hash + counterparty", histA[1].txHash === r2.hash && histA[1].counterparty === B);
const histB = await fetchHistory(bankB, B, config.deployBlock);
check("Bob history shows Transfer in from Alice", histB[0].type === "Transfer in" && histB[0].counterparty === A && histB[0].amount === parseEther("0.25"));

// Error handling: over-withdraw and self-transfer give readable messages.
try {
  await withdraw(bankA, parseEther("1000000"));
  check("over-withdraw reverts", false);
} catch (e) {
  const msg = friendlyError(e);
  check("over-withdraw -> readable InsufficientBalance message", msg.startsWith("Insufficient bank balance"), msg);
}
try {
  await transfer(bankA, A, parseEther("0.01"));
  check("self transfer reverts", false);
} catch (e) {
  const msg = friendlyError(e);
  check("self transfer -> readable SelfTransfer message", msg === "You cannot transfer to your own address.", msg);
}
try {
  parseAmount("abc");
  check("invalid amount rejected", false);
} catch (e) {
  check("invalid amount rejected before sending", true, e.message);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
