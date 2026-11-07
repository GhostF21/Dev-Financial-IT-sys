# FinNova – automated test cases

End-to-end tests for the wallet features. They call the public API through the API
Gateway exactly like the web app does, so every case exercises the real services and
the real PostgreSQL database. Each test creates its own customers, so tests are
independent and can run in any order against any environment.

| Feature | Description | File | Cases |
| --- | --- | --- | --- |
| Digital Wallet | Create and manage a wallet balance for a customer | [`e2e/digital-wallet.test.mjs`](e2e/digital-wallet.test.mjs) | DW-01 – DW-15 |
| P2P Transfer | Transfer funds between two customer wallets | [`e2e/p2p-transfer.test.mjs`](e2e/p2p-transfer.test.mjs) | P2P-01 – P2P-08 |
| QR Payment | Generate and process a payment using a QR code | [`e2e/qr-payment.test.mjs`](e2e/qr-payment.test.mjs) | QR-01 – QR-11 |
| Payment History | Display the customer's previous payment transactions | [`e2e/payment-history.test.mjs`](e2e/payment-history.test.mjs) | PH-01 – PH-09 |

## Running them

**In the pipeline (automatic).** The **Build** workflow runs the `E2E tests (wallet
features)` job on every pull request to `main` and on every push / merge to `main`. It
starts the whole stack with `docker compose`, runs all tests and puts the report in
the run's *Summary*. The images are pushed to ACR – and therefore Release deploys –
only when every test passes.

**Locally** (Node.js 20+), with the stack running (`docker compose up -d --wait`):

```bash
node --test tests/e2e/*.test.mjs
```

Against another environment, e.g. the Azure deployment:

```bash
E2E_BASE_URL=https://api-gateway.<random>.italynorth.azurecontainerapps.io node --test tests/e2e/*.test.mjs
```

(The tests create test customers and move demo money, so only point them at a test /
demo environment.)

## Test cases

Test data: sandbox card `4242 4242 4242 4242` (approved), `4000 0000 0000 0002`
(declined), `4000 0000 0000 9995` (insufficient funds); fixed FX rates 1 EUR = 1.08 USD
= 395 HUF.

### Digital Wallet

| ID | Scenario | Steps | Expected result |
| --- | --- | --- | --- |
| DW-01 | Create wallet | KYC-approved customer, `POST /wallets` (EUR) | 201, balance 0, status `ACTIVE`, `Location` header |
| DW-02 | KYC required | Customer with pending / rejected KYC creates a wallet | 422 `KYC_REQUIRED` |
| DW-03 | One wallet per currency | Create two EUR wallets, then a USD wallet | Second EUR: 409 `WALLET_EXISTS`; USD: 201 |
| DW-04 | Invalid input | Unknown customer / malformed ID / currency `XYZ` | 404 / 422 / 422 `UNSUPPORTED_CURRENCY` |
| DW-05 | List and get wallets | Open EUR + HUF wallets, list by customer, get by ID, get unknown ID | Both listed; correct wallet; 404 |
| DW-06 | Top-up by card | Top up 120.50 with an approved Visa | Balance 120.50, gateway transaction `SUCCEEDED`, `TOP_UP` transaction |
| DW-07 | Declined card | Top up with declined / no-funds cards | 402 `CARD_DECLINED` / `INSUFFICIENT_FUNDS`, gateway `FAILED`, balance unchanged |
| DW-08 | Card and amount validation | Invalid card number; amounts 0, -5, 10.123, "abc"; 5000.01 | 422 `INVALID_CARD_NUMBER`; 422; 402 `AMOUNT_LIMIT_EXCEEDED`; balance unchanged |
| DW-09 | Top-up from own bank account | Bank account with 300, top up 75 | Wallet 75, bank account 225 |
| DW-10 | Someone else's bank account | Top up from another customer's account | 403 `ACCOUNT_NOT_OWNED`, account untouched |
| DW-11 | Currency conversion | USD bank account (500) tops up EUR wallet with 50 | Wallet 50 EUR, bank account debited 54 USD |
| DW-12 | Idempotent top-up | Same request twice with one `idempotencyKey` | 201 then 200 with the same gateway transaction; charged once |
| DW-13 | Withdraw | Wallet 100, withdraw 30 to own bank account | Wallet 70, bank account +30, `WITHDRAWAL` `SUCCEEDED` |
| DW-14 | Withdraw too much | Wallet 20, withdraw 20.01 | 402 `INSUFFICIENT_FUNDS`, nothing moves |
| DW-15 | Freeze / unfreeze | Freeze, top up, unfreeze, top up; invalid status | 422 `WALLET_INACTIVE` while frozen; works after unfreeze; invalid status 422 |

### P2P Transfer

