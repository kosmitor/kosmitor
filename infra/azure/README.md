# Kosmitor on Azure

Terraform for running Kosmitor in production on Azure. Everything Kosmitor stores
lives in PostgreSQL, uploaded documents included, so durability is a database
question. This configuration answers it three ways:

| Layer | What it does | Where |
|---|---|---|
| Managed Postgres | Zone-redundant standby with automatic failover, point-in-time recovery (`postgres_backup_retention_days`, 35 days by default), geo-redundant backups in the paired region, private network only | `database.tf` |
| Independent copies | A nightly `pg_dump` uploaded by a scheduled job to a GZRS storage account in another region; versioned, immutable for `backup_retention_days` (90 by default), no shared keys | `storage.tf`, `app.tf` |
| Proof | A weekly job restores the fresh dump into a scratch database and compares row counts with production; a failure raises an alert | `apps/server/src/backup-upload.ts`, `alerts.tf` |

The application itself is stateless: one image serving the API and the web
app on Azure Container Apps, secrets from Key Vault through a managed identity,
alerts to your inbox.

```
Internet ──HTTPS──▶ Container Apps (<name>-<environment>) ──▶ Postgres Flexible Server (private subnet, HA)
                          │  identity                                │ PITR · geo backups
                          ├──▶ Key Vault (database-url, smtp-url)
                          └──▶ Container Registry (image)
   Jobs (same image): nightly backup ▶ Storage (other region, immutable)
                      weekly restore drill ▶ scratch DB ▶ row-count check
```

Most resource names follow `<kind>-<name>-<environment>`, from the `name` and
`environment` variables (`kosmitor` and `prod` by default): the resource group is
`rg-<name>-<environment>` (`terraform output resource_group` prints it) and the app
itself `<name>-<environment>`.

**Regions.** The original deployment keeps every region in the United States: the
application and database in Central US, the independent backup copies in West US 2,
and the managed geo-redundant database backups in East US 2 (the paired region).
Those are the defaults of `location` and `backup_location`, and a recommendation
rather than a rule; pick the regions that suit you. Central US was chosen because it
was one of the few US regions where that subscription was offered zone-redundant
PostgreSQL Flexible Server, and offers differ per subscription:
`az postgres flexible-server list-skus --location <region>` shows what yours can get.

## Deploy

Prerequisites: Terraform ≥ 1.4, Azure CLI signed in to the subscription you
deploy to (`az login`), Contributor plus User Access Administrator (or Owner) on
that subscription. No local Docker: the image is built by the registry.
A subscription that has never run Container Apps or Flexible Server needs its
resource providers registered once (a few minutes, harmless to repeat):

```bash
for ns in Microsoft.App Microsoft.DBforPostgreSQL Microsoft.KeyVault Microsoft.ContainerRegistry \
          Microsoft.Storage Microsoft.Network Microsoft.ManagedIdentity Microsoft.Insights \
          Microsoft.AlertsManagement Microsoft.OperationalInsights Microsoft.Communication; do
  az provider register --namespace $ns --wait
done
```

Copy `terraform.tfvars.example` to `terraform.tfvars` (ignored by git) and fill in
at least `subscription_id` and `alert_email`; every other variable is listed there
with its default. The Terraform state will hold the database password and the
app's other secrets, so keep it in Azure Storage from the start: apply
[`infra/tfstate`](../tfstate/README.md) once per subscription (it creates the
storage; `terraform output -raw backend_hcl` there prints the account details),
then copy `backend.tf.example` to `backend.tf` and `backend.hcl.example` to
`backend.hcl` with the subscription and the account filled in; `backend.tf.example`
also has the steps for moving a state that is already local. Operations, below,
says how that storage is protected.

```bash
cd infra/azure
cp terraform.tfvars.example terraform.tfvars                         # then edit it
az login --scope https://management.azure.com//.default
export TF_VAR_smtp_url='smtps://user:password@smtp.example.com:465'   # optional; leave unset to disable SMTP
terraform init -backend-config=backend.hcl                           # plain terraform init for local state
terraform validate
terraform plan -out tfplan
terraform apply tfplan
rm tfplan                                                            # a saved plan holds the whole state, secrets included
```

