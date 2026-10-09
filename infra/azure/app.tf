# The application: one image, built in the registry, run by Container Apps
# behind HTTPS ingress, plus two scheduled jobs from the same image.

resource "azurerm_container_registry" "main" {
  name                = "acr${var.name}${var.environment}${local.suffix}"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku                 = "Basic"
  admin_enabled       = false
  tags                = local.tags
}

resource "azurerm_user_assigned_identity" "app" {
  name                = "id-${local.prefix}-app"
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  tags                = local.tags
}

resource "azurerm_role_assignment" "acr_pull" {
  scope                = azurerm_container_registry.main.id
  role_definition_name = "AcrPull"
  principal_id         = azurerm_user_assigned_identity.app.principal_id

  # The identity is seconds old here. Naming its type saves the provider a
  # directory lookup that often has not caught up yet and fails with
  # PrincipalNotFound.
  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

# Builds the image inside Azure Container Registry, so no local Docker daemon is
# needed. Re-runs whenever image_tag changes.
resource "terraform_data" "image" {
  count            = var.build_image ? 1 : 0
  triggers_replace = [var.image_tag]

  provisioner "local-exec" {
    working_dir = "${path.module}/../.."
    command     = "az acr build --subscription ${var.subscription_id} --registry ${azurerm_container_registry.main.name} --image ${var.name}:${var.image_tag} --file Dockerfile ."
  }

  depends_on = [azurerm_container_registry.main]
}

resource "azurerm_container_app_environment" "main" {
  name                               = "cae-${local.prefix}"
  location                           = azurerm_resource_group.main.location
  resource_group_name                = azurerm_resource_group.main.name
  log_analytics_workspace_id         = azurerm_log_analytics_workspace.main.id
  infrastructure_subnet_id           = azurerm_subnet.apps.id
  infrastructure_resource_group_name = "rg-${local.prefix}-cae-infra"
  internal_load_balancer_enabled     = false
  zone_redundancy_enabled            = true
  tags                               = local.tags

  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }
}

locals {
  # The app's environment. APP_URL, ALLOWED_ORIGINS, PG_POOL_MAX, TRUST_PROXY,
  # MAIL_FROM, GOOGLE_* and VALUATION_*_EMAIL win over kosmitor.config.json in the image, which (with
  # kosmitor.config.local.json when the build context has one) supplies every
  # other setting. Container Apps ingress is a proxy in front of every request,
  # so the client address comes from X-Forwarded-For.
  app_env = merge({
    NODE_ENV        = "production"
    PORT            = "4000"
    APP_URL         = local.app_url
    ALLOWED_ORIGINS = local.app_url
    WEB_DIST        = "/app/apps/web/dist"
    PG_POOL_MAX     = tostring(var.pg_pool_max)
    TRUST_PROXY     = "true"
    # Strangers can sign up here, so an address is confirmed before its account works.
    VERIFY_EMAIL = "true"
    },
    { MAIL_FROM = local.mail_from },
    { VALUATION_APPROVAL_EMAIL = var.valuation_approval_email },
    var.google_client_id != "" ? { GOOGLE_CLIENT_ID = var.google_client_id } : {},
    var.google_allowed_domains != "" ? { GOOGLE_ALLOWED_DOMAINS = var.google_allowed_domains } : {},
    length(var.valuation_desk_emails) > 0 ? { VALUATION_DESK_EMAIL = join(",", var.valuation_desk_emails) } : {},
  )
}

resource "azurerm_container_app" "main" {
  name                         = local.prefix
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"
  tags                         = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.app.id
  }

  secret {
    name                = "database-url"
    identity            = azurerm_user_assigned_identity.app.id
    key_vault_secret_id = azurerm_key_vault_secret.database_url.versionless_id
  }

  secret {
    name                = "secret-key"
    identity            = azurerm_user_assigned_identity.app.id
    key_vault_secret_id = azurerm_key_vault_secret.secret_key.versionless_id
  }

  secret {
    name                = "acs-connection-string"
    identity            = azurerm_user_assigned_identity.app.id
    key_vault_secret_id = azurerm_key_vault_secret.acs_connection.versionless_id
  }

  dynamic "secret" {
    for_each = var.smtp_url != "" ? [1] : []
    content {
      name                = "smtp-url"
      identity            = azurerm_user_assigned_identity.app.id
      key_vault_secret_id = azurerm_key_vault_secret.smtp_url[0].versionless_id
    }
  }

  ingress {
    external_enabled = true
    target_port      = 4000
    transport        = "auto"
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = var.min_replicas
    max_replicas = var.max_replicas

    container {
      name   = var.name
      image  = local.image
      cpu    = var.app_cpu
      memory = var.app_memory

      dynamic "env" {
        for_each = local.app_env
        content {
          name  = env.key
          value = env.value
        }
      }

      env {
        name        = "DATABASE_URL"
        secret_name = "database-url"
      }

      env {
        name        = "KOSMITOR_SECRET_KEY"
        secret_name = "secret-key"
      }

      env {
        name        = "ACS_CONNECTION_STRING"
        secret_name = "acs-connection-string"
      }

      dynamic "env" {
        for_each = var.smtp_url != "" ? [1] : []
        content {
          name        = "SMTP_URL"
          secret_name = "smtp-url"
        }
      }

      startup_probe {
        transport               = "HTTP"
        port                    = 4000
        path                    = "/api/ready"
        interval_seconds        = 5
        failure_count_threshold = 30
      }

      readiness_probe {
        transport               = "HTTP"
        port                    = 4000
        path                    = "/api/ready"
        interval_seconds        = 10
        failure_count_threshold = 3
      }

      liveness_probe {
        transport               = "HTTP"
        port                    = 4000
        path                    = "/api/health"
        interval_seconds        = 30
        failure_count_threshold = 3
      }
    }

    http_scale_rule {
      name                = "http"
      concurrent_requests = tostring(var.http_scale_concurrent_requests)
    }
  }

  # MAIL_FROM names the custom domain as soon as email_domain_verified is set, and
  # Azure refuses mail from a domain it has not yet linked, so the app rolls to the
  # new sender only after the link exists.
  depends_on = [
    time_sleep.rbac,
    terraform_data.image,
    azurerm_communication_service_email_domain_association.custom,
  ]

  lifecycle {
    # Images up to v21 read VALUATION_DESK_EMAIL as one address and refuse a list,
    # so a revision with several would not start. Stops the plan instead.
    precondition {
      condition     = length(var.valuation_desk_emails) <= 1 || !can(regex("^v([0-9]|1[0-9]|2[01])$", var.image_tag))
      error_message = "valuation_desk_emails lists more than one address, which needs an image built after v21: image_tag ${var.image_tag} reads one address and would not start."
    }
  }
}

