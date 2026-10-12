# Independent backup copies: a geo-zone-redundant storage account in another
# region, versioned, with blobs that cannot be altered or deleted before the
# retention period ends. Identity-only access; shared keys are disabled.

resource "azurerm_storage_account" "backups" {
  name                            = "st${var.name}bk${local.suffix}"
  resource_group_name             = azurerm_resource_group.main.name
  location                        = var.backup_location
  account_kind                    = "StorageV2"
  account_tier                    = "Standard"
  account_replication_type        = "GZRS"
  access_tier                     = "Cool"
  min_tls_version                 = "TLS1_2"
  https_traffic_only_enabled      = true
  allow_nested_items_to_be_public = false
  shared_access_key_enabled       = false
  tags                            = local.tags

  blob_properties {
    versioning_enabled = true
    delete_retention_policy {
      days = 30
    }
    container_delete_retention_policy {
      days = 30
    }
  }
}

resource "azurerm_storage_container" "backups" {
  name                  = "backups"
  storage_account_id    = azurerm_storage_account.backups.id
  container_access_type = "private"
}

# Time-based immutability: a dump written today cannot be deleted or overwritten
# for backup_retention_days, by anyone, including an attacker holding the
# subscription. Lock the policy once you are happy with the retention period.
resource "azurerm_storage_container_immutability_policy" "backups" {
  storage_container_resource_manager_id = azurerm_storage_container.backups.id
  immutability_period_in_days           = var.backup_retention_days
  protected_append_writes_all_enabled   = false
  protected_append_writes_enabled       = false
  locked                                = false
}

# Cool storage after a month, gone after the retention period has long lapsed.
resource "azurerm_storage_management_policy" "backups" {
  storage_account_id = azurerm_storage_account.backups.id

  rule {
    name    = "age-out-dumps"
    enabled = true
    filters {
      prefix_match = ["${azurerm_storage_container.backups.name}/"]
      blob_types   = ["blockBlob"]
    }
    actions {
      base_blob {
        tier_to_cool_after_days_since_modification_greater_than = 30
        delete_after_days_since_modification_greater_than       = var.backup_retention_days + 300
      }
      version {
        delete_after_days_since_creation = var.backup_retention_days + 300
      }
    }
  }
}

# The jobs may write new dumps; they cannot delete anything (immutability) nor
# read the account keys (disabled).
resource "azurerm_role_assignment" "backup_writer" {
  scope                = azurerm_storage_container.backups.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.app.principal_id

  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

# The deployers can list and download dumps for a restore; never delete (immutability).
resource "azurerm_role_assignment" "backup_reader_deployer" {
  for_each = local.deployer_object_ids

  scope                = azurerm_storage_container.backups.id
  role_definition_name = "Storage Blob Data Reader"
  principal_id         = each.value
}
