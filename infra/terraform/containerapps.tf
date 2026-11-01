# Azure Container Apps environment that runs the services.
# The apps themselves are created / updated by the Release workflow
# (infra/containerapps/deploy.sh), because their images only exist after a Build.

resource "azurerm_container_app_environment" "main" {
  name                               = "cae-${local.name}"
  location                           = azurerm_resource_group.main.location
  resource_group_name                = azurerm_resource_group.main.name
  infrastructure_subnet_id           = azurerm_subnet.apps.id
  infrastructure_resource_group_name = "rg-${local.name}-cae-infra"
  internal_load_balancer_enabled     = false # the api-gateway app gets a public HTTPS endpoint
  logs_destination                   = var.enable_monitoring ? "log-analytics" : null
  log_analytics_workspace_id         = var.enable_monitoring ? azurerm_log_analytics_workspace.main[0].id : null
  tags                               = local.tags

  # Serverless consumption profile: no VMs, so no VM-family vCPU quota is needed.
  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }
}

# Identity the apps use to pull images from ACR and read the DB secrets from Key Vault
resource "azurerm_user_assigned_identity" "apps" {
  name                = "id-${local.name}-apps"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_role_assignment" "apps_acr_pull" {
  scope                            = azurerm_container_registry.main.id
  role_definition_name             = "AcrPull"
  principal_id                     = azurerm_user_assigned_identity.apps.principal_id
  skip_service_principal_aad_check = true
}

resource "azurerm_role_assignment" "apps_kv_secrets_user" {
  scope                            = azurerm_key_vault.main.id
  role_definition_name             = "Key Vault Secrets User"
  principal_id                     = azurerm_user_assigned_identity.apps.principal_id
  skip_service_principal_aad_check = true
}