The first apply takes 20 to 30 minutes, most of it the HA database. It ends
with `app_url`; open it, sign in and create the first company.

## Settings

Two places hold settings, and they do not overlap:

- **The infrastructure** is `terraform.tfvars`: names, regions, sizes, the database
  tier, backup retention and schedules, alerts, the network ranges, domains and the
  email sender. `variables.tf` describes each variable; `terraform.tfvars.example`
  lists them all. Each default is the value the stack has always used, so leaving
  a variable out changes nothing on an existing deployment.
- **The application** reads `kosmitor.config.json` and, when present,
  `kosmitor.config.local.json` from the repository root; both are copied into the
  image, so put your branding, sign-in options, limits and the optional 409A
  valuation desk (`valuationDesk`) in `kosmitor.config.local.json` before building.
  Terraform sets only the values that depend on the deployment, as environment
  variables that win over the files: `APP_URL` and `ALLOWED_ORIGINS` (the app's
  address), `MAIL_FROM`, `GOOGLE_CLIENT_ID`, `GOOGLE_ALLOWED_DOMAINS`, `PG_POOL_MAX`
  (`pg_pool_max`), `TRUST_PROXY=true` (Container Apps ingress is a proxy, so the
  client address comes from `X-Forwarded-For`), and for the jobs `BACKUP_CONTAINER`,
  `BACKUP_PREFIX` (`name`) and, when `drill_database` is set, `DRILL_DATABASE`.
  [docs/configuration.md](../../docs/configuration.md) lists every application
  setting.

Choose `name`, `environment`, `location`, `backup_location`, `vnet_address_space`,
`apps_subnet_prefixes`, `postgres_subnet_prefixes` and `communication_data_location`
before the first apply: changing them later replaces resources, the database among
them, or is refused while the network is in use.

## Day two

- **New build**: bump `image_tag` in `terraform.tfvars` and apply. The image is
  rebuilt in the registry and the app rolls to it with zero downtime (single
  revision mode with health probes). `kosmitor.config.local.json` is part of the
  image, so a change to it also needs a new tag.
- **Custom domain**: create the DNS records at the registrar: for the bare
  domain an A record to the `static_ip` output, for `www` a CNAME to `app_fqdn`,
  and for each hostname a TXT record (`asuid` for the bare domain, `asuid.www`
  for the subdomain) holding the `custom_domain_verification_id` output. When
  they resolve, list the hostnames in `custom_hostnames` (`HTTP` check for the
  A record, `CNAME` for the CNAME) and apply: each is bound with a free managed
  certificate that Azure renews. Then set `custom_domain` to the canonical
  hostname and apply again so `APP_URL` (links in emails) and CORS use it; the
  Azure hostname keeps working alongside.
- **Email**: already working. Every apply provisions Azure Communication Services
  with a free Azure-managed domain, so invitations, password resets and signature
  requests are sent from the first deploy with nothing to configure and nothing to
  add to DNS. The `mail_from` output shows the address they come from.
  To send from your own domain instead, set `email_domain = "example.com"` and
  apply. The `email_dns_records` output then lists the TXT, SPF and DKIM entries
  to add at the registrar. Azure checks them only when asked: once they resolve,
  press Verify for Domain, SPF, DKIM and DKIM2 on the domain in the portal (or run
  `az communication email domain initiate-verification` for each type). When all
  four show verified, set `email_domain_verified = true` and apply again. The
  managed domain carries the mail until then, so nothing stops while DNS
  propagates. Only `DoNotReply` works as the sender name at first; another name
  needs the domain's sending limit raised through an Azure support ticket.
  Azure caps how much a
  managed domain may send, so a company sending to its whole register should move
  to its own domain. `TF_VAR_smtp_url` still works if you would rather use your
  own mail server; Communication Services takes precedence when both are set.
