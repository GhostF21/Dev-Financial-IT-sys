# FinNova – Azure deployment (prod, student-budget edition)

Everything needed to run FinNova in Azure. The local Docker Compose / Minikube setup in
the repo root is unchanged.

```
infra/
  bootstrap/bootstrap.sh   one-time: Terraform state storage + GitHub's Azure identity
  terraform/               Azure infrastructure (prod.tfvars = cheap settings)
  k8s/                     Kubernetes manifests for AKS (kustomize)
.github/workflows/
  terraform.yml            Infrastructure pipeline
  build.yml                Build pipeline  (CI)
  release.yml              Release pipeline (CD)
```

## What gets created

```
Internet ─► Azure Load Balancer ─► AKS (1× Standard_B2als_v2 node, autoscales to 2)
                                    api-gateway (nginx, /docs, /wallet UI)
                                    customer · identity · account · payment
                                    ledger · notification · wallet services
                                         │ TLS, private network only
                                         ▼
                          PostgreSQL Flexible Server (B1ms)
ACR Basic (images) · Key Vault (DB credentials) · Storage account (Terraform state)
```

### Approximate monthly cost if it runs 24/7

| Item | ≈ USD / month |
| --- | --- |
| AKS node Standard_B2als_v2 + 30 GB OS disk | 30–35 |
| Standard Load Balancer + 2 public IPs (AKS requirement) | 20–25 |
| PostgreSQL B1ms + 32 GB storage | 17–20 |
| Container Registry Basic | 5 |
| Key Vault, state storage, AKS control plane (Free tier) | < 1 |
| **Total** | **≈ 75–85** |

