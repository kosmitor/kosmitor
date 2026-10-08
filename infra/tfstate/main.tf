# Storage for Terraform state: one container that every stack in the
# subscription keeps its state in, each under its own key, in a resource group
# that holds nothing else.
#
# A state file holds secrets in clear (infra/azure's database password among
# them) and is the only record of what a stack owns, so the account is locked
# down: Entra ID sign-in only (account keys, the SAS they sign and local users
# disabled), HTTPS with TLS 1.2 or later, no public access. It also keeps what it
# holds: each earlier state as a version for version_retention_days, soft delete
# for soft_delete_days, a delete lock on the group, and prevent_destroy on the
# group, the account and the container, so a terraform destroy here stops at the
# plan.

locals {
  # Azure's public US regions that have availability zones, which Standard_GZRS
  # needs (az account list-locations, geographyGroup US, availabilityZoneMappings
  # not empty). West US, North Central US and West Central US have none: there
  # the group would be created and the account would then fail.
  us_regions = [
    "centralus", "eastus", "eastus2", "southcentralus", "westus2", "westus3",
  ]

  storage_account_name = var.storage_account_name != null ? var.storage_account_name : "tfstate${random_id.account[0].hex}"

  tags = merge(var.tags, {
    purpose    = "terraform-state"
    managed_by = "terraform"
  })
}

# Six bytes, 12 hex characters: tfstate plus those is 19 of the 24 a name may
# have, and unlikely to be taken. Only drawn when no name is given.
resource "random_id" "account" {
  count       = var.storage_account_name == null ? 1 : 0
  byte_length = 6
}

resource "azurerm_resource_group" "state" {
  name     = var.resource_group_name
  location = var.location
  tags     = local.tags

  lifecycle {
    prevent_destroy = true

    # The original deployment keeps every resource in the United States. The
    # account cannot move once it exists, so a mistyped or copied region, or one
    # without the zones GZRS needs, is caught before anything is created. A
    # precondition rather than a validation on location, which cannot read
    # allow_non_us before Terraform 1.9.
    precondition {
      condition     = var.allow_non_us || contains(local.us_regions, var.location)
      error_message = "${var.location} is not a US region with availability zones, which Standard_GZRS needs (${join(", ", local.us_regions)}). Set allow_non_us = true to use it anyway, once README.md, First-time setup, shows it offers GZRS."
    }
  }
}

resource "azurerm_storage_account" "state" {
  name                = local.storage_account_name
  resource_group_name = azurerm_resource_group.state.name
  location            = azurerm_resource_group.state.location
  account_kind        = "StorageV2"
  account_tier        = "Standard"
  # Three zones in the region plus a copy in the paired region.
  account_replication_type = "GZRS"

  # Entra ID only. Terraform reaches each state as the person running it
  # (use_azuread_auth in the stack's backend.hcl), through the role below. With
  # the keys goes every SAS they sign; a writer can still issue a user-delegation
  # SAS, signed with Entra ID, for up to seven days.
  shared_access_key_enabled = false
  # Local users sign in to SFTP with a password or SSH key of their own, outside
  # Entra ID. SFTP is off, so none could today; this keeps it that way.
  local_user_enabled = false
  # With keys off, the portal would still try one first and show an error; this
  # makes it open the containers with Entra ID.
  default_to_oauth_authentication  = true
  https_traffic_only_enabled       = true
  min_tls_version                  = "TLS1_2"
  allow_nested_items_to_be_public  = false
  cross_tenant_replication_enabled = false
  # Encrypted twice at rest. Chosen once, at creation: changing it replaces the
  # account, which prevent_destroy refuses.
  infrastructure_encryption_enabled = true

  tags = local.tags

  # Every write of a state keeps the previous one as a version, a deleted state
  # included, and soft delete keeps a deleted version or container restorable.
  blob_properties {
    versioning_enabled = true
    delete_retention_policy {
      days = var.soft_delete_days
    }
    container_delete_retention_policy {
      days = var.soft_delete_days
    }
  }

  lifecycle {
    prevent_destroy = true
  }
}

# Each version is a full state, secrets included, and Terraform adds two on
# every locked command (taking the lock and releasing it each write the blob's
# metadata). Deleting those older than version_retention_days keeps their number
# down and stops a rotated secret staying readable for ever; soft delete still
# holds them soft_delete_days more. An account has one lifecycle policy, so this
# replaces any rule set on it by hand.
resource "azurerm_storage_management_policy" "state" {
  storage_account_id = azurerm_storage_account.state.id

  rule {
    name    = "expire-old-state-versions"
    enabled = true
    filters {
      blob_types = ["blockBlob"]
    }
    actions {
      version {
        delete_after_days_since_creation = var.version_retention_days
      }
    }
  }
}

# Through Azure Resource Manager (storage_account_id rather than the account's
# name), which needs no data-plane role and no key.
resource "azurerm_storage_container" "state" {
  name                  = var.container_name
  storage_account_id    = azurerm_storage_account.state.id
  container_access_type = "private"

  lifecycle {
    prevent_destroy = true
  }
}

# use_azuread_auth makes a backend read and write the blob as the signed-in
# identity, and Contributor or Owner on the subscription does not include blob
# data. Scoped to the container, which is all a backend touches. The principal
# type is left for Azure to look up, so the list can mix users, groups and
# service principals.
resource "azurerm_role_assignment" "state_writer" {
  for_each = toset([for id in var.state_writer_object_ids : lower(id)])

  scope                = azurerm_storage_container.state.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = each.value
}

# A delete lock on the group: az group delete, or a portal click, on the group,
# the account or the container fails until someone removes the lock on purpose.
# Locks guard the management plane only, so Terraform still writes state. The
# lock also refuses removing a role assignment inside the group; README.md,
# Operations, says how to take a writer off.
#
# Created last: if the account fails, say in a region without GZRS, the group is
# left with no lock on it and can be deleted by hand (README.md, First-time
# setup). No prevent_destroy: Operations lifts the lock and puts it back, and a
# change to its name or notes replaces it.
resource "azurerm_management_lock" "state" {
  name       = "terraform-state"
  scope      = azurerm_resource_group.state.id
  lock_level = "CanNotDelete"
  notes      = "Holds Terraform state. Remove only to retire this storage on purpose."

  depends_on = [
    azurerm_storage_account.state,
    azurerm_storage_management_policy.state,
    azurerm_storage_container.state,
    azurerm_role_assignment.state_writer,
  ]
}
