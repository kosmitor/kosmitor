variable "subscription_id" {
  description = "Azure subscription that holds the state storage. Each stack that keeps its state here names it in its backend.hcl, so the backend signs in to the right tenant whichever subscription az has selected."
  type        = string
  validation {
    condition     = can(regex("^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$", var.subscription_id))
    error_message = "Use the subscription's id, a GUID: az account show --query id -o tsv."
  }
}

variable "location" {
  description = "Region of the resource group and the storage account, which cannot move once created. It must offer Standard_GZRS, which needs availability zones, so only the US regions that have them are accepted (centralus, eastus, eastus2, southcentralus, westus2, westus3) unless allow_non_us is true. README.md, First-time setup, has the command that lists the regions offering GZRS to the subscription."
  type        = string
  default     = "eastus2"
  validation {
    condition     = can(regex("^[a-z0-9]+$", var.location))
    error_message = "Use the region's name as az account list-locations prints it, such as eastus2, not its display name."
  }
}

variable "allow_non_us" {
  description = "Accept a location other than the US regions with availability zones. The original deployment keeps every resource in the US, and the account cannot move once it exists, so any other region is refused at plan time unless this is true; check first that it offers Standard_GZRS."
  type        = bool
  default     = false
}

variable "resource_group_name" {
  description = "Resource group of the state storage. It holds nothing else, so no other stack's teardown (infra/azure's rebuild.sh among them) can reach it."
  type        = string
  default     = "rg-terraform-state"
  validation {
    condition     = can(regex("^[-\\w.()]{0,89}[-\\w()]$", var.resource_group_name))
    error_message = "Use 1 to 90 letters, digits, hyphens, underscores, periods and parentheses, not ending in a period."
  }
}

variable "storage_account_name" {
  description = "Name of the storage account, unique across Azure. Left null, it is tfstate and 12 random hex characters, chosen at the first apply. Set it to adopt an account that already exists, such as one made by the Azure CLI script that preceded this stack (README.md, Adopting existing storage)."
  type        = string
  default     = null
  validation {
    condition     = var.storage_account_name == null || can(regex("^[a-z0-9]{3,24}$", var.storage_account_name))
    error_message = "Use 3 to 24 lowercase letters and digits."
  }
}

variable "container_name" {
  description = "Blob container every stack keeps its state in, each under a key of its own."
  type        = string
  default     = "tfstate"
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.container_name)) && length(regexall("--", var.container_name)) == 0
    error_message = "Use 3 to 63 lowercase letters, digits and single hyphens, starting and ending with a letter or digit."
  }
}

variable "state_writer_object_ids" {
  description = "Entra ID object ids (users, groups or service principals) given Storage Blob Data Contributor on the container: what terraform init, plan and apply of any stack need to read and write its state. Listed here rather than taken from whoever runs apply, so a colleague's apply cannot swap the owner's access for theirs. Every writer can read every stack's state, secrets included. Your own is az ad signed-in-user show --query id -o tsv; a service principal's is az ad sp show --id <app-id> --query id -o tsv, not the app registration's id."
  type        = list(string)
  validation {
    condition = length(var.state_writer_object_ids) > 0 && alltrue([
      for id in var.state_writer_object_ids : can(regex("^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$", id))
    ])
    error_message = "List at least one object id, each a GUID."
  }
}

variable "version_retention_days" {
  description = "Days an earlier version of a state is kept, counted from when it was written, before the lifecycle rule deletes it; soft delete then holds it soft_delete_days more. Each version is a whole state with the secrets it held, so they do not stay for ever."
  type        = number
  default     = 90
  validation {
    condition     = var.version_retention_days >= 1 && floor(var.version_retention_days) == var.version_retention_days
    error_message = "Use a whole number of days, at least 1."
  }
}

variable "soft_delete_days" {
  description = "Days a deleted state, version or container stays restorable (1 to 365)."
  type        = number
  default     = 30
  validation {
    condition     = var.soft_delete_days >= 1 && var.soft_delete_days <= 365 && floor(var.soft_delete_days) == var.soft_delete_days
    error_message = "Use a whole number of days from 1 to 365."
  }
}

variable "tags" {
  description = "Extra tags for the resource group and the storage account. purpose = terraform-state and managed_by = terraform are always set."
  type        = map(string)
  default     = {}
}