# --- Scheduled jobs from the same image -------------------------------------

locals {
  job_env = merge({
    BACKUP_ACCOUNT_URL = trimsuffix(azurerm_storage_account.backups.primary_blob_endpoint, "/")
    BACKUP_CONTAINER   = azurerm_storage_container.backups.name
    BACKUP_PREFIX      = var.name
    AZURE_CLIENT_ID    = azurerm_user_assigned_identity.app.client_id
    NODE_ENV           = "production"
    },
    # Jobs load the same validated configuration as the app, including the review inbox.
    { VALUATION_APPROVAL_EMAIL = var.valuation_approval_email },
    var.drill_database != "" ? { DRILL_DATABASE = var.drill_database } : {},
  )
}

# Nightly (backup_job.schedule): pg_dump the database and copy it to the immutable
# backup container.
resource "azurerm_container_app_job" "backup" {
  name                         = "${local.prefix}-backup"
  location                     = azurerm_resource_group.main.location
  resource_group_name          = azurerm_resource_group.main.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  workload_profile_name        = "Consumption"
  replica_timeout_in_seconds   = var.backup_job.timeout_seconds
  replica_retry_limit          = var.backup_job.retry_limit
  tags                         = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.app.id
  }

  secret {
    name                = "database-url"
    identity            = azurerm_user_assigned_identity.app.id
    key_vault_secret_id = azurerm_key_vault_secret.database_url.versionless_id
  }

  schedule_trigger_config {
    cron_expression          = var.backup_job.schedule
    parallelism              = 1
    replica_completion_count = 1
  }

  template {
    container {
      name    = "backup"
      image   = local.image
      cpu     = var.backup_job.cpu
      memory  = var.backup_job.memory
      command = ["node", "apps/server/src/backup-upload.ts"]

      dynamic "env" {
        for_each = local.job_env
        content {
          name  = env.key
          value = env.value
        }
      }

      env {
        name        = "DATABASE_URL"
        secret_name = "database-url"
      }
    }
  }

  depends_on = [
    time_sleep.rbac,
    terraform_data.image,
  ]
}

# Weekly (restore_drill_job.schedule): the same dump, then a restore into a scratch
# database with a row-count comparison, so the backups are proven restorable.
resource "azurerm_container_app_job" "restore_drill" {
  name                         = "${local.prefix}-restore-drill"
  location                     = azurerm_resource_group.main.location
  resource_group_name          = azurerm_resource_group.main.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  workload_profile_name        = "Consumption"
  replica_timeout_in_seconds   = var.restore_drill_job.timeout_seconds
  replica_retry_limit          = var.restore_drill_job.retry_limit
  tags                         = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.app.id]
  }

  registry {
    server   = azurerm_container_registry.main.login_server
    identity = azurerm_user_assigned_identity.app.id
  }

  secret {
    name                = "database-url"
    identity            = azurerm_user_assigned_identity.app.id
    key_vault_secret_id = azurerm_key_vault_secret.database_url.versionless_id
  }

  schedule_trigger_config {
    cron_expression          = var.restore_drill_job.schedule
    parallelism              = 1
    replica_completion_count = 1
  }

  template {
    container {
      name    = "restore-drill"
      image   = local.image
      cpu     = var.restore_drill_job.cpu
      memory  = var.restore_drill_job.memory
      command = ["node", "apps/server/src/backup-upload.ts", "--drill"]

      dynamic "env" {
        for_each = local.job_env
        content {
          name  = env.key
          value = env.value
        }
      }

      env {
        name        = "DATABASE_URL"
        secret_name = "database-url"
      }
    }
  }

  depends_on = [
    time_sleep.rbac,
    terraform_data.image,
  ]
}