- **Google sign-in**: set `google_client_id` (and `google_allowed_domains`).
- **409A valuation desk**: `valuation_desk_emails` lists the evaluators each request
  goes to, up to 10. Each gets an email of its own with the same private request
  link, so none sees the others' addresses, and the closing notice and a resend with
  a new link reach all of them; replies to the recap and status emails reach the
  first. It is passed as `VALUATION_DESK_EMAIL`, comma separated, which wins over
  `valuationDesk.email` in the param file, so changing it is an apply (a new
  revision), not a new image. More than one address needs an image newer than v21,
  which refuses a list and stops at start; the plan stops first while `image_tag`
  is v21 or older. Removing an address does not take back the request links it was
  already sent: each works until the company sends that request to the team again
  with a new link, or until it expires (docs/valuation-desk.md, *Changing the list*).
- **Costs** (Central US, list prices): the HA database is the bulk, roughly
  the price of two D2ds_v5 instances plus storage; Container Apps with one
  always-on replica, the Basic registry, Log Analytics and cool storage add a
  modest amount on top. `postgres_high_availability = false` halves the
  database cost for a staging copy.

## Rebuilding from scratch

Tearing the stack down and applying it again is the fastest way out of a half-finished
apply or destroy, and it is not free:

- **The database and its point-in-time backups go with it.** Take a dump first if the
  data matters (`Recovering data` below), because after the delete there is nothing to
  restore from.
- **The app gets a new address.** A new environment means a new default hostname and a
  new static IP, so the registrar's A and CNAME records, the `asuid` TXT records, the
  bound hostnames and the authorised origin in the Google console all have to be
  pointed at the new values.
- Resource names carry a random suffix, so the registry, vault, database and storage
  account all come back under new names. The old Key Vault stays soft-deleted for 90
  days (purge protection); it costs nothing and does not block the new one.

`./rebuild.sh` does all of this, asking you to type the resource group's name before
it deletes anything. It takes the group from `terraform output resource_group`; pass
the name (`./rebuild.sh rg-<name>-<environment>`) when the state no longer knows it.
Remote state is not affected: its storage account lives in a resource group of its
own, which neither the script nor the commands below touch. By hand:

```bash
cd infra/azure
rg=$(terraform output -raw resource_group)                   # rg-<name>-<environment>
az group delete -n "$rg" --yes                               # ~10 min
az group show -n "$rg-cae-infra" >/dev/null 2>&1 \
  && az group delete -n "$rg-cae-infra" --yes                # only if Azure left it behind
rm -f terraform.tfstate terraform.tfstate.backup             # local state
terraform state list | tr '\n' '\0' | xargs -0 -r terraform state rm   # remote state, instead of the line above
```

Wait until `az group list -o table` shows neither group: a new environment cannot take
the name of an infrastructure resource group that still exists. Then empty
`custom_hostnames` in `terraform.tfvars` (the new address is not in DNS yet) and apply:

```bash
terraform init -upgrade                                      # remote state: add -backend-config=backend.hcl
terraform apply
```

Point the registrar at the new `static_ip`, `app_fqdn` and `custom_domain_verification_id`
outputs, wait for the records to resolve, put the hostnames back in `custom_hostnames`
and apply again. Set `custom_domain` last, once the hostname answers.

## Recovering data

`rg` below is `$(terraform output -raw resource_group)`; the other names come from
the outputs too.

- **Undo a bad change (minutes to `postgres_backup_retention_days` back)**: restore
  the server to a point in time; Azure creates a new server from the backups,
  nothing is overwritten:
  `az postgres flexible-server restore -g "$rg" -n psql-<name>-<environment>-recovered --source-server <postgres_server> --restore-time "2026-01-15T09:30:00Z"`.
  Then point `database-url` in Key Vault at it and restart the app.
- **Regional disaster**: `az postgres flexible-server geo-restore` in the paired
  region from the geo-redundant backup, same follow-up.
- **Everything else failed**: download the latest dump from the backup
  container (Storage Blob Data Reader is enough) and
  `pg_restore --clean --if-exists -d <url> <name>-<stamp>.dump` into any Postgres 17.
  The weekly drill proves this path works.

## Operations

- Alerts (action group `ag-<name>-<environment>`): database down, storage and CPU
  over `alerts.postgres_storage.percent` and `alerts.postgres_cpu.percent` (85% by
  default), a 5xx spike (more than `alerts.app_5xx.requests`, 25 by default, in the
  window), failed backup or drill job. `alerts` in `terraform.tfvars` changes the
  thresholds and how often each rule looks.
