// Framework-free helpers around the FinNovaBank contract. Used by the React UI
// and by scripts/verify-local.mjs (which runs them against a local node
// without MetaMask).
import { Contract, Interface, formatEther, parseEther } from "ethers";
import abi from "../abi/FinNovaBank.json" with { type: "json" };

export const bankInterface = new Interface(abi);

/** Contract instance bound to a signer (for transactions) or provider (read-only). */
export function getBank(address, runner) {
  return new Contract(address, abi, runner);
}

/** Parse a user-typed ETH amount ("0.25") into wei, with readable validation errors. */
export function parseAmount(text) {
  const value = String(text ?? "").trim().replace(",", ".");
  if (!value) throw new Error("Enter an amount.");
  if (!/^\d*\.?\d+$/.test(value)) throw new Error("Enter a valid number, e.g. 0.5");
  let wei;
  try {
    wei = parseEther(value);
  } catch {
    throw new Error("Too many decimals (max 18).");
  }
  if (wei <= 0n) throw new Error("Amount must be greater than zero.");
  return wei;
}

/** Bank balance of `account` inside the contract, the wallet's own ETH and the contract total (all wei). */
export async function readBalances(bank, provider, account) {
  const [bankBalance, walletBalance, totalDeposits] = await Promise.all([
    bank.balanceOf(account),
    provider.getBalance(account),
    bank.totalDeposits(),
  ]);
  return { bankBalance, walletBalance, totalDeposits };
}

/** Send a contract transaction, wait for it to be mined and return the receipt. */
export async function sendAndWait(promise) {
  const tx = await promise;
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error("Transaction failed on-chain.");
  return receipt;
}

export const deposit = (bank, wei) => sendAndWait(bank.deposit({ value: wei }));
export const withdraw = (bank, wei) => sendAndWait(bank.withdraw(wei));
export const transfer = (bank, to, wei) => sendAndWait(bank.transfer(to, wei));

/**
 * Rebuild the transaction history of `account` from the contract's events.
 * Returns newest first: { type, amount, counterparty, txHash, blockNumber, timestamp, logIndex }
 * type is "Deposit" | "Withdrawal" | "Transfer out" | "Transfer in".
 */
export async function fetchHistory(bank, account, fromBlock = 0) {
  const f = bank.filters;
  const [deposits, withdrawals, sent, received] = await Promise.all([
    bank.queryFilter(f.Deposit(account), fromBlock),
    bank.queryFilter(f.Withdrawal(account), fromBlock),
    bank.queryFilter(f.Transfer(account, null), fromBlock),
    bank.queryFilter(f.Transfer(null, account), fromBlock),
  ]);

  const item = (ev, type, counterparty) => ({
    type,
    amount: ev.args.amount,
    counterparty,
    txHash: ev.transactionHash,
    blockNumber: ev.blockNumber,
    logIndex: ev.index,
    timestamp: Number(ev.args.timestamp),
  });

  const rows = [
    ...deposits.map((ev) => item(ev, "Deposit", null)),
    ...withdrawals.map((ev) => item(ev, "Withdrawal", null)),
    ...sent.map((ev) => item(ev, "Transfer out", ev.args.to)),
    ...received.map((ev) => item(ev, "Transfer in", ev.args.from)),
  ];
  return rows.sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);
}

const ERROR_TEXT = {
  ZeroAmount: () => "Amount must be greater than zero.",
  InsufficientBalance: (args) =>
    `Insufficient bank balance: you have ${formatEther(args[0])} ETH but tried to use ${formatEther(args[1])} ETH.`,
  InvalidRecipient: () => "Recipient address is not valid.",
  SelfTransfer: () => "You cannot transfer to your own address.",
  WithdrawFailed: () => "The contract could not send ETH back to your wallet.",
  Reentrancy: () => "Reentrant call blocked.",
};

/** Find revert data anywhere in the (deeply nested) error objects MetaMask / ethers produce. */
function findRevertData(err, depth = 0) {
  if (!err || typeof err !== "object" || depth > 6) return null;
  if (typeof err.data === "string" && err.data.startsWith("0x") && err.data.length >= 10) return err.data;
  for (const key of ["data", "error", "info", "cause", "originalError", "payload"]) {
    const found = findRevertData(err[key], depth + 1);
    if (found) return found;
  }
  return null;
}

/** Turn any wallet / RPC / contract error into one clear sentence for the UI. */
export function friendlyError(err) {
  if (!err) return "Unknown error.";
  if (err.code === "ACTION_REJECTED" || err.code === 4001 || err?.info?.error?.code === 4001) {
    return "Transaction rejected in MetaMask.";
  }

  let decoded = err.revert;
  if (!decoded) {
    const data = findRevertData(err);
    if (data) {
      try {
        decoded = bankInterface.parseError(data);
      } catch {
        /* not one of our errors */
      }
    }
  }
  if (decoded?.name && ERROR_TEXT[decoded.name]) return ERROR_TEXT[decoded.name](decoded.args ?? []);
  if (decoded?.name === "Error" && decoded.args?.[0]) return `Reverted: ${decoded.args[0]}`;
  if (err.reason) return `Reverted: ${err.reason}`;

  if (err.code === "INSUFFICIENT_FUNDS") return "Not enough ETH in your wallet to pay for this (amount + gas).";
  if (err.code === "NETWORK_ERROR" || err.code === "SERVER_ERROR")
    return "Cannot reach the blockchain node. Is the local chain running?";
  if (err.code === "BAD_DATA") return "No FinNovaBank contract found at the configured address on this network. Redeploy and refresh.";
  if (err.code === "INVALID_ARGUMENT") return "Invalid input: " + (err.shortMessage || err.message);

  const msg = err.shortMessage || err?.info?.error?.message || err.message || String(err);
  if (/nonce/i.test(msg))
    return "Nonce mismatch - the local chain was restarted. In MetaMask: Settings > Advanced > Clear activity tab data, then retry.";
  return msg;
}
