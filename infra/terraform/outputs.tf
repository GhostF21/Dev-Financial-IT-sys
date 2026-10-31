output "resource_group_name" {
  value = azurerm_resource_group.main.name
}

output "aks_cluster_name" {
  value = azurerm_kubernetes_cluster.main.name
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
    AZURE_RESOURCE_GROUP = azurerm_resource_group.main.name
    AKS_CLUSTER_NAME     = azurerm_kubernetes_cluster.main.name
    ACR_NAME             = azurerm_container_registry.main.name
    KEY_VAULT_NAME       = azurerm_key_vault.main.name
  }
}
