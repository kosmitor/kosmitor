#!/usr/bin/env bash
# Delete the whole stack and build it again from this configuration.
#
# Use it when an apply or destroy stopped half-way and left resources Terraform
# can no longer reconcile. It is not a repair: everything goes, including the
# database and every backup taken of it, and the application comes back at a new
# address. README.md, "Rebuilding from scratch", lists what has to be pointed at
# the new address afterwards. Remote state (infra/tfstate) lives in a
# resource group of its own, which this script never touches.
#
#   ./rebuild.sh                  the resource group in the Terraform outputs
#   ./rebuild.sh rg-<name>-<env>  a group the state no longer knows about
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v az >/dev/null || ! az account show >/dev/null 2>&1; then
  echo "Sign in first: az login --scope https://management.azure.com//.default" >&2
  exit 1
fi

# With remote state, backend.hcl holds the account details (backend.tf.example).
# A bare init only works while .terraform still remembers them, so not in a
# fresh checkout. Initialising here, before anything is deleted, also means a
# broken backend stops the script while there is still nothing to clean up.
init_args=(-input=false)
if [ -f backend.tf ] && [ -f backend.hcl ]; then init_args+=(-backend-config=backend.hcl); fi
terraform init "${init_args[@]}"

if [ -n "${1:-}" ]; then
  RG="$1"
# With no outputs in the state Terraform prints a warning on stdout and exits 0,
# so the value must look like a resource group name to count.
elif ! RG="$(terraform output -no-color -raw resource_group 2>/dev/null)" || ! [[ "$RG" =~ ^[-A-Za-z0-9._()]+$ ]]; then
  echo "The Terraform state has no resource_group output; pass the group to delete: $0 rg-<name>-<environment>" >&2
  exit 1
fi
INFRA_RG="$RG-cae-infra" # Azure creates this one for the Container Apps environment

# A terraform killed mid-run leaves the remote state locked, because an Azure
# blob lease does not expire. state rm below would only find out after the
# delete, and a second run of this script stops at deleting a group that is
# already gone. A dry run takes the lock and lets it go, so it fails now instead.
if [ -f backend.tf ]; then
  addresses=$(terraform state list)
  if [ -n "$addresses" ] &&
    ! printf '%s\n' "$addresses" | tr '\n' '\0' | xargs -0 terraform state rm -dry-run -lock-timeout=0s >/dev/null; then
    echo "Nothing was deleted. If the error above is the state lock and no other terraform is running, release it with terraform force-unlock <ID> (README.md, Operations), then run this again." >&2
    exit 1
  fi
fi

echo "Subscription: $(az account show --query '[name, id]' -o tsv | tr '\n' ' ')"
echo
echo "About to delete, permanently:"
az resource list -g "$RG" --query "[].{name:name, type:type}" -o table 2>/dev/null || echo "  ($RG not found)"
echo
cat <<'WARNING'
This destroys the PostgreSQL server together with its point-in-time recovery
window and its geo-redundant backups, and the storage account holding the
nightly dumps. The database is on a private subnet, so nothing outside the
virtual network can take a copy first. Whatever is in it is gone.

The new environment gets a new default hostname and a new static IP, so the
registrar's A, CNAME and asuid TXT records, the bound custom hostnames and the
authorised origin in the Google console all have to be updated afterwards.
WARNING
echo
read -r -p "Type the resource group name to confirm: " typed
[ "$typed" = "$RG" ] || { echo "Nothing was deleted."; exit 1; }

echo "==> Deleting $RG (around ten minutes)"
az group delete -n "$RG" --yes

# Deleting the environment normally takes its infrastructure group with it; when
# it does not, the next apply fails because that name is still taken.
if az group show -n "$INFRA_RG" >/dev/null 2>&1; then
  echo "==> $INFRA_RG outlived the environment, deleting it too"
  az group delete -n "$INFRA_RG" --yes
fi

echo "==> Waiting for both names to become free"
until ! az group show -n "$RG" >/dev/null 2>&1 && ! az group show -n "$INFRA_RG" >/dev/null 2>&1; do
  sleep 15
done

if [ -f backend.tf ]; then
  echo "==> Remote state in use; removing the old resources from it"
  addresses=$(terraform state list)
  # NUL-separated, because xargs strips the quotes from for_each addresses such
  # as job_failed["backup"]. One call also writes one new state version.
  if [ -n "$addresses" ]; then printf '%s\n' "$addresses" | tr '\n' '\0' | xargs -0 terraform state rm; fi
else
  echo "==> Discarding the local state; it describes resources that no longer exist"
  rm -f terraform.tfstate terraform.tfstate.backup
fi

echo "==> Rebuilding"
terraform init "${init_args[@]}" -upgrade
terraform apply

echo
echo "Point DNS at these, then put the hostnames back in custom_hostnames and apply again:"
for name in app_url app_fqdn static_ip custom_domain_verification_id; do
  printf '  %-30s %s\n' "$name" "$(terraform output -raw "$name" 2>/dev/null || echo '(none)')"
done
