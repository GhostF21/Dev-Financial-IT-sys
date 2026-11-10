# FinNova Bank - Blockchain

## 1. The contract

| Function | What it does |
|---|---|
| `deposit()` *payable* | Adds the ETH sent with the call (`msg.value`) to the caller's bank balance. Emits `Deposit`. |
| `withdraw(uint256 amount)` | Takes `amount` wei off the caller's balance and sends it back to their wallet. Emits `Withdrawal`. |
| `transfer(address to, uint256 amount)` | Moves `amount` wei of bank balance from the caller to `to` (ETH stays in the contract). Emits `Transfer`. |
| `checkBalance()` *view* | The caller's own bank balance (wei). |
| `balanceOf(address)` *view* | Bank balance of any address. |
| `totalDeposits()` *view* | ETH held by the contract (= sum of all balances). |

Safety:
- **Checks-effects-interactions** in `withdraw`: the balance is reduced *before* ETH is sent, plus a
  `nonReentrant` lock. A test deploys an attacker contract that tries to re-enter `withdraw` and shows the attack fails.
- **Custom errors**: `ZeroAmount`, `InsufficientBalance(available, requested)`, `InvalidRecipient`, `SelfTransfer`,
  `WithdrawFailed`, `Reentrancy`. Plain ETH sent without `deposit()` is rejected (`"Use deposit()"`).
- **Events** `Deposit`, `Withdrawal`, `Transfer` (each with amount and block timestamp) are the on-chain transaction
  history; the DApp rebuilds the history from them.

All amounts are in **wei** (1 ETH = 1 000 000 000 000 000 000 wei).

## 2. Automated tests (Hardhat)

Requires Node.js (tested with v25; Hardhat prints an "unsupported Node.js version" warning that can be ignored, or use Node 22 LTS).

```bash
cd blockchain
npm install
npm test
```

Expected: `17 passing` - covers deposit, withdraw, transfer, both balance views, every revert
(zero amount, insufficient balance, zero address, self transfer, plain ETH), reentrancy safety and reading the
history back from events.

## 3. Remix IDE (manual, in the browser)

### 3.1 Compile
1. Open <https://remix.ethereum.org>.
2. In the **File explorer** create `contracts/FinNovaBank.sol` and paste the content of
   [`contracts/FinNovaBank.sol`](contracts/FinNovaBank.sol).
3. Open the **Solidity compiler** tab (left sidebar), pick compiler `0.8.24` (any 0.8.20+ works), click
   **Compile FinNovaBank.sol**. A green check appears on the tab.

### 3.2 (Optional) Run the Remix unit tests
1. Create `tests/FinNovaBank_test.sol` in Remix and paste [`tests/FinNovaBank_test.sol`](tests/FinNovaBank_test.sol).
2. Enable the **Solidity unit testing** plugin (Plugin manager → "Solidity unit testing" → Activate).
3. Select `tests/FinNovaBank_test.sol` and click **Run**. All 6 checks should be green.

### 3.3 Deploy on Remix VM (no wallet needed)
1. Open **Deploy & run transactions**. Environment: **Remix VM (Cancun or later)**. You get 10 test accounts with 100 ETH each.
2. Contract: `FinNovaBank`, click **Deploy**. The contract appears under 

### 3.4 Execute each operation and verify
Use the deployed contract panel (expand it with the arrow). Remember the **Account** dropdown at the top decides who `msg.sender` is.

| Step | How | Verify |
|---|---|---|
| Deposit | Account #1 selected. In **Value** type `2` and pick **Ether**, click the red **deposit** button. | Terminal shows the tx with a green tick; expand it → *logs* shows a `Deposit` event. Account #1's ETH drops by ~2. |
| Check balance | Click **checkBalance**. | Returns `2000000000000000000` (2 ETH in wei).  |
| Withdraw | Set Value back to `0`. In **withdraw** enter `500000000000000000` (0.5 ETH), click it. | `checkBalance` → `1500000000000000000`; wallet ETH went up by 0.5; `Withdrawal` event in the logs.  |
| Transfer | Copy account #2's address (copy icon next to the Account dropdown, then switch back to #1). In **transfer** enter `<address of #2>, 1000000000000000000`, click it. | `balanceOf(<#1>)` → `0.5 ETH` in wei, `balanceOf(<#2>)` → `1000000000000000000`; `Transfer` event in the logs.  |
| Error case | As #1, call **withdraw** with `5000000000000000000` (5 ETH). | Tx reverts; terminal shows `InsufficientBalance` with available/requested. |
| Recipient side | Switch Account to #2, click **checkBalance**, then **withdraw** `1000000000000000000`. | #2 gets the ETH; `totalDeposits` → `0.5 ETH` in wei. |

Tip: Remix's built-in unit converter (or <https://eth-converter.com>) converts ETH ↔ wei.

### 3.5 Deploy on Ganache + MetaMask (local blockchain with a real wallet)

