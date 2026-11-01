# FinNova – Azure deployment (prod, student-budget edition)

Everything needed to run FinNova in Azure. The local Docker Compose / Minikube setup in
the repo root is unchanged.

```
infra/
  bootstrap/bootstrap.sh     one-time: Terraform state storage + GitHub's Azure identity
  terraform/                 Azure infrastructure (prod.tfvars = cheap settings)
  containerapps/deploy.sh    creates / updates the container apps (used by Release)
.github/workflows/
  terraform.yml              Infrastructure pipeline
  build.yml                  Build pipeline  (CI)
  release.yml                Release pipeline (CD)
```

> **Why Container Apps and not AKS?** On the Azure for Students subscription AKS only
> accepts newer VM sizes (v5–v7 families), and the subscription has no vCPU quota for any
> of them in any allowed region (quota increase requests are rejected). Container Apps on
> the serverless *Consumption* profile needs no VM quota at all.

## What gets created

```
Internet ─► HTTPS ─► api-gateway  (container app, public ingress; nginx, /docs, /wallet UI)
                        │  same addresses as docker-compose: customer-service:3002 …
                        ▼  (internal TCP ingress, not reachable from the internet)
          customer · identity · account · payment · ledger · notification · wallet
                        │  TLS, private network only
                        ▼
          PostgreSQL Flexible Server (B1ms)

Container Apps environment (Consumption, in the VNet) · ACR Basic (images)
Key Vault (DB credentials) · Storage account (Terraform state)
```

Terraform creates the platform (network, environment, registry, Key Vault, database,
identity). The **Release** workflow creates / updates the 8 apps with
`infra/containerapps/deploy.sh`, because their images only exist after a Build.

### Approximate monthly cost if it runs 24/7

| Item | ≈ USD / month |
| --- | --- |
| 8 container apps × 0.25 vCPU / 0.5 GiB, 1 replica each (mostly billed at the cheaper *idle* rate) | 45–60 |
| PostgreSQL B1ms + 32 GB storage | 17–20 |
| Container Registry Basic | 5 |
| Key Vault, state storage, Container Apps environment | < 1 |
| **Total** | **≈ 70–85** |

Under real load the apps are billed at the *active* rate, which is higher. With $100 credit
that is ~5 weeks non-stop. **Stop it when you are not using it** (see "Saving money").
Prices vary by region; check the
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
Then check PostgreSQL Flexible Server is offered there (an empty list = not available,
e.g. germanywestcentral on our subscription):
```bash
REGION=italynorth   # <- your choice
az postgres flexible-server list-skus -l $REGION --query "[0].supportedServerVersions[].name" -o tsv
```

### 3. Edit `infra/terraform/prod.tfvars` (in your repo, then commit)
```hcl
location      = "italynorth"   # region from step 2
unique_suffix = "mm7x"         # 3-6 random lowercase letters/digits - makes names unique
admin_object_ids = ["<your object id>"]   # az ad signed-in-user show --query id -o tsv
```

### 4. Run the bootstrap script (once)
In Cloud Shell:
```bash
git clone https://github.com/GhostF21/Dev-Financial-IT-sys.git
cd Dev-Financial-IT-sys
GITHUB_REPO=GhostF21/Dev-Financial-IT-sys LOCATION=$REGION bash infra/bootstrap/bootstrap.sh
```
It creates `rg-finnova-tfstate` with:
* a storage account for the Terraform state,
* a **managed identity** that GitHub Actions logs in as, trusted only for your repo's
  `main` branch, `production` environment and pull requests,
* the role assignments that identity needs.

It also registers the Azure resource providers (including `Microsoft.App` for Container
Apps). At the end it prints 3 secrets and 2 variables. Keep that output open.

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
**variables**: `AZURE_RESOURCE_GROUP`, `ACR_NAME`, `KEY_VAULT_NAME`,
`CONTAINER_APPS_ENVIRONMENT`, `CONTAINER_APPS_IDENTITY`.

### 8. Build and release the app
*Actions → Build → Run workflow* (branch `main`). When it succeeds, **Release** starts
automatically and waits for your approval. After approval it creates / updates the apps,
waits until every new revision is ready and smoke-tests the gateway. The run's
environment link shows the URL (`https://api-gateway.<random>.<region>.azurecontainerapps.io`):

* API: `https://<gateway>/customers`, `/accounts`, `/payments`, `/wallets` …
* Swagger: `https://<gateway>/docs/`
* Wallet web app: `https://<gateway>/wallet/`

From now on every push to `main` builds and (after your approval) releases automatically.
If a release fails, the workflow rolls back to the version that was running before.

---

## Credentials – where does what live?

**Rule: no passwords, keys or `.env` files in the repository.** This setup needs almost
no secrets at all:

