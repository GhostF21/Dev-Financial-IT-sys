#!/usr/bin/env bash
# One-time setup BEFORE the first pipeline run. Run it in Azure Cloud Shell (Bash)
# or Git Bash / WSL with the Azure CLI logged in (az login) to the target subscription.
#
# Creates:
#   1. Storage account for Terraform remote state
#   2. Entra ID app registration + service principal used by GitHub Actions
#   3. Federated credentials (OIDC) so GitHub can log in WITHOUT a stored password
#   4. Role assignments for that service principal
#   5. GitHub secrets / variables (automatically if the GitHub CLI "gh" is installed)
#
# Usage:  GITHUB_REPO=owner/repo LOCATION=westeurope ./bootstrap.sh
set -euo pipefail

GITHUB_REPO="${GITHUB_REPO:-GhostF21/Dev-Financial-IT-sys}"
LOCATION="${LOCATION:-westeurope}"
STATE_RG="${STATE_RG:-rg-finnova-tfstate}"
STATE_SA="${STATE_SA:-stfinnovatf$(openssl rand -hex 3)}" # must be globally unique, <= 24 chars
APP_NAME="${APP_NAME:-gh-finnova-prod-deployer}"

SUBSCRIPTION_ID=$(az account show --query id -o tsv)
TENANT_ID=$(az account show --query tenantId -o tsv)
echo "Subscription: $SUBSCRIPTION_ID  Tenant: $TENANT_ID  Repo: $GITHUB_REPO"

echo "==> Registering resource providers"
for rp in Microsoft.ContainerService Microsoft.ContainerRegistry Microsoft.DBforPostgreSQL \
          Microsoft.KeyVault Microsoft.Network Microsoft.OperationalInsights \
          Microsoft.OperationsManagement Microsoft.Insights Microsoft.Storage; do
  az provider register --namespace "$rp" -o none
done

echo "==> Terraform state storage"
az group create -n "$STATE_RG" -l "$LOCATION" -o none
if ! az storage account show -n "$STATE_SA" -g "$STATE_RG" -o none 2>/dev/null; then
  az storage account create -n "$STATE_SA" -g "$STATE_RG" -l "$LOCATION" \
    --sku Standard_LRS --kind StorageV2 --min-tls-version TLS1_2 \
    --allow-blob-public-access false --allow-shared-key-access false -o none
fi
az storage account blob-service-properties update --account-name "$STATE_SA" -g "$STATE_RG" \
  --enable-versioning true --enable-delete-retention true --delete-retention-days 30 -o none
az storage container-rm create --storage-account "$STATE_SA" -g "$STATE_RG" -n tfstate -o none 2>/dev/null || true
SA_ID=$(az storage account show -n "$STATE_SA" -g "$STATE_RG" --query id -o tsv)

echo "==> App registration / service principal"
APP_ID=$(az ad app list --display-name "$APP_NAME" --query "[0].appId" -o tsv)
if [ -z "$APP_ID" ]; then
  APP_ID=$(az ad app create --display-name "$APP_NAME" --query appId -o tsv)
fi
az ad sp show --id "$APP_ID" -o none 2>/dev/null || az ad sp create --id "$APP_ID" -o none
SP_OBJECT_ID=$(az ad sp show --id "$APP_ID" --query id -o tsv)

echo "==> Federated credentials (GitHub OIDC)"
add_fic() { # name subject
  if ! az ad app federated-credential show --id "$APP_ID" --federated-credential-id "$1" -o none 2>/dev/null; then
    az ad app federated-credential create --id "$APP_ID" -o none --parameters "{
      \"name\": \"$1\",
      \"issuer\": \"https://token.actions.githubusercontent.com\",
      \"subject\": \"$2\",
      \"audiences\": [\"api://AzureADTokenExchange\"]
    }"
  fi
}
add_fic gh-main               "repo:${GITHUB_REPO}:ref:refs/heads/main"        # build push, terraform plan on main
add_fic gh-env-production     "repo:${GITHUB_REPO}:environment:production"     # terraform apply, release
add_fic gh-pull-request       "repo:${GITHUB_REPO}:pull_request"               # terraform plan on PRs

echo "==> Role assignments (may take a minute to propagate)"
assign() { # role scope
  az role assignment create --assignee-object-id "$SP_OBJECT_ID" --assignee-principal-type ServicePrincipal \
    --role "$1" --scope "$2" -o none 2>/dev/null || true
}
assign "Contributor"                               "/subscriptions/$SUBSCRIPTION_ID"
assign "Role Based Access Control Administrator"   "/subscriptions/$SUBSCRIPTION_ID" # Terraform creates AcrPull / Key Vault / AKS role assignments
assign "Storage Blob Data Contributor"             "$SA_ID"                           # Terraform state (Entra auth, no keys)

# Let the signed-in user run Terraform locally against the same state
ME=$(az ad signed-in-user show --query id -o tsv 2>/dev/null || true)
if [ -n "$ME" ]; then
  az role assignment create --assignee-object-id "$ME" --assignee-principal-type User \
    --role "Storage Blob Data Contributor" --scope "$SA_ID" -o none 2>/dev/null || true
fi

cat <<EOF

================ GitHub configuration ================
Secrets  (Settings -> Secrets and variables -> Actions -> Secrets)
  AZURE_CLIENT_ID        = $APP_ID
  AZURE_TENANT_ID        = $TENANT_ID
  AZURE_SUBSCRIPTION_ID  = $SUBSCRIPTION_ID
Variables (Settings -> Secrets and variables -> Actions -> Variables)
  TF_STATE_RESOURCE_GROUP  = $STATE_RG
  TF_STATE_STORAGE_ACCOUNT = $STATE_SA
Your user object id (put it in infra/terraform/prod.tfvars -> admin_object_ids):
  ${ME:-<run: az ad signed-in-user show --query id -o tsv>}
======================================================
EOF

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  echo "==> Setting GitHub secrets/variables with gh"
  gh secret   set AZURE_CLIENT_ID          -R "$GITHUB_REPO" -b "$APP_ID"
  gh secret   set AZURE_TENANT_ID          -R "$GITHUB_REPO" -b "$TENANT_ID"
  gh secret   set AZURE_SUBSCRIPTION_ID    -R "$GITHUB_REPO" -b "$SUBSCRIPTION_ID"
  gh variable set TF_STATE_RESOURCE_GROUP  -R "$GITHUB_REPO" -b "$STATE_RG"
  gh variable set TF_STATE_STORAGE_ACCOUNT -R "$GITHUB_REPO" -b "$STATE_SA"
else
  echo "gh CLI not found/logged in - add the values above manually in GitHub."
fi
