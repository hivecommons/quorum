#!/usr/bin/env bash
# Smoke test for the shared Vexa service in `meetings`, run with the hivecommons-hive tenant key.
# A throwaway curl Pod in `meetings` (deleted at the end) gets the key from the Secret through
# secretKeyRef, so the key is never printed or copied out of the cluster.
#
# Checks: gateway health; transcription health; bot list empty; a bot for an invalid Meet URL is
# scheduled on arm64, starts (no exec format error) and ends or is stopped cleanly; no bot Pods
# linger.
set -euo pipefail
CTX="${KUBE_CONTEXT:-hive-oke}"
NS=meetings
TENANT="${TENANT:-hivecommons-hive}"
POD=vexa-smoke
# A syntactically valid Meet code that does not exist.
MEET_CODE=aaa-bbbb-ccc
BOT_LABEL=runtime.managed=true
# Seconds to wait for the bot Pod to appear, and for it to finish after a stop.
APPEAR_TIMEOUT=180
FINISH_TIMEOUT=300
CURL_IMAGE=docker.io/curlimages/curl:8.17.0@sha256:935d9100e9ba842cdb060de42472c7ca90cfe9a7c96e4dacb55e79e560b3ff40

k() { kubectl --context "$CTX" -n "$NS" "$@"; }
cleanup() { k delete pod "$POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true; }
trap cleanup EXIT

k apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $POD
  namespace: $NS
  labels: { app.kubernetes.io/name: vexa-smoke, app.kubernetes.io/part-of: quorum }
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  containers:
    - name: curl
      image: $CURL_IMAGE
      command: ["sleep", "900"]
      env:
        - name: API_KEY
          valueFrom: { secretKeyRef: { name: vexa-tenant-$TENANT, key: api-key } }
      resources:
        requests: { cpu: 10m, memory: 16Mi }
        limits: { cpu: 100m, memory: 64Mi }
EOF
k wait --for=condition=Ready "pod/$POD" --timeout=120s >/dev/null

# Run curl in the Pod; $API_KEY is expanded inside the container, never here.
# Usage: api METHOD URL [JSON_BODY]
api() {
  k exec "$POD" -- sh -c 'curl -sS -m 30 -w "\nHTTP %{http_code}\n" -X "$0" \
    -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" ${2:+--data "$2"} "$1"' "$@"
}

echo "--- gateway /health";       k exec "$POD" -- curl -sS -m 10 -w '\nHTTP %{http_code}\n' http://vexa-gateway:8000/health
echo "--- transcription /health"; k exec "$POD" -- curl -sS -m 10 -w '\nHTTP %{http_code}\n' http://vexa-transcription:8000/health
echo "--- GET /bots/status";      api GET http://vexa-gateway:8000/bots/status
echo "--- POST /bots (invalid Meet URL https://meet.google.com/$MEET_CODE)"
api POST http://vexa-gateway:8000/bots "{\"platform\":\"google_meet\",\"native_meeting_id\":\"$MEET_CODE\"}"

echo "--- waiting for a bot Pod"
deadline=$((SECONDS + APPEAR_TIMEOUT)); bot=""
while [ -z "$bot" ] && [ "$SECONDS" -lt "$deadline" ]; do
  bot="$(k get pods -l "$BOT_LABEL" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  [ -n "$bot" ] || sleep 3
done
if [ -z "$bot" ]; then
  echo "no bot Pod appeared within ${APPEAR_TIMEOUT}s (the API response above says why)"
else
  node="$(k get pod "$bot" -o jsonpath='{.spec.nodeName}')"
  echo "bot Pod $bot on node $node, arch $(kubectl --context "$CTX" get node "$node" -o jsonpath='{.metadata.labels.kubernetes\.io/arch}')"
  echo "resources: $(k get pod "$bot" -o jsonpath='{.spec.containers[0].resources}')"
  k wait --for=jsonpath='{.status.phase}'=Running "pod/$bot" --timeout=180s >/dev/null 2>&1 || true
  sleep 30
  echo "--- bot log (head)"; k logs "$bot" --tail=40 2>&1 | grep -iE "exec format|error|join|meet|status|state|leav|exit" | head -25 || true
  echo "--- GET /bots/status";   api GET http://vexa-gateway:8000/bots/status
  echo "--- DELETE the bot (no-op if it already ended)"
  api DELETE "http://vexa-gateway:8000/bots/google_meet/$MEET_CODE"
  k wait --for=delete "pod/$bot" --timeout="${FINISH_TIMEOUT}s" >/dev/null 2>&1 || true
fi
echo "--- lingering bot Pods:"; k get pods -l "$BOT_LABEL" --no-headers 2>&1 || true
