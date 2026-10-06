# Custom hostnames with free managed certificates.
#
# The Azure provider can add a hostname (azurerm_container_app_custom_domain)
# and issue a managed certificate (azurerm_container_app_environment_managed_certificate)
# as resources, but it cannot attach that certificate to the hostname: the
# provider documents doing that last step in the portal or CLI and ignoring the
# resulting drift. `az containerapp hostname bind` performs all three steps and
# waits for the certificate, so it is wrapped here the same way the image build
# is. The hostname and its validation method live in state, and a change to
# either re-runs the bind; removing a hostname from the map removes it from the
# app.
#
# DNS must answer before this applies, or the bind fails and the apply stops:
#   bare domain   A      -> static_ip output                    validation "HTTP"
#   subdomain     CNAME  -> app_fqdn output                     validation "CNAME"
#   every host    TXT    asuid (apex) / asuid.<sub> -> custom_domain_verification_id output
# Fix the records and apply again; a repeated bind reuses the existing certificate.

resource "terraform_data" "hostname" {
  for_each = var.custom_hostnames

  triggers_replace = [each.key, each.value, azurerm_container_app.main.id]

  # Kept in state so the destroy-time command knows which hostname to remove.
  input = {
    hostname       = each.key
    subscription   = var.subscription_id
    resource_group = azurerm_resource_group.main.name
    app            = azurerm_container_app.main.name
    environment    = azurerm_container_app_environment.main.name
  }

  # Azure refuses to issue a managed certificate for a hostname the app does not
  # have yet (RequireCustomHostnameInEnvironment), and `hostname bind` alone
  # asks for the certificate first. So: add the hostname when missing, then bind.
  provisioner "local-exec" {
    command = <<-EOT
      set -e
      # Hostnames are added by rewriting the app's ingress, and Azure rejects two such writes
      # at once, so binds for different hostnames take turns (a stale lock older than 30 min is dropped).
      lock="/tmp/${azurerm_container_app.main.name}-hostname.lock"
      find "$lock" -maxdepth 0 -mmin +30 -exec rmdir {} \; 2>/dev/null || true
      until mkdir "$lock" 2>/dev/null; do sleep 5; done
      trap 'rmdir "$lock"' EXIT
      app="--subscription ${var.subscription_id} --resource-group ${azurerm_resource_group.main.name} --name ${azurerm_container_app.main.name}"
      if [ "$(az containerapp hostname list $app --query "length([?name=='${each.key}'])" -o tsv)" = "0" ]; then
        az containerapp hostname add $app --hostname ${each.key}
      fi
      az containerapp hostname bind $app --environment ${azurerm_container_app_environment.main.name} --hostname ${each.key} --validation-method ${each.value}
    EOT
  }

  # Removing the hostname leaves its managed certificate behind, and a certificate
  # still in the environment blocks the environment's own deletion, so both go.
  provisioner "local-exec" {
    when       = destroy
    on_failure = continue # a bind that failed half-way may have left nothing to remove
    command    = <<-EOT
      sub="--subscription ${self.input.subscription}"
      az containerapp hostname delete $sub --resource-group ${self.input.resource_group} --name ${self.input.app} --hostname ${self.input.hostname} --yes || true
      for cert in $(az containerapp env certificate list $sub --resource-group ${self.input.resource_group} --name ${self.input.environment} --managed-certificates-only --query "[?properties.subjectName=='${self.input.hostname}'].name" -o tsv); do
        az containerapp env certificate delete $sub --resource-group ${self.input.resource_group} --name ${self.input.environment} --certificate "$cert" --yes || true
      done
    EOT
  }
}
