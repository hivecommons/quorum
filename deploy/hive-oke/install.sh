#!/usr/bin/env bash
# Install or upgrade the shared Vexa service for Quorum on hive-oke, namespace `meetings` only.
# Idempotent: existing Secrets are never rotated, and an existing tenant key is never re-minted.
# Never prints secret values.
#
# Usage: KUBE_CONTEXT=hive-oke VEXA_CHART=/path/to/hivecommons-vexa/deploy/helm/charts/vexa ./install.sh
#   VEXA_CHART must be a checkout of hivecommons/vexa at tag v0.12.28 (chart 0.12.2).
# Needs: kubectl, helm, python3 (with PyYAML), openssl.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CTX="${KUBE_CONTEXT:-hive-oke}"
NS=meetings
RELEASE=vexa
: "${VEXA_CHART:?set VEXA_CHART to deploy/helm/charts/vexa in a hivecommons/vexa v0.12.28 checkout}"
VALUES="$HERE/values.yaml"
# Random secret length in bytes (hex-encoded to twice this many characters).
SECRET_BYTES=32
S3_KEY_ID_BYTES=10
S3_SECRET_BYTES=20
ROLLOUT_TIMEOUT=15m

k() { kubectl --context "$CTX" -n "$NS" "$@"; }
val() { python3 -c "import sys,yaml; d=yaml.safe_load(open('$VALUES')); [d:=d[p] for p in sys.argv[1].split('.')]; print(d)" "$1"; }
rand() { openssl rand -hex "$1"; }
has_secret() { k get secret "$1" >/dev/null 2>&1; }

MAX_BOTS="$(val quorum.maxConcurrentBots)"
CP_PODS="$(val quorum.controlPlanePods)"
TENANT="$(val quorum.tenant.name)"
HIVE_ID="$(val quorum.tenant.hostedHiveId)"

echo "==> namespace"
kubectl --context "$CTX" apply -f "$HERE/namespace.yaml"

echo "==> secrets (created once, never rotated here)"
if ! has_secret vexa-s3; then
  k create secret generic vexa-s3 \
    --from-literal=AWS_ACCESS_KEY_ID="$(rand "$S3_KEY_ID_BYTES")" \
    --from-literal=AWS_SECRET_ACCESS_KEY="$(rand "$S3_SECRET_BYTES")" >/dev/null
  echo "created secret/vexa-s3"
fi
if ! has_secret vexa-admin; then
  k create secret generic vexa-admin \
    --from-literal=ADMIN_API_TOKEN="$(rand "$SECRET_BYTES")" \
    --from-literal=INTERNAL_API_SECRET="$(rand "$SECRET_BYTES")" \
    --from-literal=TRANSCRIPTION_SERVICE_TOKEN="$(rand "$SECRET_BYTES")" \
    --from-literal=VEXA_DISPATCH_SIGNING_KEY="$(rand "$SECRET_BYTES")" \
    --from-literal=NEXTAUTH_SECRET="$(rand "$SECRET_BYTES")" \
    --from-literal=VEXA_SERVICE_AUTHORITY_SECRET="" \
    --from-literal=VEXA_SYSTEM_WEBHOOK_SECRET="" >/dev/null
  echo "created secret/vexa-admin"
fi

echo "==> policy: LimitRange, NetworkPolicy, ResourceQuota (pods = $CP_PODS + $MAX_BOTS bots)"
k apply -f "$HERE/policy.yaml"
k apply -f - <<EOF
apiVersion: v1
kind: ResourceQuota
metadata:
  name: meetings-quota
  namespace: $NS
  labels:
    app.kubernetes.io/part-of: quorum
  annotations:
    quorum.hivecommons.dev/max-concurrent-bots: "$MAX_BOTS"
    quorum.hivecommons.dev/control-plane-pods: "$CP_PODS"
spec:
  hard:
    pods: "$((CP_PODS + MAX_BOTS))"
    services.loadbalancers: "0"
    services.nodeports: "0"
EOF

echo "==> object storage (versitygw) and bucket"
k apply -f "$HERE/versitygw.yaml"
k rollout status deploy/versitygw --timeout="$ROLLOUT_TIMEOUT"
k wait --for=condition=complete job/versitygw-bucket --timeout=5m

echo "==> CPU transcription"
k apply -f "$HERE/transcription.yaml"
k rollout status deploy/vexa-transcription --timeout="$ROLLOUT_TIMEOUT"

echo "==> helm release $RELEASE"
helm --kube-context "$CTX" upgrade --install "$RELEASE" "$VEXA_CHART" -n "$NS" \
  -f "$VALUES" --wait --timeout "$ROLLOUT_TIMEOUT"

# Calls admin-api from inside its own Pod, so tokens never leave the cluster except as the
# tenant key, which goes straight into a Secret.
admin_py() { k exec -i deploy/vexa-admin-api -c admin-api -- python3 - "$@"; }

echo "==> disable the captured-signal tape fleet-wide (no audio stored; RFC)"
admin_py <<'PY'
import json, os, urllib.request
req = urllib.request.Request(
    "http://127.0.0.1:8001/internal/settings/diagnostics", method="PUT",
    data=json.dumps({"capture_signal": "false"}).encode(),
    headers={"Content-Type": "application/json",
             "X-Internal-Secret": os.environ["INTERNAL_API_SECRET"]})
print("diagnostics:", urllib.request.urlopen(req, timeout=10).status)
PY

echo "==> tenant $TENANT (hosted hive $HIVE_ID)"
TENANT_SECRET="vexa-tenant-$TENANT"
if has_secret "$TENANT_SECRET"; then
  echo "secret/$TENANT_SECRET exists; not re-minting"
else
  admin_py "$TENANT" "$HIVE_ID" "$MAX_BOTS" <<'PY' | k create secret generic "$TENANT_SECRET" --from-file=api-key=/dev/stdin >/dev/null
import json, os, sys, urllib.request
tenant, hive_id, max_bots = sys.argv[1], sys.argv[2], int(sys.argv[3])
H = {"Content-Type": "application/json", "X-Admin-API-Key": os.environ["ADMIN_API_TOKEN"]}
def call(method, path, body=None):
    req = urllib.request.Request("http://127.0.0.1:8001" + path, method=method, headers=H,
                                 data=None if body is None else json.dumps(body).encode())
    return json.load(urllib.request.urlopen(req, timeout=10))
user = call("POST", "/admin/users", {"email": f"{tenant}@tenants.quorum.hivecommons.dev",
                                      "name": f"{tenant} ({hive_id})",
                                      "max_concurrent_bots": max_bots})
tok = call("POST", f"/admin/users/{user['id']}/tokens",
           {"scopes": ["bot", "tx"], "name": f"quorum-{tenant}"})
sys.stdout.write(tok["token"])
PY
  k label secret "$TENANT_SECRET" app.kubernetes.io/part-of=quorum \
    quorum.hivecommons.dev/tenant="$TENANT" >/dev/null
  k annotate secret "$TENANT_SECRET" quorum.hivecommons.dev/hosted-hive-id="$HIVE_ID" >/dev/null
  echo "created secret/$TENANT_SECRET (key api-key)"
fi
echo "done"
