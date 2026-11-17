#!/usr/bin/env bash
# Install or upgrade the shared Vexa service for Quorum on hive-oke, namespace `meetings` only.
# Idempotent: existing Secrets are never rotated, and an existing tenant key is never re-minted.
# Never prints secret values.
#
# Usage: KUBE_CONTEXT=hive-oke VEXA_CHART=/path/to/hivecommons-vexa/deploy/helm/charts/vexa ./install.sh
#   VEXA_CHART must be a checkout of hivecommons/vexa at the commit values.yaml names
#   (quorum.vexaCommit), whose images it pins.
# Needs: kubectl, helm, python3 (with PyYAML), openssl.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
CTX="${KUBE_CONTEXT:-hive-oke}"
NS=meetings
RELEASE=vexa
: "${VEXA_CHART:?set VEXA_CHART to deploy/helm/charts/vexa in a hivecommons/vexa checkout at quorum.vexaCommit}"
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
    --from-literal=VEXA_SYSTEM_WEBHOOK_SECRET="" \
    --from-literal=REDIS_PASSWORD="$(rand "$SECRET_BYTES")" \
    --from-literal=RUNTIME_API_TOKEN="$(rand "$SECRET_BYTES")" \
    --from-literal=VEXA_MCP_DELEGATION_SECRET="$(rand "$SECRET_BYTES")" >/dev/null
  echo "created secret/vexa-admin"
fi
# Keys chart 0.13 reads from vexa-admin that an older install did not create. Added once each with
# a random value; an existing key is never changed.
for key in REDIS_PASSWORD RUNTIME_API_TOKEN VEXA_MCP_DELEGATION_SECRET; do
  if [ -z "$(k get secret vexa-admin -o "jsonpath={.data.$key}")" ]; then
    k patch secret vexa-admin --type merge \
      -p "{\"stringData\":{\"$key\":\"$(rand "$SECRET_BYTES")\"}}" >/dev/null
    echo "added $key to secret/vexa-admin"
  fi
done

# TTS key: TTS_API_TOKEN is what meeting-api hands voice bots (sent as X-API-Key); API_KEYS is the
# same value as the JSON list the TTS service (Kokoro-FastAPI) reads.
if ! has_secret vexa-tts; then
  tts_token="$(rand "$SECRET_BYTES")"
  k create secret generic vexa-tts \
    --from-literal=TTS_API_TOKEN="$tts_token" \
    --from-literal=API_KEYS="[\"$tts_token\"]" >/dev/null
  unset tts_token
  echo "created secret/vexa-tts"
fi

# SearXNG secret_key (SEARXNG_SECRET), used only to sign its own cookies/tokens.
if ! has_secret searxng-secret; then
  k create secret generic searxng-secret \
    --from-literal=SEARXNG_SECRET="$(rand "$SECRET_BYTES")" >/dev/null
  echo "created secret/searxng-secret"
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
# The realtime tier first, and Ready, before Service vexa-transcription (which selects it) is
# applied, so the live endpoint never points at Pods that are still loading a model.
k apply -f "$HERE/transcription.yaml" -l app.kubernetes.io/name=vexa-transcription-rt
k rollout status deploy/vexa-transcription-rt --timeout="$ROLLOUT_TIMEOUT"
k apply -f "$HERE/transcription.yaml"
k rollout status deploy/vexa-transcription --timeout="$ROLLOUT_TIMEOUT"

echo "==> CPU text-to-speech (Kokoro)"
k apply -f "$HERE/tts.yaml"
k rollout status deploy/vexa-tts --timeout="$ROLLOUT_TIMEOUT"

echo "==> web search for hive Betty (SearXNG)"
k apply -f "$HERE/searxng.yaml"
k rollout status deploy/searxng --timeout="$ROLLOUT_TIMEOUT"

echo "==> meeting-bot image pre-puller (every node a bot Pod can schedule to)"
BOT_IMAGE="$(val runtime.browserImage)"
BOT_NODE_SELECTOR="$(python3 -c "import json,yaml; print(json.dumps(yaml.safe_load(open('$VALUES'))['runtime'].get('nodeSelector') or {}))")"
sed -e "s|__BOT_IMAGE__|$BOT_IMAGE|" -e "s|__NODE_SELECTOR__|$BOT_NODE_SELECTOR|" "$HERE/prepull.yaml" \
  | kubectl --context "$CTX" apply -f -
kubectl --context "$CTX" -n meetings-prepull rollout status ds/vexa-bot-prepull --timeout="$ROLLOUT_TIMEOUT"

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
