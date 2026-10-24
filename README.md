# FinNova Bank: Docker and Kubernetes Deployment

FinNova is an API-only banking backend. It contains an Account Service, a Payment
Service, PostgreSQL, and an nginx API Gateway. The gateway exposes the public API
and the Swagger documentation.

## Prerequisites

- Docker Desktop (or Docker Engine) with Docker Compose v2
- Minikube with the Docker driver
- kubectl

Run all commands from the repository root.

## Services

| Service | Purpose | Local address |
| --- | --- | --- |
| API Gateway | Public entry point and Swagger UI | `http://localhost:8080` |
| Account Service | Customers and accounts | Internal; port 3000 is also published locally |
| Payment Service | Payments and transactions | Internal; port 3001 is also published locally |
| PostgreSQL | Persistent application data | port 5432 |

The gateway routes `/customers` and `/accounts` to Account Service, and
`/payments` and `/transactions` to Payment Service.

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

The following PowerShell example creates a customer, two accounts, and a payment
through the gateway:

```powershell
$customer = Invoke-RestMethod -Method Post -Uri http://localhost:8080/customers `
  -ContentType 'application/json' `
  -Body '{"firstName":"Jane","lastName":"Doe","email":"jane.doe@example.com","dateOfBirth":"1990-05-12"}'

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
docker build -t finnova/api-gateway:1.0 -f api-gateway/Dockerfile .

minikube image load finnova/account-service:1.0
minikube image load finnova/payment-service:1.0
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

Expected state: Postgres and API Gateway are `1/1`, Account Service and Payment
Service are `2/2`, and `postgres-pvc` is `Bound` to `postgres-pv`.

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
