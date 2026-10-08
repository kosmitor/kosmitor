# Terraform state storage

Terraform for the Azure Storage container that holds every stack's Terraform
state, `infra/azure`'s among them. A state file holds secrets in clear
(`infra/azure`'s holds the database password, the app's secret key and the email
service's connection string) and is the only record of what a stack owns, so it
does not belong on a laptop, and it must outlive the stacks it describes.

One subscription needs this once. Every stack then keeps its state in the same
container, each under a key of its own.

| What | Settings | Why |
|---|---|---|
| Resource group `rg-terraform-state` (East US 2) | Holds nothing else; tag `purpose = terraform-state` | No other stack's teardown reaches it |
| Storage account (`tfstate` and 12 random hex characters) | StorageV2, Standard GZRS, account keys, the SAS they sign and local users disabled, portal defaults to Entra ID, HTTPS with TLS 1.2 or later, no public blob access, no cross-tenant replication, infrastructure encryption | Three zones plus a copy in the paired region; only an Entra ID identity can read or write a state; encrypted twice at rest |
| Blob service | Versioning, 30 days of blob and container soft delete | Every write keeps the previous state as a version, a deleted state included; whatever is deleted stays restorable |
| Lifecycle rule `expire-old-state-versions` | Earlier versions deleted 90 days after they were written | Each version is a whole state with the secrets it held, and two more are written on every locked command, so they do not stay for ever |
| Container `tfstate` | Private, created through Azure Resource Manager | Needs no data-plane role and no key |
| Storage Blob Data Contributor on the container | For each object id in `state_writer_object_ids` | What `terraform init`, `plan` and `apply` need with `use_azuread_auth`; Contributor or Owner on the subscription does not include blob data |
| Lock `terraform-state` on the group | CanNotDelete | `az group delete` or a portal click on the group, the account or the container fails until someone removes the lock on purpose |

The group, the account and the container also carry `prevent_destroy`, so a
`terraform destroy` here, or a change that would replace one of them, stops at
the plan. The lock does not: Operations lifts it and an apply puts it back, and a
change to its name or notes replaces it. `variables.tf` describes every setting
and `terraform.tfvars.example` lists them with their defaults.

**Why a stack of its own.** `infra/azure` is built to be torn down:
`rebuild.sh` deletes its resource group and applies again, and a
`terraform destroy` there removes everything it owns. If the state storage were
part of it, the first rebuild would take the state with it, the state that says
what to rebuild. Here it has its own directory, its own state and its own
resource group, and nothing in `infra/azure` refers to it except the
`backend.hcl` that names it.

**Who gets access** is the list in `state_writer_object_ids`, not whoever runs
apply: the old script granted the role to the signed-in identity, so a
colleague running it again would have added theirs, and a Terraform stack keyed
on the caller would swap the owner's access for theirs on every apply. Every
writer can read every stack's state, `infra/azure`'s secrets included, and can
hand any of it out as a user-delegation SAS (signed with Entra ID, valid up to
seven days), so list only identities trusted with production.

**Regions.** The original deployment keeps every resource in the United States,
and GZRS needs availability zones, so the stack accepts the US regions that have
them: `centralus`, `eastus`, `eastus2`, `southcentralus`, `westus2` and
`westus3`. Any other `location` is refused at plan time unless
`allow_non_us = true`: the account cannot move once it exists, so a mistyped or
copied region is caught before anything is created.

## First-time setup

Prerequisites: Terraform ≥ 1.4, the Azure CLI signed in to the subscription
(`az login`), and Contributor plus User Access Administrator (or Owner) on it: the
role assignment and the lock are authorization writes. Before choosing a region
the stack does not list, with `allow_non_us`, check that it offers GZRS to the
subscription; this lists the regions that do:

```bash
az rest --method get \
  --url "/subscriptions/<subscription-id>/providers/Microsoft.Storage/skus?api-version=2023-05-01" \
  --query "value[?name=='Standard_GZRS' && kind=='StorageV2' && !(restrictions[?type=='Location'])].locations[]" -o tsv
```

Copy `terraform.tfvars.example` to `terraform.tfvars` (ignored by git) and fill
in `subscription_id` and `state_writer_object_ids` (yours is
`az ad signed-in-user show --query id -o tsv`). The first apply keeps this
stack's state in a local file, since the container it would go into does not
exist yet:

```bash
cd infra/tfstate
cp terraform.tfvars.example terraform.tfvars          # then edit it
az login --scope https://management.azure.com//.default
terraform init
terraform plan -out tfplan
terraform apply tfplan
rm tfplan                                             # a saved plan holds the whole state
```

If the apply fails at the storage account, the resource group exists already,
without its lock, which is created last. Apply again once the cause is fixed. To
start over in another region instead, which would replace the group and is
refused by `prevent_destroy`, take the group out of the state and delete it,
then change `location` and plan again:

```bash
terraform state rm azurerm_resource_group.state
az group delete -n rg-terraform-state                 # or your resource_group_name
```

Once the apply has succeeded, move this stack's own state into the container it
created, under the key `tfstate.tfstate`, and delete the local copies:

```bash
terraform state list > state-before.txt
terraform output -raw backend_hcl > backend.hcl
echo 'key                  = "tfstate.tfstate"' >> backend.hcl
cp backend.tf.example backend.tf                      # after the output: from here on, commands want init first
terraform init -backend-config=backend.hcl -migrate-state
terraform state list | diff state-before.txt -        # prints nothing
terraform plan                                        # No changes.
rm terraform.tfstate terraform.tfstate.backup state-before.txt
```

Answer the migration's question yes only when it says no existing state was
found in the new backend. If it says a state already exists there, the key is
another stack's: press Ctrl-C (yes would overwrite that state, no would take it
over in place of this one's) and choose another key. A new role takes a few
minutes to reach the blob service, and until it has, init fails with 403
(`AuthorizationPermissionMismatch`); run it again. The migration empties
`terraform.tfstate` and leaves the old state in `terraform.tfstate.backup`, which
is why both go once the checks pass. This state holds the account's access keys:
useless while keys are disabled, live the moment someone turns them back on.
From then on, pass `-backend-config=backend.hcl` to every `terraform init`. On
another machine or in a fresh checkout, which has none of the files git ignores,
copy `backend.tf.example` to `backend.tf`, `backend.hcl.example` to `backend.hcl`
with the subscription and the account filled in, and the same `terraform.tfvars`
as before, then `terraform init -backend-config=backend.hcl`. A plan that would
create the storage account means the backend is not set up: stop there.

**Other stacks.** A stack keeps its state here with a `backend.tf` holding the
empty block `terraform { backend "azurerm" {} }` (`infra/azure/backend.tf.example`
is one) and a `backend.hcl`. `terraform output -raw backend_hcl` prints every line
that file needs but its key, which must be one no other stack uses:
`kosmitor-prod.tfstate` for `infra/azure` with the default name and environment,
`tfstate.tfstate` for this one. `infra/azure/backend.tf.example` has the
migration steps; the same rules hold there: yes only when no state exists at the
key, then delete `terraform.tfstate`, `terraform.tfstate.backup` and any saved
plan file, each of which holds that stack's secrets.

Terraform's azurerm backend does not take an `az login` as a service principal.
For CI, add the service principal's object id to `state_writer_object_ids`
(`az ad sp show --id <app-id> --query id -o tsv`, not the app registration's
object id) and give terraform the principal itself: `ARM_CLIENT_ID`,
`ARM_TENANT_ID` and `ARM_CLIENT_SECRET` (or `ARM_USE_OIDC=true`) in the
environment.

## Adopting existing storage

Before this stack, an Azure CLI script, `state-storage.sh`, created the same
storage; it was never published and has since been removed. To bring storage it
made under Terraform, import its six resources into this stack's state before
the first apply; an apply without them stops at the first one, which already
exists. With no `backend.tf` here yet, the imports go into a local state. First
the ids, with the subscription and the account filled in
(`az storage account list -g rg-terraform-state --query "[].name" -o tsv` names
the account):

```bash
cd infra/tfstate
sub=<subscription-id>
account=<storage-account-name>
rg=/subscriptions/$sub/resourceGroups/rg-terraform-state
acct=$rg/providers/Microsoft.Storage/storageAccounts/$account
container=$acct/blobServices/default/containers/tfstate
az role assignment list --scope "$container" --role "Storage Blob Data Contributor" --query "[].principalId" -o tsv
```

The last line lists who holds the role today: the script granted it to whoever
ran it. Copy `terraform.tfvars.example` to `terraform.tfvars` and set
`subscription_id`, `storage_account_name` to the account, and
`state_writer_object_ids` to those object ids, in lowercase. Keep `location`,
`resource_group_name` and `container_name` as they are unless the script ran with
other values. Then, in the same shell:

```bash
terraform init
writer=<object-id>     # one entry of state_writer_object_ids; yours: az ad signed-in-user show --query id -o tsv
assignment=$(az role assignment list --scope "$container" --role "Storage Blob Data Contributor" \
  --query "[?principalId=='$writer'].id" -o tsv)

terraform import azurerm_resource_group.state "$rg"
terraform import azurerm_storage_account.state "$acct"
terraform import azurerm_storage_management_policy.state "$acct/managementPolicies/default"
terraform import azurerm_storage_container.state "$container"
terraform import "azurerm_role_assignment.state_writer[\"$writer\"]" "$assignment"
terraform import azurerm_management_lock.state "$rg/providers/Microsoft.Authorization/locks/terraform-state"
terraform plan
```

Run the `writer`, `assignment` and role assignment import lines once for each
entry of `state_writer_object_ids`. Spelled out, the addresses and ids are:

| Address | Import id |
|---|---|
| `azurerm_resource_group.state` | `/subscriptions/<subscription-id>/resourceGroups/rg-terraform-state` |
| `azurerm_storage_account.state` | `/subscriptions/<subscription-id>/resourceGroups/rg-terraform-state/providers/Microsoft.Storage/storageAccounts/<storage-account-name>` |
| `azurerm_storage_management_policy.state` | `/subscriptions/<subscription-id>/resourceGroups/rg-terraform-state/providers/Microsoft.Storage/storageAccounts/<storage-account-name>/managementPolicies/default` |
| `azurerm_storage_container.state` | `/subscriptions/<subscription-id>/resourceGroups/rg-terraform-state/providers/Microsoft.Storage/storageAccounts/<storage-account-name>/blobServices/default/containers/tfstate` |
| `azurerm_role_assignment.state_writer["<object-id>"]` | the container's id followed by `/providers/Microsoft.Authorization/roleAssignments/<assignment-guid>` |
| `azurerm_management_lock.state` | `/subscriptions/<subscription-id>/resourceGroups/rg-terraform-state/providers/Microsoft.Authorization/locks/terraform-state` |

The plan should read `Plan: 0 to add, 2 to change, 0 to destroy.`, both in
place: the tag `managed_by = "terraform"` added to the group, and on the account
the same tag and `local_user_enabled` turned from true to false (the script left
local users at Azure's default; SFTP is off, so none could sign in). Anything
else means the storage differs from this configuration. A replacement
(`must be replaced`) is refused by `prevent_destroy`: set the variable it comes
from to what Azure has. A role assignment to be created is an entry of
`state_writer_object_ids` whose assignment was not imported. An assignment the
script made for someone left out of the list stays in Azure, outside Terraform:
add them to the list and import it, or remove it by hand (see Operations for the
lock). Once the plan shows only those changes, `terraform apply`, then move this
stack's state into the container as in First-time setup.

## Why this stack's state lives in the container it manages

This state is worth protecting: it holds the account's access keys, and it is the
only record that these resources belong to Terraform. In the container it gets
what every other state gets: Entra ID sign-in only, versioning, soft delete, three
zones and a paired region, and the delete lock. A local file would have none of
that and sit on one laptop; a second account to hold it would need a state of its
own, and so on.

Keeping it there is circular only if the account itself is lost, and then
everything this state describes is gone with it anyway. By what was lost:

- **This state, overwritten or deleted.** Bring back an earlier version, as
  `infra/azure/README.md`, Operations, describes with the key `tfstate.tfstate`
  (`az storage blob list ... --include v`, `az storage blob download ... --version-id`,
  `terraform state push -force`). A deleted blob stays restorable for
  `soft_delete_days`.
- **This state, with no usable version.** The resources are still there, so
  rebuild the state from them: `terraform init -backend-config=backend.hcl` gives
  an empty state at the same key, and the imports in Adopting existing storage
  fill it, `storage_account_name` set to the account's name.
- **A regional outage.** GZRS keeps a copy in the paired region. Microsoft may
  fail over in a major disaster; `az storage account failover -n <account>` makes
  the copy primary without waiting. The last minutes of writes may be lost, and
  the account is locally redundant afterwards until converted back to GZRS.
- **The account deleted.** The lock and `prevent_destroy` exist so this takes
  intent. Every stack's state goes with it. Azure can sometimes restore a deleted
  storage account with what it held, within 14 days and without guarantee
  (Storage accounts in the portal, then Restore), provided its resource group
  still exists and nobody has taken the name; then `terraform plan` here should
  show no changes. Otherwise build the storage again, starting from a local
  state, since the backend this stack names is gone:

  ```bash
  rm -f backend.tf
  terraform init -reconfigure                         # an empty local state
  ```

  If the resource group survived, import it, and its lock if that is still
  there, with the ids in Adopting existing storage. Set `storage_account_name` to
  the old name to take it again once Azure has released it, or leave it unset for
  a new one. Apply (a role assignment reported as existing is one Azure kept from
  the old account: import it), and move this state into the new container as in
  First-time setup. Then, in every other stack, put the account in `backend.hcl`
  (`terraform output -raw backend_hcl` here), run
  `terraform init -backend-config=backend.hcl -reconfigure`, and rebuild its
  state by importing its resources.

## Operations

- **Adding a writer**: append the object id to `state_writer_object_ids` and
  apply. The role takes a few minutes to reach the blob service.
- **Removing a writer**: the delete lock refuses removing a role assignment
  inside the group. Take the id out of the list, lift the lock, remove that one
  assignment, then apply again to put the lock back:

  ```bash
  az lock delete -n terraform-state -g rg-terraform-state      # or your resource_group_name
  terraform apply -target='azurerm_role_assignment.state_writer["<object-id, lowercase>"]'
  terraform apply
  ```

  A plain apply in place of the second line could put the lock back before the
  role is removed, and fail. The address takes the id in lowercase, as
  `terraform state list` shows it.
- **Retention**: change `version_retention_days` or `soft_delete_days` and apply.
  The account has one lifecycle policy, so a rule added by hand in the portal is
  removed by the next apply; add it to `main.tf` instead.
- **Drift**: a setting changed by hand in the portal shows in the next
  `terraform plan`, and the apply after it puts it back.
- **Retiring the storage**, on purpose: move every stack's state elsewhere,
  including this one's (delete `backend.tf`, then
  `terraform init -migrate-state`), remove `prevent_destroy` from `main.tf`,
  `az lock delete -n terraform-state -g rg-terraform-state`, then
  `terraform destroy`. Then delete `terraform.tfstate`,
  `terraform.tfstate.backup` and `backend.hcl`: the local state held the
  account's access keys.
