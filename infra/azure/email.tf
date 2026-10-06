# Outgoing mail through Azure Communication Services.
#
# The application sends invitations, password resets, signature requests and
# investor updates. Without a sender those flows fall back to showing links on
# screen, which works for one person on a laptop and not for a company.
#
# Two ways to have a sender, and this provisions the first and offers the second:
#
#   Azure managed domain. Free, ready the moment it is created, and the sender
#   looks like DoNotReply@<guid>.azurecomm.net. Nothing to add to DNS. Azure caps
#   what it will send from one, so it suits a small team and not a mailing list.
#
#   Your own domain. Set email_domain to something like example.com, apply, and
#   the email_dns_records output lists the TXT, SPF and DKIM entries to add at the
#   registrar. Azure checks each record only when asked: press Verify for Domain,
#   SPF, DKIM and DKIM2 on the domain in the portal, or run
#   az communication email domain initiate-verification once per type. Until all
#   four pass, the managed domain keeps working, so mail never stops meanwhile.
#
# Its data stays in communication_data_location: the United States by default,
# like the default regions.

resource "azurerm_communication_service" "main" {
  name                = "acs-${local.prefix}"
  resource_group_name = azurerm_resource_group.main.name
  data_location       = var.communication_data_location
  tags                = local.tags
}

resource "azurerm_email_communication_service" "main" {
  name                = "email-${local.prefix}"
  resource_group_name = azurerm_resource_group.main.name
  data_location       = var.communication_data_location
  tags                = local.tags
}

# Always present, so there is a working sender from the first apply.
resource "azurerm_email_communication_service_domain" "managed" {
  name              = "AzureManagedDomain"
  email_service_id  = azurerm_email_communication_service.main.id
  domain_management = "AzureManaged"
  tags              = local.tags
}

resource "azurerm_communication_service_email_domain_association" "managed" {
  communication_service_id = azurerm_communication_service.main.id
  email_service_domain_id  = azurerm_email_communication_service_domain.managed.id
}

# Your own domain, once you want mail to come from it rather than from Azure.
resource "azurerm_email_communication_service_domain" "custom" {
  count             = var.email_domain != "" ? 1 : 0
  name              = var.email_domain
  email_service_id  = azurerm_email_communication_service.main.id
  domain_management = "CustomerManaged"
  tags              = local.tags
}

# Associating an unverified domain fails, so this waits for the DNS records in the
# email_dns_records output to be added and verified. Until then, leave
# email_domain_verified false and the managed domain carries the mail.
resource "azurerm_communication_service_email_domain_association" "custom" {
  count                    = var.email_domain != "" && var.email_domain_verified ? 1 : 0
  communication_service_id = azurerm_communication_service.main.id
  email_service_domain_id  = azurerm_email_communication_service_domain.custom[0].id
}

locals {
  # The address mail comes from. Azure's managed domain answers on DoNotReply only;
  # a domain of your own takes whatever local part you choose.
  mail_sender = (var.email_domain != "" && var.email_domain_verified
    ? "${var.email_sender_local_part}@${var.email_domain}"
  : "DoNotReply@${azurerm_email_communication_service_domain.managed.from_sender_domain}")
  mail_from = var.mail_from != "" ? var.mail_from : "${var.mail_display_name} <${local.mail_sender}>"
}

# The key that lets the application send. It reaches the container the same way the
# database password does: a vault secret read through the managed identity.
resource "azurerm_key_vault_secret" "acs_connection" {
  name         = "acs-connection-string"
  value        = azurerm_communication_service.main.primary_connection_string
  key_vault_id = azurerm_key_vault.main.id
  content_type = "Azure Communication Services connection string"
  depends_on   = [time_sleep.rbac]
}
