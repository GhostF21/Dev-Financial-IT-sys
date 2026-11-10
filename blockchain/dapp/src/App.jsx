import { useCallback, useEffect, useMemo, useState } from "react";
import { BrowserProvider, formatEther, getAddress, isAddress } from "ethers";
import { loadConfig } from "./config.js";
import {
  deposit,
  fetchHistory,
  friendlyError,
  getBank,
  parseAmount,
  readBalances,
  transfer,
  withdraw,
} from "./lib/bank.js";

const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const eth = (wei, digits = 4) => {
  if (wei == null) return "–";
  const n = Number(formatEther(wei));
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
};

const ACTIONS = [
  { id: "deposit", label: "Deposit" },
  { id: "withdraw", label: "Withdraw" },
  { id: "transfer", label: "Transfer" },
];

export default function App() {
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState("");
  const [account, setAccount] = useState("");
  const [chainId, setChainId] = useState(null);
  const [balances, setBalances] = useState(null);
  const [checked, setChecked] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [action, setAction] = useState("deposit");
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null); // { kind: "ok" | "bad" | "info", text }

  const hasWallet = typeof window !== "undefined" && !!window.ethereum;
  const wrongNetwork = config && chainId != null && chainId !== config.chainId;
  const ready = !!(config && account && !wrongNetwork);

  // ---- config + wallet listeners -------------------------------------------------
  useEffect(() => {
    loadConfig().then(setConfig, (e) => setConfigError(e.message));
  }, []);

  useEffect(() => {
    if (!hasWallet) return;
    const eth = window.ethereum;
    const onAccounts = (accs) => {
      setAccount(accs[0] ? getAddress(accs[0]) : "");
      setChecked(null);
    };
    const onChain = (id) => setChainId(Number(id));
    eth.request({ method: "eth_accounts" }).then(onAccounts).catch(() => {});
    eth.request({ method: "eth_chainId" }).then(onChain).catch(() => {});
    eth.on?.("accountsChanged", onAccounts);
    eth.on?.("chainChanged", onChain);
    return () => {
      eth.removeListener?.("accountsChanged", onAccounts);
      eth.removeListener?.("chainChanged", onChain);
    };
  }, [hasWallet]);

  // A fresh provider per chain, as recommended by ethers v6 for MetaMask (chainId is an intentional dependency).
  const provider = useMemo(() => (hasWallet ? new BrowserProvider(window.ethereum) : null), [hasWallet, chainId]);

  // ---- data loading --------------------------------------------------------------
  const refresh = useCallback(async () => {
    if (!ready || !provider) return;
    const bank = getBank(config.contractAddress, provider);
    setHistoryLoading(true);
    try {
      const code = await provider.getCode(config.contractAddress);
      if (code === "0x") throw new Error(`No contract at ${config.contractAddress} on this network. Redeploy (npm run deploy:local) and reload.`);
      const [b, h] = await Promise.all([
        readBalances(bank, provider, account),
        fetchHistory(bank, account, config.deployBlock || 0),
      ]);
      setBalances(b);
      setHistory(h);
    } catch (e) {
      setNotice({ kind: "bad", text: e.message?.startsWith("No contract") ? e.message : friendlyError(e) });
    } finally {
      setHistoryLoading(false);
    }
  }, [ready, provider, config, account]);

  useEffect(() => {
    setBalances(null);
    setHistory([]);
    refresh();
  }, [refresh]);

  // ---- wallet actions ------------------------------------------------------------
  async function connect() {
    setNotice(null);
    try {
      const accs = await window.ethereum.request({ method: "eth_requestAccounts" });
      setAccount(getAddress(accs[0]));
      setChainId(Number(await window.ethereum.request({ method: "eth_chainId" })));
    } catch (e) {
      setNotice({ kind: "bad", text: e.code === 4001 ? "Connection request rejected in MetaMask." : friendlyError(e) });
    }
  }

  async function switchNetwork() {
    const hexId = "0x" + config.chainId.toString(16);
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
    } catch (e) {
      if (e.code === 4902 || e?.data?.originalError?.code === 4902) {
        try {
          await window.ethereum.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: hexId,
                chainName: config.networkName,
                rpcUrls: [config.rpcUrl],
                nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
              },
            ],
          });
        } catch (e2) {
          setNotice({ kind: "bad", text: friendlyError(e2) });
        }
      } else {
        setNotice({ kind: "bad", text: friendlyError(e) });
      }
    }
  }

  async function submit(e) {
    e.preventDefault();
    setNotice(null);
    let wei;
    try {
      wei = parseAmount(amount);
      if (action === "transfer") {
        if (!isAddress(recipient.trim())) throw new Error("Enter a valid recipient address (0x…).");
        if (getAddress(recipient.trim()) === account) throw new Error("You cannot transfer to your own address.");
      }
      if (action !== "deposit" && balances && wei > balances.bankBalance) {
        throw new Error(`Insufficient bank balance: you have ${eth(balances.bankBalance, 18)} ETH.`);
      }
    } catch (err) {
      setNotice({ kind: "bad", text: err.message });
      return;
    }

    setBusy(true);
    setNotice({ kind: "info", text: "Confirm the transaction in MetaMask…" });
    try {
      const bank = getBank(config.contractAddress, await provider.getSigner());
      let receipt;
      if (action === "deposit") receipt = await deposit(bank, wei);
      if (action === "withdraw") receipt = await withdraw(bank, wei);
      if (action === "transfer") receipt = await transfer(bank, getAddress(recipient.trim()), wei);
      const verb = { deposit: "Deposited", withdraw: "Withdrew", transfer: "Transferred" }[action];
      setNotice({ kind: "ok", text: `${verb} ${eth(wei, 18)} ETH - tx ${short(receipt.hash)} in block ${receipt.blockNumber}.` });
      setAmount("");
      await refresh();
    } catch (err) {
      setNotice({ kind: "bad", text: friendlyError(err) });
    } finally {
      setBusy(false);
    }
  }

  async function checkBalance() {
    setNotice(null);
    try {
      // checkBalance() uses msg.sender, so call it through the signer.
      const bank = getBank(config.contractAddress, await provider.getSigner());
      const [own, wallet] = await Promise.all([bank.checkBalance(), provider.getBalance(account)]);
      setChecked({ own, wallet, at: new Date() });
      await refresh();
    } catch (err) {
      setNotice({ kind: "bad", text: friendlyError(err) });
    }
  }

  // ---- render --------------------------------------------------------------------
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">F</span> FinNova <span className="pill info">Blockchain</span>
        </div>
        {account ? (
          <span className="pill ok mono-pill" title={account}>
            <span className="dot" /> {short(account)}
          </span>
        ) : (
          hasWallet && (
            <button className="btn sm" onClick={connect}>
              Connect Wallet
            </button>
          )
        )}
      </header>

      <main className="page">
        {configError && <div className="notice bad">{configError}</div>}

        {!hasWallet && (
          <div className="notice warn">
            MetaMask was not detected. Install the{" "}
            <a href="https://metamask.io/download/" target="_blank" rel="noreferrer">
              MetaMask extension
            </a>{" "}
            and reload this page.
          </div>
        )}

        {wrongNetwork && (
          <div className="notice warn row">
            <span>
              Wrong network: MetaMask is on chain {chainId}, but FinNova Bank is deployed on{" "}
              <b>{config.networkName}</b> (chain {config.chainId}).
            </span>
            <button className="btn sm" onClick={switchNetwork}>
              Switch network
            </button>
          </div>
        )}

        <section className="hero">
          <div className="label">FinNova Bank balance</div>
          <div className="balance">
            {ready && balances ? eth(balances.bankBalance) : "–"} <span className="cents">ETH</span>
          </div>
          <div className="chips">
            <span className="chip">Wallet: {ready && balances ? `${eth(balances.walletBalance)} ETH` : "–"}</span>
            <span className="chip">Bank total: {ready && balances ? `${eth(balances.totalDeposits)} ETH` : "–"}</span>
          </div>
        </section>

        {!account && hasWallet && (
          <section className="card center">
            <h2>Connect your wallet</h2>
            <p className="muted">Connect MetaMask to deposit, withdraw and transfer ETH with the FinNova Bank smart contract.</p>
            <button className="btn" onClick={connect}>
              Connect Wallet
            </button>
          </section>
        )}

        {notice && <div className={`notice ${notice.kind}`}>{notice.text}</div>}

        {ready && (
          <>
            <section className="card">
              <div className="card-head">
                <h2>Move money</h2>
                <div className="seg">
                  {ACTIONS.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      className={action === a.id ? "active" : ""}
                      onClick={() => {
                        setAction(a.id);
                        setNotice(null);
                      }}
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              </div>
              <form onSubmit={submit}>
                {action === "transfer" && (
                  <label className="field">
                    <span>Recipient address</span>
                    <input
                      value={recipient}
                      onChange={(e) => setRecipient(e.target.value)}
                      placeholder="0x…"
                      spellCheck="false"
                      autoComplete="off"
                    />
                  </label>
                )}
                <label className="field">
                  <span>
                    {action === "deposit"
                      ? "Amount to deposit from your wallet"
                      : action === "withdraw"
                        ? "Amount to withdraw to your wallet"
                        : "Amount to send inside the bank"}
                  </span>
                  <div className="amount-input">
                    <input
                      inputMode="decimal"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="0.00"
                    />
                    <span className="cur-label">ETH</span>
                  </div>
                </label>
                <button className="btn block" disabled={busy}>
                  {busy ? "Waiting for confirmation…" : ACTIONS.find((a) => a.id === action).label}
                </button>
              </form>
            </section>

            <section className="card">
              <div className="card-head">
                <h2>Check balance</h2>
                <button className="btn soft sm" onClick={checkBalance}>
                  Check balance
                </button>
              </div>
              {checked ? (
                <dl className="kv">
                  <dt>Bank balance (checkBalance())</dt>
                  <dd className="num">{eth(checked.own, 18)} ETH</dd>
                  <dt>Wallet ETH balance</dt>
                  <dd className="num">{eth(checked.wallet, 18)} ETH</dd>
                  <dt>Checked at</dt>
                  <dd>{checked.at.toLocaleTimeString()}</dd>
                </dl>
              ) : (
                <p className="muted small">Calls the contract's checkBalance() as your account and reads your wallet ETH balance.</p>
              )}
            </section>

            <section className="card">
              <div className="card-head">
                <h2>Transaction history</h2>
                <button className="btn ghost sm" onClick={refresh} disabled={historyLoading}>
                  {historyLoading ? "Loading…" : "Refresh"}
                </button>
              </div>
              {history.length === 0 ? (
                <div className="empty">{historyLoading ? "Loading events…" : "No transactions yet. Make a deposit to get started."}</div>
              ) : (
                <div className="list">
                  {history.map((h) => (
                    <HistoryRow key={`${h.txHash}-${h.logIndex}`} item={h} />
                  ))}
                </div>
              )}
            </section>
          </>
        )}

        {config && (
          <section className="card">
            <h3>Contract</h3>
            <dl className="kv small">
              <dt>Address</dt>
              <dd className="mono">{config.contractAddress}</dd>
              <dt>Network</dt>
              <dd>
                {config.networkName} (chain {config.chainId})
              </dd>
              <dt>RPC</dt>
              <dd className="mono">{config.rpcUrl}</dd>
              <dt>Config source</dt>
              <dd>{config.source}</dd>
            </dl>
          </section>
        )}
      </main>
    </div>
  );
}

const ROW_STYLE = {
  Deposit: { cls: "green", sign: "+", icon: "↓" },
  "Transfer in": { cls: "green", sign: "+", icon: "←" },
  Withdrawal: { cls: "red", sign: "−", icon: "↑" },
  "Transfer out": { cls: "blue", sign: "−", icon: "→" },
};

function HistoryRow({ item }) {
  const s = ROW_STYLE[item.type];
  const when = new Date(item.timestamp * 1000).toLocaleString();
  const who =
    item.type === "Transfer out" ? `to ${short(item.counterparty)}` : item.type === "Transfer in" ? `from ${short(item.counterparty)}` : "own wallet";
  return (
    <div className="row-item">
      <div className={`avatar ${s.cls}`}>{s.icon}</div>
      <div className="grow">
        <div className="title">
          {item.type} <span className="muted small">· {who}</span>
        </div>
        <div className="sub" title={item.txHash}>
          Block {item.blockNumber} · {when} · <span className="mono">{short(item.txHash)}</span>
        </div>
      </div>
      <div className={`amount ${s.sign === "+" ? "pos" : "neg"}`}>
        {s.sign}
        {eth(item.amount, 18)} ETH
      </div>
    </div>
  );
}
