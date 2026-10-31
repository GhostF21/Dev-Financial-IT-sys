# Production configuration. Non-secret values only - this file is committed.

location      = "westeurope"
unique_suffix = "fn01" # CHANGE ME: must keep ACR / Key Vault / PostgreSQL names globally unique

# Your Entra ID user object id (az ad signed-in-user show --query id -o tsv),
# so you can use kubectl and read Key Vault secrets yourself.
admin_object_ids = []

aks_sku_tier       = "Free" # "Standard" for an uptime SLA
aks_node_vm_size   = "Standard_D2s_v5"
aks_node_min_count = 2
aks_node_max_count = 4

postgres_sku                   = "B_Standard_B1ms" # e.g. "GP_Standard_D2ds_v5" + HA for a real bank
postgres_high_availability     = false
postgres_backup_retention_days = 14
