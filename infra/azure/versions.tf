terraform {
  required_version = ">= 1.4"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.12"
    }
  }

  # State holds the database password and the app's other secrets. Keep it in a
  # locked-down Azure Storage container rather than on a laptop: the stack in
  # infra/tfstate creates one, and backend.tf.example has the steps.
}

provider "azurerm" {
  subscription_id = var.subscription_id

  features {
    key_vault {
      purge_soft_delete_on_destroy    = false
      recover_soft_deleted_key_vaults = true
    }
    resource_group {
      prevent_deletion_if_contains_resources = true
    }
    postgresql_flexible_server {
      restart_server_on_configuration_value_change = true
    }
    # The backup account forbids key-based access, so the provider must not try
    # to read its data plane (queue/static-website properties) with a key.
    storage {
      data_plane_available = false
    }
    # Deleted workspaces stay recoverable for 14 days under the same name, which
    # would pin a recreated workspace to the old region.
    log_analytics_workspace {
      permanently_delete_on_destroy = true
    }
  }
}
