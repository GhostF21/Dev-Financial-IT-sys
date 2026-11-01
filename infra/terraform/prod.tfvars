# Production configuration - cheapest sensible setup for an Azure for Students subscription.
# Non-secret values only: this file is committed.

# Must be a region your subscription is allowed to use (see infra/README.md, step 2).
# italynorth: PostgreSQL Flexible Server is offered there (not in germanywestcentral).
location      = "italynorth"
unique_suffix = "m26c"

# Your Entra ID user object id (az ad signed-in-user show --query id -o tsv),
# so you can read Key Vault secrets yourself.
admin_object_ids = ["4a42be87-b194-4b07-9b4b-917e3b140d09"]

# ---- Cheap extras ----
acr_sku                    = "Basic"
enable_monitoring          = false # Log Analytics is billed per GB; turn on only when you need it
key_vault_purge_protection = false # lets you destroy + recreate freely while learning

# ---- PostgreSQL: smallest burstable tier ----
postgres_sku                   = "B_Standard_B1ms"
postgres_storage_mb            = 32768
postgres_high_availability     = false
postgres_geo_redundant_backup  = false
postgres_backup_retention_days = 7