- Schedules: the backup runs at `backup_job.schedule` (02:00 UTC daily by default)
  and the drill at `restore_drill_job.schedule` (04:00 UTC on Sundays).
- Logs: Log Analytics workspace `log-<name>-<environment>`, kept for
  `log_retention_days` (`ContainerAppConsoleLogs_CL` for the app and jobs,
  `AzureDiagnostics` for Postgres).
- Run a backup by hand: `az containerapp job start -g "$rg" -n <name>-<environment>-backup`.
- State: `terraform.tfstate` holds the app's secrets in clear (the database password,
  the secret key, the email service's connection string, and `smtp_url` when set) and
  is the only record of what the stack owns, so keep it in Azure Storage rather than
  on a laptop. The stack in `infra/tfstate` creates that storage, with a state and a
  resource group of its own (`rg-terraform-state` in East US 2 unless its
  `resource_group_name` and `location` say otherwise; its `variables.tf` lists every
  setting), out of `rebuild.sh`'s reach: a GZRS account with one `tfstate` container
  that every stack shares under its own key. Only Entra ID sign-in works on it:
  account keys, and the SAS they sign, are disabled, and Terraform reaches the blob as
  you (`use_azuread_auth`) through the Storage Blob Data Contributor role that stack
  grants on the container to each object id in its `state_writer_object_ids`. It takes
  HTTPS with TLS 1.2 or later only, allows no public access and encrypts twice at rest
  (infrastructure encryption). Versioning keeps each earlier state, a deleted one
  included, for 90 days after it was written (`version_retention_days` there), and
  soft delete keeps whatever is deleted, a version or the container, for 30 days more
  (`soft_delete_days`). Old versions keep the secrets they held, which is why they do
  not stay for ever. A delete lock on the group refuses `az group delete` until
  someone removes the lock, and `prevent_destroy` stops a `terraform destroy` in
  `infra/tfstate` at the plan. Giving someone access, or taking it away, is a change
  to `state_writer_object_ids`; the Operations section of `infra/tfstate/README.md`
  has the steps, the lock's part in them included. `backend.tf.example` has the
  migration steps and `backend.hcl.example` the settings.
- Local copies of the state: the migration empties `terraform.tfstate` and leaves the
  old state, secrets included, in `terraform.tfstate.backup`. Once
  `terraform state list` lists what it did before and `terraform plan` reports what it
  did before, delete both. A saved plan (`terraform plan -out`) holds the whole state,
  remote backend or not, so delete it once applied. When an apply cannot save its state
  to the backend, Terraform writes it to `errored.tfstate` here: push it with
  `terraform state push errored.tfstate`, then delete the file.
- A terraform killed mid-run leaves the remote state locked (an Azure blob lease does
  not expire), and every later plan or apply fails with
  `Error acquiring the state lock`. When no other terraform is running, release it with
  `terraform force-unlock <ID>`, the ID being the one in that error, or with
  `az storage blob lease break --account-name <account> -c tfstate -b <key> --auth-mode login`.
  `rebuild.sh` checks for a held lock before it deletes anything.
- To bring back an earlier state, list its versions with
  `az storage blob list --account-name <account> -c tfstate --prefix <key> --include v --auth-mode login --query "[].[versionId, properties.lastModified]" -o tsv`,
  download one with
  `az storage blob download --account-name <account> -c tfstate -n <key> --version-id <id> -f old.tfstate --auth-mode login`
  and `terraform state push -force old.tfstate` (`-force` because its serial is older
  than the current one's). Each lock and unlock also makes a version, so neighbouring
  versions often hold the same state. Run `terraform plan` before anything else, then
  delete `old.tfstate`: it holds the same secrets.
- `protect_database = true` locks the database server so no portal click or
  `az group delete` can remove it. Set it back to false and apply before a deliberate
  teardown, otherwise the lock blocks it.
- Lock the immutability policy (`locked = true`) once the retention period is
  settled. Locked policies cannot be shortened by anyone, which is the point.
