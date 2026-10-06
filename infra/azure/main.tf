# Kosmitor on Azure: a stateless container in front of a zone-redundant PostgreSQL
# Flexible Server, secrets in Key Vault, nightly dumps copied to immutable
# storage in a second region, and alerts on the things that lose data.

data "azurerm_client_config" "current" {}

resource "random_string" "suffix" {
  length  = 5
  lower   = true
  upper   = false
  numeric = true
  special = false
}

locals {
  prefix   = "${var.name}-${var.environment}"
  suffix   = random_string.suffix.result
  app_fqdn = "${local.prefix}.${azurerm_container_app_environment.main.default_domain}"
  app_url  = var.custom_domain != "" ? "https://${var.custom_domain}" : "https://${local.app_fqdn}"
  image    = "${azurerm_container_registry.main.login_server}/${var.name}:${var.image_tag}"
  tags = merge({
    application = var.name
    environment = var.environment
    managed_by  = "terraform"
  }, var.tags)
}

resource "azurerm_resource_group" "main" {
  name     = "rg-${local.prefix}"
  location = var.location
  tags     = local.tags
}

# --- Observability ---------------------------------------------------------

resource "azurerm_log_analytics_workspace" "main" {
  name                = "log-${local.prefix}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "PerGB2018"
  retention_in_days   = var.log_retention_days
  tags                = local.tags
}

# --- Network -----------------------------------------------------------------
# The database is reachable only from inside this network; the app's ingress
# is the only public entry point.

resource "azurerm_virtual_network" "main" {
  name                = "vnet-${local.prefix}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  address_space       = var.vnet_address_space
  tags                = local.tags
}

resource "azurerm_subnet" "apps" {
  name                 = "snet-apps"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = var.apps_subnet_prefixes

  delegation {
    name = "container-apps"
    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "postgres" {
  name                 = "snet-postgres"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = var.postgres_subnet_prefixes

  delegation {
    name = "postgres"
    service_delegation {
      name    = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }

  # The PostgreSQL service manages this delegated subnet's service endpoints itself:
  # on 2026-10-06 its first-party app ("Meru19 First Party App") added
  # Microsoft.Storage. Removing it on the next apply would fight the platform and
  # could cut the server off from the storage it uses, so Terraform leaves them be.
  lifecycle {
    ignore_changes = [service_endpoints]
  }
}

resource "azurerm_private_dns_zone" "postgres" {
  name                = "${local.prefix}.private.postgres.database.azure.com"
  resource_group_name = azurerm_resource_group.main.name
  tags                = local.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "postgres" {
  name                  = "link-${local.prefix}"
  resource_group_name   = azurerm_resource_group.main.name
  private_dns_zone_name = azurerm_private_dns_zone.postgres.name
  virtual_network_id    = azurerm_virtual_network.main.id
  registration_enabled  = false
  tags                  = local.tags
}
