variable "subscription_id" {
  description = "Azure subscription that receives every resource."
  type        = string
}

variable "name" {
  description = "Short application name used in resource names (lowercase letters and digits)."
  type        = string
  default     = "kosmitor"
  validation {
    condition     = can(regex("^[a-z][a-z0-9]{1,11}$", var.name))
    error_message = "Use 2 to 12 lowercase letters or digits."
  }
}

variable "environment" {
  description = "Deployment stage, part of every resource name."
  type        = string
  default     = "prod"
}

variable "location" {
  description = "Primary region for the application and its database. Must offer zone-redundant PostgreSQL Flexible Server to the subscription: check with `az postgres flexible-server list-skus --location <region>`."
  type        = string
  default     = "centralus"
}

variable "backup_location" {
  description = "Region for the independent backup copies; different from the primary so a regional incident cannot take both."
  type        = string
  default     = "westus2"
}

variable "vnet_address_space" {
  description = "Address space of the virtual network that holds the app environment and the database. Choose it, and the two subnets inside it, before the first apply: Azure will not renumber a subnet that is in use."
  type        = list(string)
  default     = ["10.60.0.0/16"]
}

variable "apps_subnet_prefixes" {
  description = "Subnet delegated to the Container Apps environment (a workload profiles environment needs at least a /27)."
  type        = list(string)
  default     = ["10.60.0.0/23"]
}

variable "postgres_subnet_prefixes" {
  description = "Subnet delegated to the PostgreSQL Flexible Server (at least a /28)."
  type        = list(string)
  default     = ["10.60.2.0/28"]
}

variable "alert_email" {
  description = "Where operational alerts (database health, failed backups, 5xx spikes) are sent."
  type        = string
}

variable "alerts" {
  description = "When each operational alert fires. Set only what you change, for example { postgres_cpu = { percent = 90 } }. postgres_storage and postgres_cpu fire above percent, averaged over the window; app_5xx above that many server-error responses in the window. frequency is how often the rule is evaluated (PT1M, PT5M, PT15M, PT30M or PT1H) and window the period it looks back over (one of those, or PT6H, PT12H or P1D, and no shorter than frequency)."
  type = object({
    postgres_down = optional(object({
      frequency = optional(string, "PT1M")
      window    = optional(string, "PT5M")
    }), {})
    postgres_storage = optional(object({
      percent   = optional(number, 85)
      frequency = optional(string, "PT5M")
      window    = optional(string, "PT15M")
    }), {})
    postgres_cpu = optional(object({
      percent   = optional(number, 85)
      frequency = optional(string, "PT5M")
      window    = optional(string, "PT15M")
    }), {})
    app_5xx = optional(object({
      requests  = optional(number, 25)
      frequency = optional(string, "PT5M")
      window    = optional(string, "PT15M")
    }), {})
    job_failed = optional(object({
      frequency = optional(string, "PT1H")
      window    = optional(string, "P1D")
    }), {})
  })
  default = {}
  validation {
    condition = alltrue([
      for a in [var.alerts.postgres_down, var.alerts.postgres_storage, var.alerts.postgres_cpu, var.alerts.app_5xx, var.alerts.job_failed] :
      contains(["PT1M", "PT5M", "PT15M", "PT30M", "PT1H"], a.frequency) && contains(["PT1M", "PT5M", "PT15M", "PT30M", "PT1H", "PT6H", "PT12H", "P1D"], a.window)
    ])
    error_message = "Each frequency must be PT1M, PT5M, PT15M, PT30M or PT1H, and each window one of those or PT6H, PT12H or P1D."
  }
}

variable "log_retention_days" {
  description = "Days the Log Analytics workspace keeps application, job and database logs (30 to 730)."
  type        = number
  default     = 90
}

variable "postgres_sku_name" {
  description = "Flexible Server compute. General Purpose is the smallest tier that supports zone-redundant high availability."
  type        = string
  default     = "GP_Standard_D2ds_v5"
}

variable "postgres_storage_mb" {
  description = "Database storage in MB; grows automatically when it fills."
  type        = number
  default     = 131072
}

variable "postgres_high_availability" {
  description = "Zone-redundant standby with automatic failover. Doubles compute cost; turn off only for a staging environment."
  type        = bool
  default     = true
}

variable "postgres_backup_retention_days" {
  description = "Point-in-time recovery window kept by the managed service (7 to 35 days)."
  type        = number
  default     = 35
}

variable "backup_retention_days" {
  description = "How long nightly dump copies stay immutable in the backup storage account."
  type        = number
  default     = 90
}

variable "backup_job" {
  description = "The nightly backup job: its schedule (cron, UTC), how long one run may take, how many times a failed run is retried, and its size. cpu and memory must be a pair Container Apps accepts, such as 0.5 and 1Gi or 1 and 2Gi."
  type = object({
    schedule        = optional(string, "0 2 * * *")
    timeout_seconds = optional(number, 3600)
    retry_limit     = optional(number, 1)
    cpu             = optional(number, 0.5)
    memory          = optional(string, "1Gi")
  })
  default = {}
}

