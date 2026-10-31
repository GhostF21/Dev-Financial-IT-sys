# Production configuration - cheapest sensible setup for an Azure for Students subscription.
# Non-secret values only: this file is committed.

# Must be a region your subscription is allowed to use (see infra/README.md, step 2).
location      = "italynorth"
unique_suffix = "M26Y"

# Your Entra ID user object id (az ad signed-in-user show --query id -o tsv),
# so you can use kubectl and read Key Vault secrets yourself.
admin_object_ids = ["4a42be87-b194-4b07-9b4b-917e3b140d09"]

# ---- Kubernetes: one small node, autoscaler may add a 2nd under load ----
aks_sku_tier        = "Free"
aks_node_vm_size    = "Standard_B2als_v2"
aks_node_min_count  = 1
aks_node_max_count  = 2
aks_os_disk_size_gb = 30

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
