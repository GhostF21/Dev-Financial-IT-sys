output "resource_group_name" {
  value = azurerm_resource_group.main.name
}

output "container_apps_environment_name" {
  value = azurerm_container_app_environment.main.name
}

output "container_apps_identity_name" {
  value = azurerm_user_assigned_identity.apps.name
}

output "acr_name" {
  value = azurerm_container_registry.main.name
}

output "acr_login_server" {
  value = azurerm_container_registry.main.login_server
}

output "key_vault_name" {
  value = azurerm_key_vault.main.name
}

output "postgres_fqdn" {
  value = azurerm_postgresql_flexible_server.main.fqdn
}

# Values the Build / Release workflows expect as GitHub repository variables.
output "github_variables" {
  value = {
    AZURE_RESOURCE_GROUP       = azurerm_resource_group.main.name
    ACR_NAME                   = azurerm_container_registry.main.name
    KEY_VAULT_NAME             = azurerm_key_vault.main.name
    CONTAINER_APPS_ENVIRONMENT = azurerm_container_app_environment.main.name
    CONTAINER_APPS_IDENTITY    = azurerm_user_assigned_identity.apps.name
  }
}
