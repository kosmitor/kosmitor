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
  }

  # This stack's own state goes into the container it creates, under
  # tfstate.tfstate, once that container exists: the first apply keeps it in a
  # local file. backend.tf.example has the steps, README.md the reasons.
}

provider "azurerm" {
  subscription_id = var.subscription_id

  # The account refuses account keys and the SAS they sign, so nothing may try
  # one. Every setting here goes through Azure Resource Manager (the blob
  # properties, the lifecycle rule, the container by storage_account_id), so the
  # provider need not reach the data plane at all; left on, it would read the
  # account's queue and static-website properties there and fail, with a key or
  # without a queue role. storage_use_azuread covers anything that still does: it
  # signs in with Entra ID, never with a key.
  storage_use_azuread = true

  features {
    storage {
      data_plane_available = false
    }
  }
}
