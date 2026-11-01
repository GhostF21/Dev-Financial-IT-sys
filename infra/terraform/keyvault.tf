resource "azurerm_key_vault" "main" {
  name                       = local.key_vault
  location                   = azurerm_resource_group.main.location
  resource_group_name        = azurerm_resource_group.main.name
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  rbac_authorization_enabled = true
  purge_protection_enabled   = var.key_vault_purge_protection
  soft_delete_retention_days = 7
  tags                       = local.tags
}

resource "azurerm_role_assignment" "kv_secrets_officer" {
  for_each             = toset(concat([local.deployer_object_id], var.admin_object_ids))
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = each.value
}

# RBAC assignments take a moment to propagate before secrets can be written.
resource "time_sleep" "kv_rbac_propagation" {
  create_duration = "60s"
  depends_on      = [azurerm_role_assignment.kv_secrets_officer]
}

# Connection settings; the container apps read them through Key Vault references.
locals {
  db_secrets = {
    "db-host"     = azurerm_postgresql_flexible_server.main.fqdn
    "db-name"     = azurerm_postgresql_flexible_server_database.app.name
    "db-user"     = var.postgres_admin_login
    "db-password" = random_password.postgres_admin.result
  }
}

resource "azurerm_key_vault_secret" "db" {
  for_each     = local.db_secrets
  name         = each.key
  value        = each.value
  key_vault_id = azurerm_key_vault.main.id
  content_type = "text/plain"

  depends_on = [time_sleep.kv_rbac_propagation]
}
