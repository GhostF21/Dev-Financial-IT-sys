resource "azurerm_container_registry" "main" {
  name                          = local.acr_name
  location                      = azurerm_resource_group.main.location
  resource_group_name           = azurerm_resource_group.main.name
  sku                           = var.acr_sku
  admin_enabled                 = false # identities + RBAC only, no shared admin password
  anonymous_pull_enabled        = false
  public_network_access_enabled = true # GitHub-hosted runners push over the internet
  tags                          = local.tags
}

# The CI pipeline (same service principal that runs Terraform) pushes images
resource "azurerm_role_assignment" "deployer_acr_push" {
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPush"
  principal_id         = local.deployer_object_id
}
