#!/usr/bin/env bash
# Idempotent install/upgrade of hive-mx in namespace `mail` on hive-oke (hivecommons/hive#18395).
#
#   KUBE_CONTEXT=hive-oke deploy/hive-oke/mail/install.sh            # mail namespace only
#   KUBE_CONTEXT=hive-oke deploy/hive-oke/mail/install.sh --hub-secret
#
# The bearer token hive-mx shows the hub is generated once into Secret mail/hive-mx-hub-token
# and never printed. With --hub-secret the same value is also written as key `mail-token` of
# Secret hive-hub/hive-hub-secrets (with the tls-sync Role and RoleBinding in hive-hub, the only
# changes this script makes outside `mail`); the hub
# reads it as HIVE_HUB_MAIL_TOKEN once its Deployment references that key and has rolled out,
# which is an operator step (README.md, "Hub").
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ctx="${KUBE_CONTEXT:-hive-oke}"
k() { kubectl --context "$ctx" "$@"; }

hub_secret=false
for arg in "$@"; do
  case "$arg" in
    --hub-secret) hub_secret=true ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

k apply -f "$here/namespace.yaml"

if ! k -n mail get secret hive-mx-hub-token >/dev/null 2>&1; then
  token="$(openssl rand -hex 32)"
  k -n mail create secret generic hive-mx-hub-token --from-literal=token="$token" >/dev/null
  unset token
  echo "created Secret mail/hive-mx-hub-token"
fi

if [ "$hub_secret" = true ]; then
  b64="$(k -n mail get secret hive-mx-hub-token -o jsonpath='{.data.token}')"
  k -n hive-hub patch secret hive-hub-secrets --type merge -p "{\"data\":{\"mail-token\":\"$b64\"}}" >/dev/null
  unset b64
  echo "set key mail-token in Secret hive-hub/hive-hub-secrets"
fi

k apply -f "$here/policy.yaml"

# STARTTLS certificate copy (README.md, "STARTTLS"). Its Role and RoleBinding in hive-hub are
# the only other objects outside `mail`. Seed the copy once so the Deployment can mount it.
k apply -f "$here/tls-sync.yaml"
if ! k -n mail get secret hive-mx-tls >/dev/null 2>&1; then
  job="hive-mx-tls-seed-$(date +%s)"
  k -n mail create job --from=cronjob/hive-mx-tls-sync "$job" >/dev/null
  k -n mail wait --for=condition=complete "job/$job" --timeout=180s
  k -n mail logs "job/$job"
fi

k apply -f "$here/hive-mx.yaml"
k -n mail rollout status deploy/hive-mx --timeout=180s
k -n mail get svc hive-mx -o wide
