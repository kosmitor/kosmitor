output "resource_group_name" {
  value = azurerm_resource_group.state.name
}

output "storage_account_name" {
  value = azurerm_storage_account.state.name
}

output "container_name" {
  value = azurerm_storage_container.state.name
}

output "backend_hcl" {
  description = "Every line a stack's backend.hcl needs but its key, which must be one no other stack uses. terraform output -raw backend_hcl > backend.hcl, then add key = \"<stack>.tfstate\"."
  value       = <<-EOT
    subscription_id      = "${var.subscription_id}"
    resource_group_name  = "${azurerm_resource_group.state.name}"
    storage_account_name = "${azurerm_storage_account.state.name}"
    container_name       = "${azurerm_storage_container.state.name}"
    use_azuread_auth     = true
  EOT
}
