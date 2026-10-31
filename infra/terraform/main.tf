data "azurerm_client_config" "current" {}

locals {
  name = "${var.project}-${var.environment}" # e.g. finnova-prod

  # Globally unique names (no dashes allowed for ACR)
  acr_name      = "acr${var.project}${var.environment}${var.unique_suffix}"
  key_vault     = "kv-${local.name}-${var.unique_suffix}"
  postgres_name = "psql-${local.name}-${var.unique_suffix}"

  # Principal that runs Terraform (the GitHub Actions service principal in CI)
  deployer_object_id = data.azurerm_client_config.current.object_id

  tags = merge({
    project     = var.project
    environment = var.environment
    managed-by  = "terraform"
  }, var.tags)
}

resource "azurerm_resource_group" "main" {
  name     = "rg-${local.name}"
  location = var.location
  tags     = local.tags
}

# ---------- Observability ----------
resource "azurerm_log_analytics_workspace" "main" {
  count = var.enable_monitoring ? 1 : 0

  name                = "log-${local.name}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "PerGB2018"
  retention_in_days   = var.log_retention_days
  tags                = local.tags
}
