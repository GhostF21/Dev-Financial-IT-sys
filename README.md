# FinNova Bank: Docker and Kubernetes Deployment

FinNova is an API-only banking backend organized around bounded contexts. It uses
PostgreSQL for persistence and nginx as the public API Gateway.

## Prerequisites

- Docker Desktop (or Docker Engine) with Docker Compose v2
- Minikube with the Docker driver
- kubectl

Run all commands from the repository root.

## Services

| Service | Purpose | Local address |
| --- | --- | --- |
| API Gateway | Public entry point and Swagger UI | `http://localhost:8080` |
| Customer Service | Customer onboarding and KYC | Internal; port 3002 |
| Identity Service | Credentials and login sessions | Internal; port 3003 |
| Account Service | Accounts, balances, and atomic transfers | Internal; port 3000 is also published locally |
| Payment Service | Payments and transaction history | Internal; port 3001 is also published locally |
| Wallet Service | Digital wallets, P2P transfers, QR payments, wallet history | Internal; port 3006 |
| Ledger Service | Internal ledger adapter | Internal; port 3005 |
| Notification Service | Internal payment notifications | Internal; port 3004 |
| PostgreSQL | Persistent application data | port 5432 |
| Wallet web app | Browser client for the wallet features | `http://localhost:8080/wallet/` |

The gateway routes `/customers` to Customer Service, `/auth` to Identity Service,
`/accounts` to Account Service, `/payments` plus `/transactions` to Payment
Service, and `/wallets` plus `/qr-payments` to Wallet Service. It also serves the
wallet web app at `/wallet/`. Ledger and notification endpoints are not publicly
exposed.

## Domain flow

Customer Service creates a customer and records KYC. Identity Service can then
register credentials and create an expiring login session for that customer.
Account Service only opens an account for a customer with approved KYC and owns
the account balance. Payment Service asks Account Service to perform one atomic
debit-and-credit transfer, then stores the payment and transaction history.
It sends ledger entries and customer notifications to their internal services.