With $100 credit that is ~5 weeks non-stop. **Stop it when you are not using it**
(see "Saving money") and it lasts the whole semester. Prices vary by region; check the
[Azure pricing calculator](https://azure.microsoft.com/pricing/calculator/).

---

## Step-by-step: first deployment

You need: the Azure student subscription, a GitHub account with admin rights on the repo,
and a browser. Everything below runs in **Azure Cloud Shell** (no local installs needed).

### 1. Open Azure Cloud Shell
1. Sign in at <https://portal.azure.com> with your student account.
2. Click the **`>_`** icon in the top bar → choose **Bash**. If asked, let it create
   storage (pennies per month) or pick "No storage account required".
3. Check you are on the student subscription:
   ```bash
   az account show --query "{name:name, id:id}" -o table
   ```

### 2. Find a region you are allowed to use
Student subscriptions only allow a few regions. List them:
```bash
az policy assignment list --query "[].parameters.listOfAllowedLocations.value" -o tsv
```
Pick one from the list – prefer **swedencentral**, **northeurope**, **polandcentral** or
**germanywestcentral** (cheap and close to Hungary). Then check the node size is offered
there and you have vCPU quota (needs at least 4 free "Total Regional vCPUs"):
```bash
REGION=swedencentral   # <- your choice
az vm list-skus -l $REGION --size Standard_B2als_v2 --query "[].{size:name, restrictions:restrictions[0].reasonCode}" -o table
az vm list-usage -l $REGION --query "[?localName=='Total Regional vCPUs']" -o table
```
If `Standard_B2als_v2` shows a restriction, try `Standard_B2s` or `Standard_B2as_v2`.

### 3. Edit `infra/terraform/prod.tfvars` (in your repo, then commit)
```hcl
location      = "swedencentral"   # region from step 2
unique_suffix = "mm7x"            # 3-6 random lowercase letters/digits - makes names unique
admin_object_ids = ["<your object id>"]   # az ad signed-in-user show --query id -o tsv
aks_node_vm_size = "Standard_B2als_v2"    # or the size that worked in step 2
```

### 4. Run the bootstrap script (once)
In Cloud Shell:
```bash
git clone https://github.com/GhostF21/Dev-Financial-IT-sys.git
cd Dev-Financial-IT-sys
git checkout development        # or the branch that contains infra/
GITHUB_REPO=GhostF21/Dev-Financial-IT-sys LOCATION=$REGION bash infra/bootstrap/bootstrap.sh
```
It creates `rg-finnova-tfstate` with:
* a storage account for the Terraform state,
* a **managed identity** that GitHub Actions logs in as, trusted only for your repo's
  `main` branch, `production` environment and pull requests,
* the role assignments that identity needs.

At the end it prints 3 secrets and 2 variables. Keep that output open.

### 5. Configure GitHub
In the repo: **Settings → Secrets and variables → Actions**.

* **Secrets** tab → *New repository secret*:
  `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`
* **Variables** tab → *New repository variable*:
  `TF_STATE_RESOURCE_GROUP`, `TF_STATE_STORAGE_ACCOUNT`

Then **Settings → Environments → New environment** → name it **`production`**:
* tick **Required reviewers** and add yourself (every deploy waits for your click),
* **Deployment branches** → *Selected branches* → `main`.

(Optional) **Settings → Actions → General** → make sure Actions are allowed.

### 6. Create the infrastructure
Merge your branch into `main` (or open *Actions → Infrastructure (Terraform) → Run
workflow*). The **Plan** job shows what will be created; then the **Apply (production)**
job waits → click **Review deployments → Approve**. First run takes ~10–15 minutes.

### 7. Set the remaining repository variables
Open the finished Apply run → *Summary* shows `github_variables`. Add them as repository
**variables**: `AZURE_RESOURCE_GROUP`, `AKS_CLUSTER_NAME`, `ACR_NAME`, `KEY_VAULT_NAME`.
Optional: `DNS_LABEL` = e.g. `finnova-mm7x` → stable URL
`http://finnova-mm7x.<region>.cloudapp.azure.com`.

### 8. Build and release the app
*Actions → Build → Run workflow* (branch `main`). When it succeeds, **Release** starts
automatically and waits for your approval. After approval it deploys, waits for every
service and smoke-tests the gateway. The run's environment link shows the URL:

* API: `http://<ip-or-dns>/customers`, `/accounts`, `/payments`, `/wallets` …
* Swagger: `http://<ip-or-dns>/docs/`
* Wallet web app: `http://<ip-or-dns>/wallet/`

From now on every push to `main` builds and (after your approval) releases automatically.

---

## Credentials – where does what live?

**Rule: no passwords, keys or `.env` files in the repository.** This setup needs almost
no secrets at all:

| What | Where it lives | Notes |
| --- | --- | --- |
| Azure login for pipelines | **Nothing stored.** GitHub gets a short-lived OIDC token, Azure trusts it via the federated credentials on the managed identity | No client secret that can leak or expire |
| `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` | GitHub **Secrets** | Identifiers, not passwords – kept as secrets so they are not printed in logs |
| Resource names, state account (`ACR_NAME`, …) | GitHub **Variables** | Not sensitive |
| PostgreSQL admin password | Generated by Terraform → **Azure Key Vault** (`db-password`) → copied by the release into a Kubernetes **Secret** `finnova-db` | You never see or type it |
| DB host / user / name | Key Vault (`db-host`, `db-user`, `db-name`) | |
| Terraform state (contains the DB password) | Private Azure Storage account, Entra-ID access only, versioned | Never commit `*.tfstate` (already in `.gitignore`) |
| Local development (`docker-compose.yml`, `k8s/01-secret.yaml`) | In the repo, value `finnova` | Fine: local throw-away database only. Never reuse these values in Azure |
| Container registry login | None – AKS pulls with its managed identity; Build logs in via OIDC | ACR admin user is disabled |

If you ever need a real secret for the app (e.g. an API key for a card processor): put it
in Key Vault, then add it to the "Sync database secret from Key Vault" step in
`release.yml` (or a similar step) so it ends up in a Kubernetes Secret. For something only
the pipeline uses, a GitHub **environment secret** on `production` is fine.

Read a secret yourself (needs your object id in `admin_object_ids`):
```bash
az keyvault secret show --vault-name kv-finnova-prod-<suffix> -n db-password --query value -o tsv
```

---

## Saving money

```bash
# Pause (nodes + DB compute stop billing; LB/IP/disks/ACR still cost ~1 USD/day)
az aks stop -g rg-finnova-prod -n aks-finnova-prod
az postgres flexible-server stop -g rg-finnova-prod -n psql-finnova-prod-<suffix>

# Resume
az postgres flexible-server start -g rg-finnova-prod -n psql-finnova-prod-<suffix>
az aks start -g rg-finnova-prod -n aks-finnova-prod
```
* A stopped PostgreSQL server restarts by itself after 7 days – stop it again.
* Set a **budget alert**: Portal → *Cost Management → Budgets → Add* → e.g. 20 USD/month
  with email alerts at 50 % / 90 %.
* Check spending: *Subscriptions → your subscription → Cost analysis*, or
  <https://www.microsoftazuresponsorships.com/Balance> for remaining student credit.
* Done for good? Delete everything:
  ```bash
  az group delete -n rg-finnova-prod --yes        # app infrastructure
  az group delete -n rg-finnova-tfstate --yes     # state + GitHub identity
  ```
  (or run `terraform destroy` locally first, then delete the state group).
* Want logs? set `enable_monitoring = true` in `prod.tfvars` – Log Analytics is billed
  per GB ingested, so switch it off again afterwards.

## Troubleshooting

| Error | Fix |
| --- | --- |
| `RequestDisallowedByAzure` / `RequestDisallowedByPolicy` | Region not allowed → step 2, change `location` |
| `QuotaExceeded` / `Total Regional Cores` | Use a 2-vCPU size, keep `aks_node_max_count = 2`, or request quota |
| `SkuNotAvailable` | Try another node size from step 2 |
| `AADSTS700213` / `No matching federated identity record` | Repo name or branch differs from the bootstrap `GITHUB_REPO`, or the job is not on `main` / `production` |
| Key Vault `name already in use` after a destroy | Change `unique_suffix`, or `az keyvault purge -n <name>` |
| Pods `Pending` | Node full → autoscaler adds a 2nd node (needs quota); `kubectl -n finnova describe pod <pod>` |

## Day-2

```bash
az aks get-credentials -g rg-finnova-prod -n aks-finnova-prod
kubelogin convert-kubeconfig -l azurecli
kubectl -n finnova get pods
```
Run Terraform locally only for `plan` (copy `terraform/backend.hcl.example` to
`backend.hcl`); a local `apply` would move the pipeline's roles to your user.

## Before real customers

HTTPS (ingress + certificate), per-service DB users, real authentication on the API,
2+ replicas per service, `aks_sku_tier = "Standard"`, General Purpose PostgreSQL with HA.
