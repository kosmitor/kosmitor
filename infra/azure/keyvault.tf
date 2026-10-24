# Secrets live in Key Vault and reach the containers through their managed
# identity; nothing sensitive is written into the app definition or the image.

resource "azurerm_key_vault" "main" {
  name                       = "kv-${local.prefix}-${local.suffix}"
  location                   = azurerm_resource_group.main.location
  resource_group_name        = azurerm_resource_group.main.name
  tenant_id                  = data.azurerm_client_config.current.tenant_id
  sku_name                   = "standard"
  rbac_authorization_enabled = true
  purge_protection_enabled   = true
  soft_delete_retention_days = 90
  tags                       = local.tags
}

# The deployers write the secrets.
resource "azurerm_role_assignment" "kv_deployer" {
  for_each = local.deployer_object_ids

  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets Officer"
  principal_id         = each.value
}

# The application and its jobs read them.
resource "azurerm_role_assignment" "kv_app" {
  scope                = azurerm_key_vault.main.id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_user_assigned_identity.app.principal_id

  principal_type                   = "ServicePrincipal"
  skip_service_principal_aad_check = true
}

# A role assignment is accepted before it is enforced everywhere, and a container
# that starts too early fails to pull its image or read its secrets and takes the
# whole apply down with it. Everything the app and its jobs need is gathered here
# so they wait once, for all of it.
resource "time_sleep" "rbac" {
  depends_on = [
    azurerm_role_assignment.kv_deployer,
    azurerm_role_assignment.kv_app,
    azurerm_role_assignment.acr_pull,
    azurerm_role_assignment.backup_writer,
  ]
  create_duration = "120s"
}

# Encrypts the API keys people hand the assistant. Generated once and held in the
# vault, so the database that stores the ciphertext does not also hold the key.
# Replacing it would make every stored key unreadable, so it is pinned.
resource "random_password" "secret_key" {
  length  = 48
  special = false

  lifecycle {
    ignore_changes = [length, special]
  }
}

resource "azurerm_key_vault_secret" "secret_key" {
  name         = "secret-key"
  value        = random_password.secret_key.result
  key_vault_id = azurerm_key_vault.main.id
  content_type = "Application secret-encryption key"
  depends_on   = [time_sleep.rbac]
}

resource "azurerm_key_vault_secret" "database_url" {
  name         = "database-url"
  value        = local.database_url
  key_vault_id = azurerm_key_vault.main.id
  content_type = "PostgreSQL connection string"
  depends_on   = [time_sleep.rbac]
}

resource "azurerm_key_vault_secret" "smtp_url" {
  count        = var.smtp_url != "" ? 1 : 0
  name         = "smtp-url"
  value        = var.smtp_url
  key_vault_id = azurerm_key_vault.main.id
  content_type = "SMTP connection string"
  depends_on   = [time_sleep.rbac]
}

# Reveal only whether a credential exists to Terraform's resource count. Keep
# credentials available for existing customers and webhooks when checkout is off.
locals {
  stripe_api_key_configured = nonsensitive(length(trimspace(var.stripe_secret_key)) > 0)
  stripe_webhook_configured = nonsensitive(length(trimspace(var.stripe_webhook_secret)) > 0)
}

resource "azurerm_key_vault_secret" "stripe_secret_key" {
  count        = local.stripe_api_key_configured ? 1 : 0
  name         = "stripe-secret-key"
  value        = var.stripe_secret_key
  key_vault_id = azurerm_key_vault.main.id
  content_type = "Stripe API secret key"
  depends_on   = [time_sleep.rbac]
}

resource "azurerm_key_vault_secret" "stripe_webhook_secret" {
  count        = local.stripe_webhook_configured ? 1 : 0
  name         = "stripe-webhook-secret"
  value        = var.stripe_webhook_secret
  key_vault_id = azurerm_key_vault.main.id
  content_type = "Stripe webhook signing secret"
  depends_on   = [time_sleep.rbac]
}
