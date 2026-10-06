# Alerts on the failures that cost data or availability, emailed to the operator.
# Thresholds and windows are var.alerts.

locals {
  # Azure Monitor's evaluation periods, as the alert descriptions say them.
  alert_period_words = {
    PT1M  = "a minute"
    PT5M  = "five minutes"
    PT15M = "fifteen minutes"
    PT30M = "thirty minutes"
    PT1H  = "an hour"
    PT6H  = "six hours"
    PT12H = "twelve hours"
    P1D   = "a day"
  }
}

resource "azurerm_monitor_action_group" "ops" {
  name                = "ag-${local.prefix}"
  resource_group_name = azurerm_resource_group.main.name
  short_name          = substr("${var.name}ops", 0, 12)
  tags                = local.tags

  email_receiver {
    name                    = "operator"
    email_address           = var.alert_email
    use_common_alert_schema = true
  }
}

resource "azurerm_monitor_metric_alert" "postgres_down" {
  name                = "alert-${local.prefix}-postgres-down"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_postgresql_flexible_server.main.id]
  description         = "The database has stopped answering."
  severity            = 0
  frequency           = var.alerts.postgres_down.frequency
  window_size         = var.alerts.postgres_down.window
  tags                = local.tags

  criteria {
    metric_namespace = "Microsoft.DBforPostgreSQL/flexibleServers"
    metric_name      = "is_db_alive"
    aggregation      = "Maximum"
    operator         = "LessThan"
    threshold        = 1
  }

  action {
    action_group_id = azurerm_monitor_action_group.ops.id
  }
}

resource "azurerm_monitor_metric_alert" "postgres_storage" {
  name                = "alert-${local.prefix}-postgres-storage"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_postgresql_flexible_server.main.id]
  description         = "Database storage is over ${var.alerts.postgres_storage.percent}% full."
  severity            = 2
  frequency           = var.alerts.postgres_storage.frequency
  window_size         = var.alerts.postgres_storage.window
  tags                = local.tags

  criteria {
    metric_namespace = "Microsoft.DBforPostgreSQL/flexibleServers"
    metric_name      = "storage_percent"
    aggregation      = "Average"
    operator         = "GreaterThan"
    threshold        = var.alerts.postgres_storage.percent
  }

  action {
    action_group_id = azurerm_monitor_action_group.ops.id
  }
}

resource "azurerm_monitor_metric_alert" "postgres_cpu" {
  name                = "alert-${local.prefix}-postgres-cpu"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_postgresql_flexible_server.main.id]
  description         = "Database CPU has been over ${var.alerts.postgres_cpu.percent}% for ${lookup(local.alert_period_words, var.alerts.postgres_cpu.window, var.alerts.postgres_cpu.window)}."
  severity            = 3
  frequency           = var.alerts.postgres_cpu.frequency
  window_size         = var.alerts.postgres_cpu.window
  tags                = local.tags

  criteria {
    metric_namespace = "Microsoft.DBforPostgreSQL/flexibleServers"
    metric_name      = "cpu_percent"
    aggregation      = "Average"
    operator         = "GreaterThan"
    threshold        = var.alerts.postgres_cpu.percent
  }

  action {
    action_group_id = azurerm_monitor_action_group.ops.id
  }
}

resource "azurerm_monitor_metric_alert" "app_errors" {
  name                = "alert-${local.prefix}-app-5xx"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [azurerm_container_app.main.id]
  description         = "The application is returning server errors."
  severity            = 1
  frequency           = var.alerts.app_5xx.frequency
  window_size         = var.alerts.app_5xx.window
  tags                = local.tags

  criteria {
    metric_namespace = "Microsoft.App/containerApps"
    metric_name      = "Requests"
    aggregation      = "Total"
    operator         = "GreaterThan"
    threshold        = var.alerts.app_5xx.requests

    dimension {
      name     = "statusCodeCategory"
      operator = "Include"
      values   = ["5xx"]
    }
  }

  action {
    action_group_id = azurerm_monitor_action_group.ops.id
  }
}

resource "azurerm_monitor_metric_alert" "backup_failed" {
  for_each = {
    backup        = azurerm_container_app_job.backup.id
    restore-drill = azurerm_container_app_job.restore_drill.id
  }

  name                = "alert-${local.prefix}-${each.key}-failed"
  resource_group_name = azurerm_resource_group.main.name
  scopes              = [each.value]
  description         = "A scheduled ${each.key} job execution failed."
  severity            = 1
  frequency           = var.alerts.job_failed.frequency
  window_size         = var.alerts.job_failed.window
  tags                = local.tags

  criteria {
    metric_namespace = "Microsoft.App/jobs"
    metric_name      = "Executions"
    aggregation      = "Total"
    operator         = "GreaterThan"
    threshold        = 0

    dimension {
      name     = "state"
      operator = "Include"
      values   = ["Failed"]
    }
  }

  action {
    action_group_id = azurerm_monitor_action_group.ops.id
  }
}
