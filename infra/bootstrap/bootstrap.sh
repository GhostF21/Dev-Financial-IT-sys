#!/usr/bin/env bash
# One-time setup BEFORE the first pipeline run. Run it in Azure Cloud Shell (Bash)
# or Git Bash / WSL with the Azure CLI logged in (az login) to the target subscription.
#
# Creates:
#   1. Storage account for Terraform remote state
#   2. User-assigned managed identity used by GitHub Actions
#   3. Federated credentials (OIDC) so GitHub can log in WITHOUT a stored password
#   4. Role assignments for that identity
#   5. GitHub secrets / variables (automatically if the GitHub CLI "gh" is installed)
#
# Usage:  GITHUB_REPO=owner/repo LOCATION=swedencentral bash bootstrap.sh
set -euo pipefail

GITHUB_REPO="${GITHUB_REPO:-GhostF21/Dev-Financial-IT-sys}"
LOCATION="${LOCATION:-swedencentral}"
STATE_RG="${STATE_RG:-rg-finnova-tfstate}"
STATE_SA="${STATE_SA:-}" # globally unique, <= 24 chars; generated (and reused on re-runs) if empty
IDENTITY_NAME="${IDENTITY_NAME:-id-finnova-github-deployer}"

SUBSCRIPTION_ID=$(az account show --query id -o tsv)
TENANT_ID=$(az account show --query tenantId -o tsv)
echo "Subscription: $SUBSCRIPTION_ID  Tenant: $TENANT_ID  Repo: $GITHUB_REPO"

echo "==> Registering resource providers"
for rp in Microsoft.ContainerService Microsoft.ContainerRegistry Microsoft.DBforPostgreSQL \
          Microsoft.KeyVault Microsoft.Network Microsoft.OperationalInsights \
          Microsoft.OperationsManagement Microsoft.Insights Microsoft.Storage \
          Microsoft.ManagedIdentity; do
  az provider register --namespace "$rp" -o none
done

echo "==> Terraform state storage"
az group create -n "$STATE_RG" -l "$LOCATION" -o none
if [ -z "$STATE_SA" ]; then # reuse the account from an earlier run of this script
  STATE_SA=$(az storage account list -g "$STATE_RG" --query "[?starts_with(name,'stfinnovatf')].name | [0]" -o tsv)
fi
STATE_SA="${STATE_SA:-stfinnovatf$(openssl rand -hex 3)}"
if ! az storage account show -n "$STATE_SA" -g "$STATE_RG" -o none 2>/dev/null; then
  az storage account create -n "$STATE_SA" -g "$STATE_RG" -l "$LOCATION" \
    --sku Standard_LRS --kind StorageV2 --min-tls-version TLS1_2 \
    --allow-blob-public-access false --allow-shared-key-access false -o none
fi
az storage account blob-service-properties update --account-name "$STATE_SA" -g "$STATE_RG" \
  --enable-versioning true --enable-delete-retention true --delete-retention-days 30 -o none
az storage container-rm create --storage-account "$STATE_SA" -g "$STATE_RG" -n tfstate -o none 2>/dev/null || true
SA_ID=$(az storage account show -n "$STATE_SA" -g "$STATE_RG" --query id -o tsv)

echo "==> Deployment identity (user-assigned managed identity)"
# A managed identity lives in the subscription, so this works even when your
# university tenant does not allow students to create Entra ID app registrations.
az identity create -n "$IDENTITY_NAME" -g "$STATE_RG" -l "$LOCATION" -o none
CLIENT_ID=$(az identity show -n "$IDENTITY_NAME" -g "$STATE_RG" --query clientId -o tsv)
SP_OBJECT_ID=$(az identity show -n "$IDENTITY_NAME" -g "$STATE_RG" --query principalId -o tsv)

echo "==> Federated credentials (GitHub OIDC - no passwords stored in GitHub)"
add_fic() { # name subject
  if ! az identity federated-credential show -n "$1" --identity-name "$IDENTITY_NAME" -g "$STATE_RG" -o none 2>/dev/null; then
    az identity federated-credential create -n "$1" --identity-name "$IDENTITY_NAME" -g "$STATE_RG" \
      --issuer "https://token.actions.githubusercontent.com" --subject "$2" \
      --audiences "api://AzureADTokenExchange" -o none
  fi
}
add_fic gh-main           "repo:${GITHUB_REPO}:ref:refs/heads/main"     # build push, terraform plan on main
add_fic gh-env-production "repo:${GITHUB_REPO}:environment:production"  # terraform apply, release
add_fic gh-pull-request   "repo:${GITHUB_REPO}:pull_request"            # terraform plan on PRs

echo "    waiting 30s for the identity to replicate..."
sleep 30

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
  AZURE_CLIENT_ID        = $CLIENT_ID
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
  gh secret   set AZURE_CLIENT_ID          -R "$GITHUB_REPO" -b "$CLIENT_ID"
  gh secret   set AZURE_TENANT_ID          -R "$GITHUB_REPO" -b "$TENANT_ID"
  gh secret   set AZURE_SUBSCRIPTION_ID    -R "$GITHUB_REPO" -b "$SUBSCRIPTION_ID"
  gh variable set TF_STATE_RESOURCE_GROUP  -R "$GITHUB_REPO" -b "$STATE_RG"
  gh variable set TF_STATE_STORAGE_ACCOUNT -R "$GITHUB_REPO" -b "$STATE_SA"
else
  echo "gh CLI not found/logged in - add the values above manually in GitHub."
fi
