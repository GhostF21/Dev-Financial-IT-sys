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
| Ledger Service | Internal ledger adapter | Internal; port 3005 |
| Notification Service | Internal payment notifications | Internal; port 3004 |
| PostgreSQL | Persistent application data | port 5432 |

The gateway routes `/customers` to Customer Service, `/auth` to Identity Service,
`/accounts` to Account Service, and `/payments` plus `/transactions` to Payment
Service. Ledger and notification endpoints are not publicly exposed.

## Run locally with Docker Compose

Build and start the full stack:

```bash
docker compose up --build -d
docker compose ps
```

All four services should report `healthy`. Stop the stack while keeping its data:

```bash
docker compose down
```

Remove the stack and its local PostgreSQL data:

```bash
docker compose down -v --rmi local
```

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
```

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
docker build -t finnova/api-gateway:1.0 -f api-gateway/Dockerfile .

minikube image load finnova/account-service:1.0
minikube image load finnova/payment-service:1.0
minikube image load finnova/customer-service:1.0
minikube image load finnova/identity-service:1.0
minikube image load finnova/ledger-service:1.0
minikube image load finnova/notification-service:1.0
minikube image load finnova/api-gateway:1.0
```

Apply the manifests:

```bash
kubectl apply -f k8s/
```

Wait for the deployments and inspect the resources:

```bash
kubectl rollout status deployment/postgres -n finnova --timeout=120s
kubectl rollout status deployment/account-service -n finnova --timeout=120s
kubectl rollout status deployment/payment-service -n finnova --timeout=120s
kubectl rollout status deployment/api-gateway -n finnova --timeout=120s

kubectl get pods -n finnova -o wide
kubectl get deployments -n finnova
kubectl get pvc -n finnova
kubectl get pv
kubectl get svc -n finnova
```

Expected state: Postgres, API Gateway, Customer Service, Identity Service, Ledger
Service, and Notification Service are `1/1`; Account Service and Payment Service
are `2/2`; and `postgres-pvc` is `Bound` to `postgres-pv`.

### Access the Kubernetes gateway

```bash
minikube service api-gateway -n finnova --url
```

Use the printed URL for API calls. Open `<printed-url>/docs/` for Swagger UI.
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
