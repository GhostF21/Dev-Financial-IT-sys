resource "random_password" "postgres_admin" {
  length           = 32
  special          = true
  override_special = "-_.~"
  min_lower        = 2
  min_upper        = 2
  min_numeric      = 2
}

resource "azurerm_postgresql_flexible_server" "main" {
  name                = local.postgres_name
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  version             = var.postgres_version
  sku_name            = var.postgres_sku
  storage_mb          = var.postgres_storage_mb
  auto_grow_enabled   = true

  administrator_login    = var.postgres_admin_login
  administrator_password = random_password.postgres_admin.result

  # Private access only: reachable from the VNet (Container Apps), not from the internet.
  delegated_subnet_id           = azurerm_subnet.postgres.id
  private_dns_zone_id           = azurerm_private_dns_zone.postgres.id
  public_network_access_enabled = false

  backup_retention_days        = var.postgres_backup_retention_days
  geo_redundant_backup_enabled = var.postgres_geo_redundant_backup

  dynamic "high_availability" {
    for_each = var.postgres_high_availability ? [1] : []
    content {
      mode = "ZoneRedundant"
    }
  }

  tags = local.tags

  depends_on = [azurerm_private_dns_zone_virtual_network_link.postgres]

  lifecycle {
    # Azure picks the zone; failovers can swap primary/standby zones.
    ignore_changes = [
      zone,
      high_availability[0].standby_availability_zone,
    ]
  }
}

resource "azurerm_postgresql_flexible_server_database" "app" {
  name      = var.postgres_database_name
  server_id = azurerm_postgresql_flexible_server.main.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

# TLS is mandatory (Azure default); stated explicitly so nobody turns it off.
resource "azurerm_postgresql_flexible_server_configuration" "require_tls" {
  name      = "require_secure_transport"
  server_id = azurerm_postgresql_flexible_server.main.id
  value     = "on"
}