variable "restore_drill_job" {
  description = "The weekly restore drill: the same settings as backup_job. It restores the whole dump, so it gets more time and memory."
  type = object({
    schedule        = optional(string, "0 4 * * 0")
    timeout_seconds = optional(number, 7200)
    retry_limit     = optional(number, 0)
    cpu             = optional(number, 1)
    memory          = optional(string, "2Gi")
  })
  default = {}
}

variable "drill_database" {
  description = "Scratch database the restore drill restores into and drops again (DRILL_DATABASE). Empty uses backup.drillDatabase from kosmitor.config.json."
  type        = string
  default     = ""
}

variable "protect_database" {
  description = "Put a CanNotDelete lock on the database server, so no portal click, script or `az group delete` can remove it. Turn it on once real data is in. A deliberate `terraform destroy` still works, because Terraform removes the lock before the server; deleting the resource group by hand does not, so set this to false and apply first."
  type        = bool
  default     = false
}

variable "image_tag" {
  description = "Tag of the application image to build and run. Change it to roll out a new build."
  type        = string
  default     = "v1"
}

variable "build_image" {
  description = "Build the image in the registry with `az acr build` during apply (needs the Azure CLI signed in). Set false when CI pushes images."
  type        = bool
  default     = true
}

variable "app_cpu" {
  description = "vCPU per application replica."
  type        = number
  default     = 0.5
}

variable "app_memory" {
  description = "Memory per application replica."
  type        = string
  default     = "1Gi"
}

variable "min_replicas" {
  description = "Replicas always running (1 avoids cold starts)."
  type        = number
  default     = 1
}

variable "max_replicas" {
  description = "Upper bound for HTTP scaling."
  type        = number
  default     = 3
}

variable "http_scale_concurrent_requests" {
  description = "Concurrent requests per replica above which Container Apps starts another, up to max_replicas."
  type        = number
  default     = 50
}

variable "pg_pool_max" {
  description = "Database connections each application replica keeps open (PG_POOL_MAX). Keep max_replicas times this, plus the jobs, under the server's connection limit."
  type        = number
  default     = 10
  validation {
    condition     = var.pg_pool_max >= 1 && floor(var.pg_pool_max) == var.pg_pool_max
    error_message = "Use a whole number of at least 1."
  }
}

variable "custom_hostnames" {
  description = "Hostnames to bind to the app with free managed certificates, each mapped to the ownership check Azure runs: HTTP for a bare domain served by an A record, CNAME for a subdomain served by a CNAME record. Their DNS records and the asuid TXT records must resolve before applying."
  type        = map(string)
  default     = {}
  validation {
    condition     = alltrue([for m in values(var.custom_hostnames) : contains(["CNAME", "HTTP", "TXT"], m)])
    error_message = "Each value must be CNAME, HTTP or TXT."
  }
}

variable "custom_domain" {
  description = "The canonical hostname the app advertises: APP_URL for links in emails and the allowed browser origin (e.g. app.example.com). Set it once that hostname is bound through custom_hostnames; the default Azure hostname keeps working."
  type        = string
  default     = ""
}

variable "communication_data_location" {
  description = "Where Azure Communication Services keeps its data, such as \"United States\", \"Europe\", \"UK\" or \"Canada\". Choose it before the first apply: changing it replaces the email services, and with them the managed sender address."
  type        = string
  default     = "United States"
}

variable "email_domain" {
  description = "A domain of your own to send mail from, such as example.com. Leave empty to send from the free Azure managed domain, which needs no DNS. Setting it creates the domain in Azure and publishes the records to add at your registrar in the email_dns_records output."
  type        = string
  default     = ""
}

variable "email_domain_verified" {
  description = "Set to true once the records from email_dns_records resolve and Azure shows Domain, SPF, DKIM and DKIM2 verified (it checks only when asked: Verify in the portal, or az communication email domain initiate-verification), then apply again. Attaching an unverified domain fails, so this stays false until the DNS is in place and the managed domain carries the mail meanwhile."
  type        = bool
  default     = false
}

variable "email_sender_local_part" {
  description = "The part before the @ when sending from your own domain. Azure accepts only DoNotReply on a new custom domain; any other name needs the domain's sending limit raised first (an Azure support ticket) and then a sender username added to the domain."
  type        = string
  default     = "DoNotReply"
}

variable "mail_display_name" {
  description = "The name recipients see beside the sending address."
  type        = string
  default     = "Kosmitor"
}

variable "mail_from" {
  description = "Overrides the sender entirely, e.g. \"Kosmitor <DoNotReply@example.com>\". Leave empty and it is built from mail_display_name and whichever domain is active."
  type        = string
  default     = ""
}

variable "smtp_url" {
  description = "SMTP connection string (smtps://user:pass@host:465). Empty disables email; pass it with TF_VAR_smtp_url rather than a file."
  type        = string
  default     = ""
  sensitive   = true
}

variable "google_client_id" {
  description = "Google OAuth client ID for \"Sign in with Google\"; empty disables it."
  type        = string
  default     = ""
}

variable "google_allowed_domains" {
  description = "Comma-separated email domains allowed to sign in with Google; empty allows any."
  type        = string
  default     = ""
}

variable "tags" {
  description = "Extra tags for every resource."
  type        = map(string)
  default     = {}
}