Wallet Service opens a digital wallet for a customer with approved KYC. Money
enters and leaves wallets only through the payment gateway (see
[Digital Wallet and Payments](#digital-wallet-and-payments)), and moves between
wallets with atomic P2P transfers and QR payments.

The services communicate through internal Docker/Kubernetes service names. The
gateway is the only intended public entry point; PostgreSQL is persistent local
in Compose and uses `postgres-pv`/`postgres-pvc` in Kubernetes.

## Run locally with Docker Compose

Build and start the full stack:

```bash
docker compose up --build -d
docker compose ps
```

All application services and PostgreSQL should report `healthy`. Stop the stack while keeping its data:

```bash
docker compose down
```

Remove the stack and its local PostgreSQL data:

```bash
docker compose down -v --rmi local
```

If Docker builds run behind a corporate TLS-inspecting proxy and npm reports a
certificate validation error, use this temporary PowerShell setting for the
build only:

```powershell
$env:NPM_CONFIG_STRICT_SSL = 'false'
docker compose up --build -d
Remove-Item Env:NPM_CONFIG_STRICT_SSL
```

Certificate validation remains enabled by default.

### Swagger UI

Open [http://localhost:8080/docs/](http://localhost:8080/docs/) in a browser.
The OpenAPI specification is available at
[http://localhost:8080/docs/openapi.yaml](http://localhost:8080/docs/openapi.yaml).

### Local API smoke test

The following PowerShell example completes onboarding, KYC, account opening, and
a payment through the gateway:

```powershell
$customer = Invoke-RestMethod -Method Post -Uri http://localhost:8080/customers `
  -ContentType 'application/json' `
  -Body '{"firstName":"Jane","lastName":"Doe","email":"jane.doe@example.com","dateOfBirth":"1990-05-12"}'

Invoke-RestMethod -Method Post -Uri "http://localhost:8080/customers/$($customer.id)/kyc" `
  -ContentType 'application/json' `
  -Body '{"documentType":"PASSPORT","result":"APPROVED"}'

Invoke-RestMethod -Method Post -Uri http://localhost:8080/auth/register `
  -ContentType 'application/json' `
  -Body (@{ customerId = $customer.id; username = 'jane.doe'; password = 'demo-password' } | ConvertTo-Json)

$accountA = Invoke-RestMethod -Method Post -Uri http://localhost:8080/accounts `
  -ContentType 'application/json' `
  -Body (@{ customerId = $customer.id; accountType = 'CHECKING'; currency = 'EUR'; initialDeposit = 500 } | ConvertTo-Json)

$accountB = Invoke-RestMethod -Method Post -Uri http://localhost:8080/accounts `
  -ContentType 'application/json' `
  -Body (@{ customerId = $customer.id; accountType = 'SAVINGS'; currency = 'EUR' } | ConvertTo-Json)

Invoke-RestMethod -Method Post -Uri http://localhost:8080/payments `
  -ContentType 'application/json' `
  -Body (@{ fromAccountId = $accountA.id; toAccountId = $accountB.id; amount = 125.50; currency = 'EUR'; description = 'Rent payment' } | ConvertTo-Json)

Invoke-RestMethod -Uri "http://localhost:8080/accounts/$($accountA.id)"
Invoke-RestMethod -Uri "http://localhost:8080/transactions?accountId=$($accountA.id)"
```

### Inspect the local database

```bash
docker compose exec postgres psql -U finnova -d finnova
```

Useful SQL queries:

```sql
SELECT * FROM customers;
SELECT * FROM accounts;
SELECT * FROM payments;
SELECT * FROM transactions;
SELECT * FROM ledger_entries;
SELECT * FROM notifications;
SELECT * FROM wallets;
SELECT * FROM wallet_transactions ORDER BY created_at DESC;
SELECT * FROM wallet_transfers;
SELECT * FROM qr_payment_requests;
SELECT * FROM gateway_transactions;
SELECT * FROM wallet_settlement_accounts;
```

## Digital Wallet and Payments

The Wallet Service adds a digital wallet and payment workflow to the platform.

| Feature | Description | API |
| --- | --- | --- |
| Digital Wallet | Create a wallet for a customer and manage its balance (top up, withdraw, freeze) | `POST /wallets`, `GET /wallets/{id}`, `POST /wallets/{id}/top-up`, `POST /wallets/{id}/withdraw`, `PATCH /wallets/{id}` |
| P2P Transfer | Transfer funds between two customer wallets | `POST /wallets/transfers` |
| QR Payment | Generate a QR code for an amount, scan it, and pay it | `POST /wallets/{id}/qr-payments`, `GET /qr-payments/{token}`, `POST /qr-payments/{token}/pay` |
| Payment History | List the wallet's previous payment transactions | `GET /wallets/{id}/transactions`, `GET /wallets/{id}/gateway-transactions` |

### How money moves

```
 Bank account ──(Payment Service)──► Wallet settlement account ──► Wallet balance   (top-up, BANK_ACCOUNT)
 Card ─────────(sandbox card gateway)──► Wallet settlement account ──► Wallet balance (top-up, CARD)
 Wallet A ──────(atomic DB transaction)──────────────────────────────► Wallet B       (P2P or QR payment)
 Wallet balance ──► Wallet settlement account ──(Payment Service)──► Bank account   (withdrawal)
```

* **Payment gateway integration.** Every top-up and withdrawal is a gateway
  transaction with status `PROCESSING`, `SUCCEEDED`, or `FAILED` and a gateway
  reference. Bank transfers go through the existing Payment Service
  (`POST /payments`), so they also appear in `/transactions`, the ledger, and
  notifications. Card top-ups go through a sandbox card gateway that validates
  the card (Luhn check, expiry, CVC) and authorizes or declines the charge.
* **Settlement account.** The Wallet Service creates one FinNova settlement
  account per currency on first use. The sum of all wallet balances always
  equals the settlement account balance.
* **Safety.** Transfers lock both wallets in a fixed order inside one database
  transaction, so balances never go negative and concurrent transfers cannot
  deadlock. Transfers and top-ups accept an `idempotencyKey`, so a retried
  request never moves money twice. A QR code can be paid only once and only
  before it expires. A failed withdrawal is reversed automatically.
* **Ownership checks.** A wallet requires approved KYC. A bank account used for
  a top-up or withdrawal must belong to the wallet owner and use the same
  currency.

Sandbox test cards (any future expiry, any 3 digit CVC):

| Card number | Result |
| --- | --- |
| `4242 4242 4242 4242` | Approved (Visa) |
| `5555 5555 5555 4444` | Approved (Mastercard) |
| `4000 0000 0000 0002` | Declined, `CARD_DECLINED` |
| `4000 0000 0000 9995` | Declined, `INSUFFICIENT_FUNDS` |
| `4000 0000 0000 0069` | Declined, `EXPIRED_CARD` |

### Wallet web app

Open [http://localhost:8080/wallet/](http://localhost:8080/wallet/). The page
calls the same public API through the gateway.

1. Create two customers with **Create customer & wallet**. This creates the
   customer, approves KYC, opens a bank account, and opens a wallet.
2. Use **Top up** to add money from the bank account or by card. Use
   **Withdraw** to send money back to the bank account.
3. Use **Send (P2P)** to transfer money to the other wallet.
4. Switch to the other wallet in the header, open **Request via QR**, and
   generate a QR code. Download the PNG.
5. Switch back, open **Scan & pay**, upload the PNG (or use the camera, or paste
   the QR content), check the preview, and pay.
6. Open **History** and **Payment processing** to see the wallet transactions
   and the gateway log.

The page remembers the wallets you create in your browser only. To load an
existing customer, use **Existing** and enter the customer ID.

### Wallet API smoke test

PowerShell example through the gateway (continues from the
[Local API smoke test](#local-api-smoke-test) above, which creates `$customer`
and `$accountA`):

```powershell
# A second customer to receive money
$bob = Invoke-RestMethod -Method Post -Uri http://localhost:8080/customers `
  -ContentType 'application/json' `
  -Body '{"firstName":"Bob","lastName":"Nagy","email":"bob.nagy@example.com","dateOfBirth":"1988-02-03"}'
Invoke-RestMethod -Method Post -Uri "http://localhost:8080/customers/$($bob.id)/kyc" `
  -ContentType 'application/json' -Body '{"documentType":"PASSPORT","result":"APPROVED"}'

# Digital wallets
$walletA = Invoke-RestMethod -Method Post -Uri http://localhost:8080/wallets `
  -ContentType 'application/json' -Body (@{ customerId = $customer.id; currency = 'EUR' } | ConvertTo-Json)
$walletB = Invoke-RestMethod -Method Post -Uri http://localhost:8080/wallets `
  -ContentType 'application/json' -Body (@{ customerId = $bob.id; currency = 'EUR' } | ConvertTo-Json)

# Top up through the payment gateway: bank account, then card
Invoke-RestMethod -Method Post -Uri "http://localhost:8080/wallets/$($walletA.id)/top-up" `
  -ContentType 'application/json' `
  -Body (@{ method = 'BANK_ACCOUNT'; bankAccountId = $accountA.id; amount = 100 } | ConvertTo-Json)
Invoke-RestMethod -Method Post -Uri "http://localhost:8080/wallets/$($walletA.id)/top-up" `
  -ContentType 'application/json' `
  -Body (@{ method = 'CARD'; amount = 50; card = @{ number = '4242424242424242'; expiryMonth = 12; expiryYear = 2030; cvc = '123' } } | ConvertTo-Json)

# P2P transfer
Invoke-RestMethod -Method Post -Uri http://localhost:8080/wallets/transfers `
  -ContentType 'application/json' `
  -Body (@{ fromWalletId = $walletA.id; toWalletId = $walletB.id; amount = 30; description = 'Dinner split'; idempotencyKey = [guid]::NewGuid().ToString() } | ConvertTo-Json)

# QR payment: Bob creates the QR code, Jane pays it
$qr = Invoke-RestMethod -Method Post -Uri "http://localhost:8080/wallets/$($walletB.id)/qr-payments" `
  -ContentType 'application/json' -Body '{"amount":12.50,"description":"Coffee"}'
Invoke-WebRequest -Uri "http://localhost:8080/qr-payments/$($qr.token)/image.png" -OutFile qr-payment.png
Invoke-RestMethod -Uri "http://localhost:8080/qr-payments/$($qr.token)"
Invoke-RestMethod -Method Post -Uri "http://localhost:8080/qr-payments/$($qr.token)/pay" `
  -ContentType 'application/json' -Body (@{ payerWalletId = $walletA.id } | ConvertTo-Json)

# Balance and payment history
Invoke-RestMethod -Uri "http://localhost:8080/wallets/$($walletA.id)"
(Invoke-RestMethod -Uri "http://localhost:8080/wallets/$($walletA.id)/transactions").data | Format-Table type, direction, amount, balanceAfter, description
Invoke-RestMethod -Uri "http://localhost:8080/wallets/$($walletA.id)/gateway-transactions" | Format-Table operation, method, status, amount, gatewayReference
```

An automated end-to-end check (Node.js 18 or newer) runs the full workflow and
the failure cases (declined card, insufficient funds, foreign bank account,
idempotent retry, QR paid twice) and checks every balance:

```bash
node scripts/wallet-smoke-test.mjs http://localhost:8080
```

### Screenshots

| | |
| --- | --- |
| Wallet created ![](docs/screenshots/01-wallet-created.png) | Top-up from bank account ![](docs/screenshots/02-topup-bank-account.png) |
| Card top-up approved ![](docs/screenshots/03-topup-card-approved.png) | Card top-up declined ![](docs/screenshots/04-topup-card-declined.png) |
| P2P transfer ![](docs/screenshots/05-p2p-transfer.png) | P2P with insufficient funds ![](docs/screenshots/06-p2p-insufficient-funds.png) |
| QR code generated ![](docs/screenshots/07-qr-generated.png) | QR scanned, payment preview ![](docs/screenshots/08-qr-scan-preview.png) |
| QR payment completed ![](docs/screenshots/09-qr-payment-completed.png) | QR cannot be paid twice ![](docs/screenshots/10-qr-already-paid.png) |
| Payee sees QR request paid ![](docs/screenshots/11-qr-request-paid.png) | Withdrawal to bank account ![](docs/screenshots/12-withdraw-to-bank.png) |
| Payment history ![](docs/screenshots/13-payment-history.png) | Payment gateway processing log ![](docs/screenshots/14-payment-gateway-log.png) |
| Recipient payment history ![](docs/screenshots/15-payment-history-recipient.png) | Mobile view ![](docs/screenshots/16-mobile-view.png) |
| Swagger UI with wallet API ![](docs/screenshots/17-swagger-wallet-api.png) | Smoke test output ![](docs/screenshots/18-smoke-test.png) |


## Deploy to Minikube

Start the cluster:

```bash
minikube start --driver=docker --cpus=4 --memory=4096
minikube status
```

Build images in the host Docker daemon, then load them into Minikube. This works
without configuring a container registry:

```bash
docker build -t finnova/account-service:1.0 ./account-service
docker build -t finnova/payment-service:1.0 ./payment-service
docker build -t finnova/customer-service:1.0 ./customer-service
docker build -t finnova/identity-service:1.0 ./identity-service
docker build -t finnova/ledger-service:1.0 ./ledger-service
docker build -t finnova/notification-service:1.0 ./notification-service
docker build -t finnova/wallet-service:1.0 ./wallet-service
docker build -t finnova/api-gateway:1.0 -f api-gateway/Dockerfile .

minikube image load finnova/account-service:1.0
minikube image load finnova/payment-service:1.0
minikube image load finnova/customer-service:1.0
minikube image load finnova/identity-service:1.0
minikube image load finnova/ledger-service:1.0
minikube image load finnova/notification-service:1.0
minikube image load finnova/wallet-service:1.0
minikube image load finnova/api-gateway:1.0
```

For the certificate workaround above, add
`--build-arg NPM_CONFIG_STRICT_SSL=false` to each Node service `docker build`
command. Do not use it on a normal network.

Apply the manifests:

```bash
kubectl apply -f k8s/
```

Wait for the deployments and inspect the resources:

```bash
kubectl rollout status deployment/postgres -n finnova --timeout=120s
kubectl rollout status deployment/account-service -n finnova --timeout=120s
kubectl rollout status deployment/payment-service -n finnova --timeout=120s
kubectl rollout status deployment/wallet-service -n finnova --timeout=120s
kubectl rollout status deployment/api-gateway -n finnova --timeout=120s

kubectl get pods -n finnova -o wide
kubectl get deployments -n finnova
kubectl get pvc -n finnova
kubectl get pv
kubectl get svc -n finnova
```

Expected state: Postgres, API Gateway, Customer Service, Identity Service, Ledger
Service, and Notification Service are `1/1`; Account Service, Payment Service,
and Wallet Service are `2/2`; and `postgres-pvc` is `Bound` to `postgres-pv`.

### Access the Kubernetes gateway

```bash
minikube service api-gateway -n finnova --url
```

Use the printed URL for API calls. Open `<printed-url>/docs/` for Swagger UI and
`<printed-url>/wallet/` for the wallet web app.
With the Docker driver on Windows, keep this command running while using the URL.

## Kubernetes cleanup

```bash
kubectl delete namespace finnova
kubectl delete pv postgres-pv
minikube stop
```

To remove the entire local Minikube cluster and its stored data:

```bash
minikube delete
```
