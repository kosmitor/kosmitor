# PostgreSQL Flexible Server: zone-redundant standby, 35 days of point-in-time
# recovery, geo-redundant backups in the paired region, private access only.

resource "random_password" "postgres_admin" {
  length  = 32
  special = false # keeps the connection URL free of escaping surprises
}

resource "azurerm_postgresql_flexible_server" "main" {
  name                          = "psql-${local.prefix}-${local.suffix}"
  resource_group_name           = azurerm_resource_group.main.name
  location                      = azurerm_resource_group.main.location
  version                       = "17"
  delegated_subnet_id           = azurerm_subnet.postgres.id
  private_dns_zone_id           = azurerm_private_dns_zone.postgres.id
  public_network_access_enabled = false

  administrator_login    = "kosmitor_admin"
  administrator_password = random_password.postgres_admin.result

  sku_name          = var.postgres_sku_name
  storage_mb        = var.postgres_storage_mb
  auto_grow_enabled = true
  zone              = "1"

  backup_retention_days        = var.postgres_backup_retention_days
  geo_redundant_backup_enabled = true

  dynamic "high_availability" {
    for_each = var.postgres_high_availability ? [1] : []
    content {
      mode                      = "ZoneRedundant"
      standby_availability_zone = "2"
    }
  }

  maintenance_window {
    day_of_week  = 0
    start_hour   = 3
    start_minute = 0
  }

  authentication {
    password_auth_enabled         = true
    active_directory_auth_enabled = false
  }

  tags       = local.tags
  depends_on = [azurerm_private_dns_zone_virtual_network_link.postgres]

  lifecycle {
    # A failover swaps the primary and standby zones; that is not drift.
    ignore_changes = [zone, high_availability[0].standby_availability_zone]
  }
}

resource "azurerm_postgresql_flexible_server_database" "main" {
  name      = "kosmitor"
  server_id = azurerm_postgresql_flexible_server.main.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

resource "azurerm_postgresql_flexible_server_configuration" "require_ssl" {
  name      = "require_secure_transport"
  server_id = azurerm_postgresql_flexible_server.main.id
  value     = "on"
}

# Nothing else in this stack holds data that cannot be rebuilt from the code, so
# this is the one resource worth making awkward to delete.
resource "azurerm_management_lock" "postgres" {
  count      = var.protect_database ? 1 : 0
  name       = "lock-${local.prefix}-postgres"
  scope      = azurerm_postgresql_flexible_server.main.id
  lock_level = "CanNotDelete"
  notes      = "Holds the production cap table. Set protect_database = false and apply before any deliberate teardown."
}

resource "azurerm_monitor_diagnostic_setting" "postgres" {
  name                       = "diag-${local.prefix}-postgres"
  target_resource_id         = azurerm_postgresql_flexible_server.main.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  enabled_log {
    category = "PostgreSQLLogs"
  }
}

locals {
  database_url = "postgres://${azurerm_postgresql_flexible_server.main.administrator_login}:${urlencode(random_password.postgres_admin.result)}@${azurerm_postgresql_flexible_server.main.fqdn}:5432/${azurerm_postgresql_flexible_server_database.main.name}?sslmode=require"
}