| What | Where it lives | Notes |
| --- | --- | --- |
| Azure login for pipelines | **Nothing stored.** GitHub gets a short-lived OIDC token, Azure trusts it via the federated credentials on the managed identity | No client secret that can leak or expire |
| `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID` | GitHub **Secrets** | Identifiers, not passwords – kept as secrets so they are not printed in logs |
| Resource names, state account (`ACR_NAME`, …) | GitHub **Variables** | Not sensitive |
| PostgreSQL admin password | Generated by Terraform → **Azure Key Vault** (`db-password`) → read by each container app through a **Key Vault reference** with the apps' managed identity | You never see or type it; it never passes through the pipeline |
| DB host / user / name | Key Vault (`db-host`, `db-user`, `db-name`) | Same mechanism |
| Terraform state (contains the DB password) | Private Azure Storage account, Entra-ID access only, versioned | Never commit `*.tfstate` (already in `.gitignore`) |
| Local development (`docker-compose.yml`, `k8s/01-secret.yaml`) | In the repo, value `finnova` | Fine: local throw-away database only. Never reuse these values in Azure |
| Container registry login | None – the apps pull with their managed identity (`AcrPull`); Build logs in via OIDC | ACR admin user is disabled |

If you ever need a real secret for the app (e.g. an API key for a card processor): put it
in Key Vault and add it to the `secrets` / `env` lists in `infra/containerapps/deploy.sh`
the same way as `db-password`. For something only the pipeline uses, a GitHub
**environment secret** on `production` is fine.

Read a secret yourself (needs your object id in `admin_object_ids`):
```bash
az keyvault secret show --vault-name kv-finnova-prod-<suffix> -n db-password --query value -o tsv
```

---

## Saving money

The apps and the database are what cost money.

```bash
# Pause: delete the apps (Release recreates them) and stop the database
for app in api-gateway customer-service identity-service account-service payment-service \
           ledger-service notification-service wallet-service; do
  az containerapp delete -g rg-finnova-prod -n $app --yes --no-wait
done
az postgres flexible-server stop -g rg-finnova-prod -n psql-finnova-prod-<suffix>

# Resume
az postgres flexible-server start -g rg-finnova-prod -n psql-finnova-prod-<suffix>
# then: Actions → Release → Run workflow (empty = latest commit on main)
```
* A stopped PostgreSQL server restarts by itself after 7 days – stop it again.
* Set a **budget alert**: Portal → *Cost Management → Budgets → Add* → e.g. 20 USD/month
  with email alerts at 50 % / 90 %.
* Check spending: *Subscriptions → your subscription → Cost analysis*, or
  <https://www.microsoftazuresponsorships.com/Balance> for remaining student credit.
* Done for good? Delete everything:
  ```bash
  az group delete -n rg-finnova-prod --yes        # app infrastructure + apps
  az group delete -n rg-finnova-tfstate --yes     # state + GitHub identity
  ```
  `terraform destroy` alone does not work while the apps exist: they are not managed by
  Terraform, so the resource group is not empty. Delete the apps first (see above).
* Want logs? set `enable_monitoring = true` in `prod.tfvars` – Log Analytics is billed
  per GB ingested, so switch it off again afterwards.

## Troubleshooting

| Error | Fix |
| --- | --- |
| `RequestDisallowedByAzure` / `RequestDisallowedByPolicy` | Region not allowed → step 2, change `location` |
| PostgreSQL `The value of the 'Version' should be in: []` | PostgreSQL is not offered to the subscription in that region → step 2 |
| `MissingSubscriptionRegistration` for `Microsoft.App` | `az provider register -n Microsoft.App --wait` |
| `AADSTS700213` / `No matching federated identity record` | Repo name or branch differs from the bootstrap `GITHUB_REPO`, or the job is not on `main` / `production` |
| Key Vault `name already in use` after a destroy | Change `unique_suffix`, or `az keyvault purge -n <name>` |
| Release: `revision … did not become ready` | Look at the app's logs (below); usually the DB connection or a failing `/readyz` |
| Terraform cannot delete / replace the Container Apps environment | Apps still exist in it → delete them first (see "Saving money") |
| Changing `location` fails with "Resource Group still contains Resources" | Delete `rg-finnova-prod` by hand, then re-run the pipeline |

## Day-2

```bash
az containerapp list -g rg-finnova-prod -o table
az containerapp logs show -g rg-finnova-prod -n account-service --tail 50
az containerapp revision list -g rg-finnova-prod -n account-service -o table
az containerapp exec -g rg-finnova-prod -n account-service    # shell inside the container
```
Run Terraform locally only for `plan` (copy `terraform/backend.hcl.example` to
`backend.hcl`); a local `apply` would move the pipeline's roles to your user.

## Before real customers

Custom domain + certificate on the gateway, per-service DB users, real authentication on
the API, 2+ replicas per service (`MIN_REPLICAS` / `MAX_REPLICAS` in `deploy.sh`),
General Purpose PostgreSQL with HA.