| ID | Scenario | Steps | Expected result |
| --- | --- | --- | --- |
| P2P-01 | Transfer | Alice (100) sends 25.50 to Bob with a note | 201 `P2P` `COMPLETED`; Alice 74.50, Bob 25.50 |
| P2P-02 | Insufficient funds | Alice (10) sends 10.01 | 402 `INSUFFICIENT_FUNDS`; balances unchanged |
| P2P-03 | Invalid requests | Same wallet; amounts 0, -1, 1.001; unknown / malformed wallet; 256-char note | 422 `SAME_WALLET`; 422; 404 `WALLET_NOT_FOUND` / 422; 422 |
| P2P-04 | Frozen wallet | Send to a frozen wallet | 422 `WALLET_INACTIVE`; nothing moves |
| P2P-05 | Idempotent retry | Send 30 twice with one key, then 31 with the same key | 201, then 200 with the same transfer; moved once; 409 `IDEMPOTENCY_CONFLICT` |
| P2P-06 | Concurrency | 5 simultaneous transfers of 30 from a wallet with 100 | Exactly 3 succeed, 2 get 402; sender 10, receiver 90 |
| P2P-07 | Cross-currency | EUR wallet sends 20 to a HUF wallet | Sender −20 EUR, receiver +7900 HUF |
| P2P-08 | Ledger and notifications | Transfer 15 | Ledger: DEBIT on sender, CREDIT on receiver; `WALLET_TRANSFER_SENT` / `_RECEIVED` notifications |

### QR Payment

| ID | Scenario | Steps | Expected result |
| --- | --- | --- | --- |
| QR-01 | Generate | Payee creates a 12.50 request, valid 15 min | 201 `PENDING`, `finnova://pay?token=…` payload, PNG data URL, expiry ≈ 15 min |
| QR-02 | Validation | Amount 0 / -3; expiry 0, 1441, 1.5 min; frozen payee wallet | 422; 422; 422 `WALLET_INACTIVE` |
| QR-03 | Look up / image | Get by token, by full payload; download PNG; unknown token | Same request; `image/png` with PNG signature; 404 |
| QR-04 | List requests | Create two requests, list the wallet's requests | Newest first |
| QR-05 | Pay | Payer (50) pays a 12.50 request | 201; request `PAID` by payer; `QR_PAYMENT` transfer; payer 37.50, payee 12.50 |
| QR-06 | Pay only once | Pay the same code twice | Second: 409 `QR_ALREADY_PAID`; charged once |
| QR-07 | Concurrent payers | Two payers pay the same code at the same time | One 201, one 409; payee credited once |
| QR-08 | Insufficient funds | Payer (5) pays a 10 request | 402; request stays `PENDING`; payer unchanged |
| QR-09 | Own / unknown code | Payee pays own code; unknown token | 422 `SAME_WALLET`; 404 |
| QR-10 | Cancel | Cancel then pay; pay then cancel | 410 `QR_CANCELLED`; 409 `QR_NOT_PENDING` |
| QR-11 | Cross-currency | EUR payer pays a 1975 HUF request | Payer charged 5 EUR, payee receives exactly 1975 HUF |

Expiry after the time limit is not automated (the shortest expiry is 1 minute); test it
manually: create a request with `expiresInMinutes: 1`, wait a minute, pay → 410 `QR_EXPIRED`.

### Payment History

Shared scenario: Alice gets a card top-up of 100 → sends 30 to Bob → receives a 10 QR
payment from Bob → withdraws 20 to her bank account.

| ID | Scenario | Steps | Expected result |
| --- | --- | --- | --- |
| PH-01 | Full history | `GET /wallets/{id}/transactions` | 4 entries newest first: `WITHDRAWAL`, `QR_PAYMENT_RECEIVED`, `P2P_SENT`, `TOP_UP`; balances 60, 80, 70, 100 |
| PH-02 | References | Inspect the entries | Counterparty wallet, transfer reference, note and payment method are set |
| PH-03 | Other side | Bob's history | Mirror entries `P2P_RECEIVED` (credit) and `QR_PAYMENT_SENT` (debit) |
| PH-04 | Filter by type | `?type=P2P_SENT` | Only that entry; `totalItems` 1 |
| PH-05 | Pagination | `pageSize=3`, pages 1 and 2 | 3 + 1 entries, no duplicates, `totalPages` 2 |
| PH-06 | Date range | `from` tomorrow; last hour → tomorrow; `from=yesterday` | 0 entries; 4 entries; 422 |
| PH-07 | Card & bank log | Declined top-up, then `GET /wallets/{id}/gateway-transactions` | `TOP_UP:FAILED` (`CARD_DECLINED`), `WITHDRAWAL:SUCCEEDED`, `TOP_UP:SUCCEEDED`; failed attempt not in the wallet history |
| PH-08 | Empty / unknown | New wallet; unknown wallet ID | Empty list, `totalItems` 0; 404 |
| PH-09 | Bank statement | `GET /transactions?accountId=` of Alice's bank account | The withdrawal appears as a 20 credit |