You can use **Ganache** or the **Hardhat node** from this folder; both work the same way with MetaMask.

**A. Start a local chain**
- *Ganache GUI*: download from <https://archive.trufflesuite.com/ganache/>, start a **Quickstart (Ethereum)** workspace.
  RPC server `HTTP://127.0.0.1:7545`, chain id **1337**. 
- *or Hardhat node*: `cd blockchain && npm run node` → RPC `http://127.0.0.1:8545`, chain id **31337**. It prints
  20 test accounts with 10 000 ETH each, together with their private keys (public, well-known test keys - never send real funds to them).

**B. Add the local network to MetaMask** (MetaMask extension → network selector → **Add a custom network**):

| Field | Ganache | Hardhat node |
|---|---|---|
| Network name | Ganache | Hardhat Localhost |
| Default RPC URL | `http://127.0.0.1:7545` | `http://127.0.0.1:8545` |
| Chain ID | `1337` | `31337` |
| Currency symbol | ETH | ETH |

MetaMask may warn that the chain id belongs to another network name - that is fine for a local chain.

**C. Import a test account** (do this yourself; never paste keys into chats or commit them):
- Ganache: click the 🔑 key icon on an account row and copy the private key.
- Hardhat node: copy a `Private Key` line from the `npm run node` terminal output.
- MetaMask → account selector → **Add account or hardware wallet** → **Import account** → paste the key.
  The imported account should show ~100 ETH (Ganache) or 10 000 ETH (Hardhat). 
- Import a second account the same way to have a transfer recipient.

**D. Deploy from Remix through MetaMask**
1. Remix → Deploy & run → Environment: **Injected Provider - MetaMask**. Approve the connection in MetaMask; Remix
   shows the chain id (1337 / 31337) and your imported account.
2. Click **Deploy** and confirm in MetaMask. 
3. Repeat the operations from 3.4 - each one now opens a MetaMask confirmation. Verify balances in Remix
   (`checkBalance`, `balanceOf`) **and** in MetaMask (wallet ETH). In Ganache, the **Transactions** and **Blocks** tabs show
   each call; the **Events** tab shows them once you add the project/contract. 

> Restarted Ganache/Hardhat node? Reset MetaMask's local history: Settings → Advanced → **Clear activity tab data**,
> otherwise transactions fail with a nonce error.

## 4. React DApp

`dapp/` is a Vite + React app using **ethers.js v6** and MetaMask, styled like the FinNova web app
(light canvas, white rounded cards, blue `#0666eb` accent, Inter; dark mode follows the OS).

Features: **Connect Wallet**, **Deposit**, **Withdraw**, **Transfer** to another address, **Check Balance** (calls
`checkBalance()` as you + wallet ETH balance; the header card also shows bank and contract totals), and
**Transaction history** rebuilt from the contract's events - newest first, with type, amount, counterparty, block, time and
tx hash. Wrong network → warning with a **Switch network** button (adds the network to MetaMask if missing);
rejected transactions, insufficient balance, invalid addresses/amounts and a missing contract show clear messages.

### Run it end to end locally

```bash
# terminal 1 - local chain (keep it running)
cd blockchain
npm install
npm run node
```

```bash
# terminal 2 - deploy, then start the DApp
cd blockchain
npm run deploy:local
npm --prefix dapp install
npm run dapp
```

Open <http://localhost:5173>, make sure MetaMask is on **Hardhat Localhost (31337)** with an imported Hardhat
test account (section 3.5 B/C), click **Connect Wallet**, then deposit / withdraw / transfer / check balance and watch the history fill up. 

`npm run deploy:local` writes:
- `dapp/public/finnova-config.json` - contract address, chain id, RPC URL, deploy block (read by the app at runtime, git-ignored);
- `dapp/src/abi/FinNovaBank.json` - the ABI.

Redeploying (e.g. after restarting the node) just needs a browser refresh.

**Ganache instead of the Hardhat node:** start Ganache on 7545 and run `npm run deploy:ganache`
(set `GANACHE_URL` / `GANACHE_CHAIN_ID` if yours differ, e.g. Ganache CLI on 8545).

**Contract deployed from Remix instead:** copy `dapp/env.example` to `dapp/.env.local`, put in the address and chain id
from Remix, then restart `npm run dapp`. Env vars override `finnova-config.json`.

### Check without MetaMask

With the node running and the contract deployed:

```bash
cd blockchain
npm run verify:local
```

This runs the DApp's own contract code (`dapp/src/lib/bank.js`) against the node with test accounts #0 and #1:
deposit 1 ETH, transfer 0.25 ETH, withdraw 0.4 ETH, compares all balances, checks the history order and that
reverts turn into readable messages. Expected last line: `All checks passed`.

### Production build

```bash
cd blockchain/dapp
npm run build
```

Output goes to `dapp/dist/` (static files). Copy a `finnova-config.json` into `dist/` or build with `VITE_*` env vars to point it at a deployment.

