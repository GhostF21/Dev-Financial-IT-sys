#!/usr/bin/env bash
# Creates or updates every Finnova container app so it runs the images tagged IMAGE_TAG.
# Called by the Release workflow; also works from Azure Cloud Shell:
#
#   RESOURCE_GROUP=rg-finnova-prod ACR_NAME=acrfinnovaprodxxxx KEY_VAULT_NAME=kv-finnova-prod-xxxx \
#   CONTAINER_APPS_ENVIRONMENT=cae-finnova-prod CONTAINER_APPS_IDENTITY=id-finnova-prod-apps \
#   IMAGE_TAG=<git sha> bash infra/containerapps/deploy.sh
#
# Each app is sent as one full definition (ARM PUT = create or replace), so the
# configuration below is the single source of truth, like the old Kubernetes manifests.
#
# Networking: backends use internal TCP ingress with exposedPort = their port, so inside
# the environment they keep the same addresses as in docker-compose / Kubernetes
# (e.g. account-service:3000) and nginx.conf works unchanged. Only api-gateway is public.
set -euo pipefail

: "${RESOURCE_GROUP:?}" "${ACR_NAME:?}" "${KEY_VAULT_NAME:?}" "${IMAGE_TAG:?}"
: "${CONTAINER_APPS_ENVIRONMENT:?}" "${CONTAINER_APPS_IDENTITY:?}"
MIN_REPLICAS="${MIN_REPLICAS:-1}"
MAX_REPLICAS="${MAX_REPLICAS:-1}"
API_VERSION="2024-03-01"

# name:port - backends first, the gateway last (nginx resolves the backend names when it starts)
BACKENDS="customer-service:3002 identity-service:3003 account-service:3000 payment-service:3001
          ledger-service:3005 notification-service:3004 wallet-service:3006"
GATEWAY="api-gateway:8080"

SUBSCRIPTION_ID=$(az account show --query id -o tsv)
APPS_URL="https://management.azure.com/subscriptions/$SUBSCRIPTION_ID/resourceGroups/$RESOURCE_GROUP/providers/Microsoft.App/containerApps"
ENV_ID=$(az resource show -g "$RESOURCE_GROUP" -n "$CONTAINER_APPS_ENVIRONMENT" \
  --resource-type Microsoft.App/managedEnvironments --query id -o tsv)
LOCATION=$(az resource show --ids "$ENV_ID" --query location -o tsv)
IDENTITY_ID=$(az identity show -g "$RESOURCE_GROUP" -n "$CONTAINER_APPS_IDENTITY" --query id -o tsv)
KV_URI=$(az keyvault show -n "$KEY_VAULT_NAME" --query properties.vaultUri -o tsv) # ends with "/"
ACR_SERVER="$ACR_NAME.azurecr.io"

# Full ARM definition of one app
app_body() { # name port public(true|false)
  jq -n \
    --arg name "$1" --argjson port "$2" --argjson public "$3" \
    --arg location "$LOCATION" --arg env "$ENV_ID" --arg identity "$IDENTITY_ID" \
    --arg acr "$ACR_SERVER" --arg kv "$KV_URI" --arg tag "$IMAGE_TAG" \
    --argjson min "$MIN_REPLICAS" --argjson max "$MAX_REPLICAS" '
    def probe($type; $path; $delay; $period):
      { type: $type, httpGet: { path: $path, port: $port },
        initialDelaySeconds: $delay, periodSeconds: $period };
    def db_secrets: ["db-host", "db-name", "db-user", "db-password"];
    {
      location: $location,
      tags: { project: "finnova", environment: "prod", "managed-by": "release-pipeline" },
      identity: { type: "UserAssigned", userAssignedIdentities: { ($identity): {} } },
      properties: {
        environmentId: $env,
        workloadProfileName: "Consumption",
        configuration: {
          activeRevisionsMode: "Single",
          ingress: (if $public
            then { external: true, transport: "http", targetPort: $port, allowInsecure: false }
            else { external: false, transport: "tcp", targetPort: $port, exposedPort: $port } end),
          registries: [ { server: $acr, identity: $identity } ],
          # DB connection values stay in Key Vault; the app identity reads them at startup.
          secrets: (if $public then [] else
            [ db_secrets[] | { name: ., keyVaultUrl: "\($kv)secrets/\(.)", identity: $identity } ] end)
        },
        template: {
          containers: [ {
            name: $name,
            image: "\($acr)/finnova/\($name):\($tag)",
            resources: { cpu: 0.25, memory: "0.5Gi" },
            env: (if $public then [] else [
              { name: "PORT", value: ($port | tostring) },
              { name: "NODE_ENV", value: "production" },
              { name: "DB_PORT", value: "5432" },
              # Azure PostgreSQL enforces TLS; node-postgres reads PGSSLMODE.
              { name: "PGSSLMODE", value: "require" },
              { name: "CUSTOMER_SERVICE_URL", value: "http://customer-service:3002" },
              { name: "ACCOUNT_SERVICE_URL", value: "http://account-service:3000" },
              { name: "PAYMENT_SERVICE_URL", value: "http://payment-service:3001" },
              { name: "LEDGER_SERVICE_URL", value: "http://ledger-service:3005" },
              { name: "NOTIFICATION_SERVICE_URL", value: "http://notification-service:3004" }
            ] + [ db_secrets[] | { name: (ascii_upcase | gsub("-"; "_")), secretRef: . } ] end),
            probes: [
              probe("Liveness"; "/healthz"; 15; 15),
              probe("Readiness"; (if $public then "/healthz" else "/readyz" end); 5; 10)
            ]
          } ],
          scale: { minReplicas: $min, maxReplicas: $max }
        }
      }
    }'
}

put_app() { # name port public
  local body
  body=$(mktemp)
  app_body "$@" > "$body"
  echo "==> $1: deploying $ACR_SERVER/finnova/$1:$IMAGE_TAG"
  az rest --method put --url "$APPS_URL/$1?api-version=$API_VERSION" \
    --headers "Content-Type=application/json" --body "@$body" -o none
  rm -f "$body"
}

# Waits until the app is provisioned and its newest revision is ready (probes passing).
wait_app() { # name
  local status state latest ready
  for _ in $(seq 1 60); do
    status=$(az rest --method get --url "$APPS_URL/$1?api-version=$API_VERSION" \
      --query "[properties.provisioningState, properties.latestRevisionName, properties.latestReadyRevisionName]" -o tsv | tr '\n' ' ')
    read -r state latest ready <<< "$status"
    case "$state" in
      Failed | Canceled)
        echo "::error::$1: provisioning $state"
        return 1
        ;;
      Succeeded)
        if [ -n "$latest" ] && [ "$latest" = "$ready" ]; then
          echo "    $1 ready ($latest)"
          return 0
        fi
        ;;
    esac
    sleep 10
  done
  echo "::error::$1: revision $latest did not become ready within 10 minutes"
  return 1
}

for app in $BACKENDS; do put_app "${app%%:*}" "${app#*:}" false; done
for app in $BACKENDS; do wait_app "${app%%:*}"; done

put_app "${GATEWAY%%:*}" "${GATEWAY#*:}" true
wait_app "${GATEWAY%%:*}"

FQDN=$(az rest --method get --url "$APPS_URL/${GATEWAY%%:*}?api-version=$API_VERSION" \
  --query properties.configuration.ingress.fqdn -o tsv)
echo "Public endpoint: https://$FQDN"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "url=https://$FQDN" >> "$GITHUB_OUTPUT"
fi
