output "app_url" {
  description = "Where the application answers."
  value       = local.app_url
}

output "app_fqdn" {
  description = "The Container Apps hostname; a subdomain's CNAME record points here."
  value       = local.app_fqdn
}

output "static_ip" {
  description = "Public address of the environment; a bare domain's A record points here."
  value       = azurerm_container_app_environment.main.static_ip_address
}

output "custom_domain_verification_id" {
  description = "Value of the TXT record that proves ownership of a custom hostname: asuid for the bare domain, asuid.<sub> for a subdomain."
  value       = azurerm_container_app_environment.main.custom_domain_verification_id
}

output "resource_group" {
  value = azurerm_resource_group.main.name
}

output "container_registry" {
  description = "Registry the image is built into (az acr build --registry ...)."
  value       = azurerm_container_registry.main.name
}

output "image" {
  value = local.image
}

output "postgres_server" {
  value = azurerm_postgresql_flexible_server.main.name
}

output "postgres_fqdn" {
  value = azurerm_postgresql_flexible_server.main.fqdn
}

output "key_vault" {
  description = "Holds database-url and, when set, smtp-url."
  value       = azurerm_key_vault.main.name
}

output "backup_storage_account" {
  value = azurerm_storage_account.backups.name
}

output "backup_container_url" {
  value = "${trimsuffix(azurerm_storage_account.backups.primary_blob_endpoint, "/")}/${azurerm_storage_container.backups.name}"
}

output "log_analytics_workspace" {
  value = azurerm_log_analytics_workspace.main.name
}

output "mail_from" {
  description = "The sender the application uses for outgoing mail."
  value       = local.mail_from
}

output "email_dns_records" {
  description = "Records to add at the registrar when email_domain is set. Once they resolve and Azure reports the domain verified, set email_domain_verified = true and apply again."
  value       = var.email_domain != "" ? azurerm_email_communication_service_domain.custom[0].verification_records : null
}
