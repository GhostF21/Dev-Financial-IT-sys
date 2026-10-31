# FinNova – Azure production deployment

Everything needed to run FinNova in Azure (PROD only). The local Docker Compose /
Minikube setup in the repo root is unchanged.

```
infra/
  bootstrap/bootstrap.sh   one-time: Terraform state storage + GitHub OIDC identity
  terraform/               Azure infrastructure (prod)
  k8s/                     Kubernetes manifests for AKS (kustomize)
.github/workflows/
  terraform.yml            Infrastructure pipeline
  build.yml                Build pipeline  (CI)
  release.yml              Release pipeline (CD)
```

## Architecture

```
Internet ──► Azure Load Balancer (public IP / <label>.<region>.cloudapp.azure.com)
               │
          ┌────▼──────────────── AKS (vnet-finnova-prod / snet-aks) ───────────────┐
          │ api-gateway (nginx) ──► customer / identity / account / payment        │
          │                         ledger / notification services (ClusterIP)     │
          │ NetworkPolicies: only the gateway accepts traffic from outside         │
          └────────────────────────────────┬───────────────────────────────────────┘
                                           │ TLS (PGSSLMODE=require), private IP only
                          Azure Database for PostgreSQL Flexible Server (snet-postgres)

ACR (images, pulled by AKS managed identity) · Key Vault (DB credentials)
Log Analytics (Container Insights) · Terraform state in Azure Storage
```

| Resource | Name |
| --- | --- |
| Resource group | `rg-finnova-prod` |
| AKS | `aks-finnova-prod` (Entra ID auth, Azure RBAC, no local accounts, autoscaling 2–4 nodes) |
| Container registry | `acrfinnovaprod<suffix>` (admin user disabled) |
| PostgreSQL 16 | `psql-finnova-prod-<suffix>` (private VNet access, TLS required, 14-day backups) |
| Key Vault | `kv-finnova-prod-<suffix>` (RBAC, purge protection) |
| Log Analytics | `log-finnova-prod` |

## How the pipelines work on GitHub

GitHub Actions has no separate "release pipeline" object like Azure DevOps Classic
Releases. Every pipeline is a **workflow** (YAML in `.github/workflows`). Release
behaviour is built from three features:

1. **Workflow chaining** – `release.yml` uses `on: workflow_run` so it starts
   automatically when the `Build` workflow finishes successfully on `main`.
2. **Environments** – the deploy jobs use `environment: production`. In
   *Settings → Environments → production* you can add **required reviewers**
   (manual approval before going live), a wait timer, and restrict it to the `main`
   branch. The run then pauses with a "Review deployments" button.
3. **Immutable artifacts** – Build pushes images tagged with the commit SHA; Release
   deploys exactly that SHA. Rolling back = run *Release* manually with an older SHA.

```
push to main
 ├─ infra/terraform/** changed ─► Infrastructure: fmt/validate/plan ─► [approval] ─► apply
 └─ app / k8s changed ─────────► Build: npm ci + checks ─► docker build ─► push to ACR (:sha)
                                        │ success
                                        ▼
                                 Release: [approval] ─► Key Vault → k8s secret ─► kubectl apply -k
                                          ─► rollout status ─► smoke test (auto-rollback on failure)
pull request to main ─► Build (no push) + Terraform plan only
```

Authentication to Azure uses **OIDC federated credentials** – GitHub gets a
short-lived token; no Azure password/secret is stored in GitHub.

## First-time setup

1. **Pick a suffix** – edit `infra/terraform/prod.tfvars`: `unique_suffix` (3–6
   lowercase chars) and add your user object id to `admin_object_ids`.
2. **Bootstrap** (Azure Cloud Shell → Bash, or Git Bash with `az login`):
   ```bash
   GITHUB_REPO=GhostF21/Dev-Financial-IT-sys LOCATION=westeurope bash infra/bootstrap/bootstrap.sh
   ```
   It sets the GitHub secrets `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
   `AZURE_SUBSCRIPTION_ID` and variables `TF_STATE_RESOURCE_GROUP`,
   `TF_STATE_STORAGE_ACCOUNT` (or prints them if `gh` is not installed).
3. **Create the environment** – GitHub → *Settings → Environments → New environment*
   `production`; add yourself as required reviewer, deployment branches: `main`.
4. **Provision infrastructure** – merge to `main` (or run *Infrastructure (Terraform)*
   manually). Takes ~15 minutes the first time.
5. **Set the remaining repository variables** from the apply run summary
   (`github_variables` output): `AZURE_RESOURCE_GROUP`, `AKS_CLUSTER_NAME`,
   `ACR_NAME`, `KEY_VAULT_NAME`. Optional: `DNS_LABEL` (e.g. `finnova-<suffix>`) for
   a stable hostname `finnova-<suffix>.westeurope.cloudapp.azure.com`.
6. **Deploy the app** – run *Build* manually once (or push any app change). Release
   follows automatically. The API is then at `http://<ip-or-host>/` and Swagger at
   `/docs/`.

> Order matters only the first time: Build needs ACR, so infrastructure must exist first.

## Day-2 operations

```bash
az aks get-credentials -g rg-finnova-prod -n aks-finnova-prod
kubelogin convert-kubeconfig -l azurecli
kubectl -n finnova get pods
```

Run Terraform locally: copy `terraform/backend.hcl.example` to `backend.hcl`, then
`terraform init -backend-config=backend.hcl && terraform plan -var-file=prod.tfvars`.
Use local runs for `plan` only: Terraform grants roles to "whoever runs it", so a local
`apply` would move the pipeline's ACR/AKS/Key Vault roles to your user.

## Before real customer traffic (not included yet)

- **HTTPS** – the gateway is plain HTTP on port 80. Add an ingress controller
  (App Routing add-on or Application Gateway for Containers) with a TLS certificate,
  or put Azure Front Door/WAF in front.
- **Least-privilege DB users** – services currently use the server admin login; create
  per-service roles, or move to Entra ID workload identity auth.
- **Schema migrations** – tables are created at service start-up; a migration tool
  (e.g. node-pg-migrate) run as a pre-deploy job is safer.
- **Sizing / SLA** – `aks_sku_tier = "Standard"`, a General Purpose PostgreSQL SKU with
  `postgres_high_availability = true`, and geo-redundant backups.
- **Separate read-only identity for PR plans** – currently PR plans use the same
  service principal as deployments.
