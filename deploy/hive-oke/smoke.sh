#!/usr/bin/env bash
# Smoke test for the shared Vexa service in `meetings`, run with the hivecommons-hive tenant key.
# A throwaway python Pod in `meetings` (deleted at the end) gets the key from the Secret through
# secretKeyRef, so the key is never printed or copied out of the cluster. smoke_api.py runs inside
# it (standard library only).
#
# Checks: gateway and transcription health; the TTS service returns 24 kHz PCM for a short
# sentence with the key (and 401 without it); a voice bot for a Meet code that does not exist is
# scheduled on arm64 and starts (no exec format error); /ws connects and sends a meeting.status
# frame for that bot; the chat route answers a 4xx about the bot's state (never a missing-route
# 404) and /speak a 409 "not in the meeting"; DELETE stops the bot; no bot Pods linger; the
# bucket holds no objects (recording and the captured-signal tape are off); the captured-signal
# setting reads "false".
set -euo pipefail
CTX="${KUBE_CONTEXT:-hive-oke}"
NS=meetings
TENANT="${TENANT:-hivecommons-hive}"
HERE="$(cd "$(dirname "$0")" && pwd)"
POD=vexa-smoke
# A syntactically valid Meet code that does not exist.
MEET_CODE=aaa-bbbb-ccc
BOT_LABEL=runtime.managed=true
BUCKET_DIR=/data/vexa-meetings
# Seconds to wait for the bot Pod to finish after the stop.
FINISH_TIMEOUT=300
PY_IMAGE=docker.io/library/python:3.12-slim@sha256:05cda9777409a9c3ffddd94a4c476b79f0769a0b4857f0c7ed9226b6800b0d6f

k() { kubectl --context "$CTX" -n "$NS" "$@"; }
cleanup() { k delete pod "$POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true; }
trap cleanup EXIT
fail=0

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
    - name: smoke
      image: $PY_IMAGE
      command: ["sleep", "900"]
      env:
        - name: API_KEY
          valueFrom: { secretKeyRef: { name: vexa-tenant-$TENANT, key: api-key } }
        - name: TTS_API_TOKEN
          valueFrom: { secretKeyRef: { name: vexa-tts, key: TTS_API_TOKEN } }
        - name: MEET_CODE
          value: $MEET_CODE
      resources:
        requests: { cpu: 50m, memory: 64Mi }
        limits: { cpu: 200m, memory: 128Mi }
EOF
k wait --for=condition=Ready "pod/$POD" --timeout=120s >/dev/null

echo "--- transcription /health"
k exec "$POD" -- python3 -c "import urllib.request as u; print('HTTP', u.urlopen('http://vexa-transcription:8000/health', timeout=10).status)"

echo "--- TTS (vexa-tts /v1/audio/speech, called the way a voice bot calls it)"
k exec -i "$POD" -- python3 - <<'PY' || fail=1
import json, os, time, urllib.error, urllib.request
URL = "http://vexa-tts:8880/v1/audio/speech"
# The bot's request body (tts-playback.ts); voice "auto" is what it sends when none was given.
BODY = {"model": "tts-1", "input": "Hello, this is the hive taking notes.", "voice": "auto",
        "response_format": "pcm"}
SAMPLE_RATE = 24000
BYTES_PER_SAMPLE = 2
MIN_SECONDS = 0.5
TIMEOUT = 120
def post(headers):
    req = urllib.request.Request(URL, method="POST", data=json.dumps(BODY).encode(),
                                 headers={"Content-Type": "application/json", **headers})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
st, _ = post({})
keyed = st == 401
print(f"CHECK tts_needs_key {'PASS' if keyed else 'FAIL'} HTTP {st}")
t0 = time.time()
st, audio = post({"X-API-Key": os.environ["TTS_API_TOKEN"]})
secs = len(audio) / (SAMPLE_RATE * BYTES_PER_SAMPLE)
ok = st == 200 and len(audio) % BYTES_PER_SAMPLE == 0 and secs >= MIN_SECONDS
print(f"CHECK tts_speech {'PASS' if ok else 'FAIL'} HTTP {st}, {len(audio)} bytes"
      f" = {secs:.2f}s of 24 kHz s16le, synthesized in {time.time() - t0:.2f}s")
raise SystemExit(0 if ok and keyed else 1)
PY

# Bot Pod watcher: reports the node arch and the first log lines while smoke_api.py runs.
(
  for _ in $(seq 1 60); do
    bot="$(k get pods -l "$BOT_LABEL" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
    if [ -n "$bot" ]; then
      node=""
      for _ in $(seq 1 30); do
        node="$(k get pod "$bot" -o jsonpath='{.spec.nodeName}' 2>/dev/null || true)"
        [ -n "$node" ] && break; sleep 2
      done
      echo "bot Pod $bot on node $node, arch $(kubectl --context "$CTX" get node "$node" -o jsonpath='{.metadata.labels.kubernetes\.io/arch}' 2>/dev/null)"
      k wait --for=jsonpath='{.status.phase}'=Running "pod/$bot" --timeout=120s >/dev/null 2>&1 || true
      sleep 20
      echo "--- bot log (filtered)"
      k logs "$bot" --tail=60 2>&1 | grep -iE "exec format|error|join|status|state|leav|exit" | head -20 || true
      exit 0
    fi
    sleep 2
  done
  echo "no bot Pod appeared"
) &
watcher=$!

echo "--- API checks (smoke_api.py)"
k exec -i "$POD" -- python3 - < "$HERE/smoke_api.py" || fail=1
wait "$watcher" || true

echo "--- waiting for bot Pods to finish"
for bot in $(k get pods -l "$BOT_LABEL" -o name 2>/dev/null); do
  k wait --for=delete "$bot" --timeout="${FINISH_TIMEOUT}s" >/dev/null 2>&1 || true
done
lingering="$(k get pods -l "$BOT_LABEL" --no-headers 2>/dev/null | wc -l | tr -d ' ')"
if [ "$lingering" = 0 ]; then echo "CHECK no_lingering_bots PASS"; else echo "CHECK no_lingering_bots FAIL $lingering"; fail=1; fi

objects="$(k exec deploy/versitygw -- sh -c "find $BUCKET_DIR -type f | wc -l" | tr -d ' ')"
if [ "$objects" = 0 ]; then echo "CHECK bucket_empty PASS"; else echo "CHECK bucket_empty FAIL $objects objects"; fail=1; fi

capture="$(k exec -i deploy/vexa-admin-api -c admin-api -- python3 - <<'PY'
import json, os, urllib.request
req = urllib.request.Request("http://127.0.0.1:8001/internal/settings/diagnostics",
                             headers={"X-Internal-Secret": os.environ["INTERNAL_API_SECRET"]})
print((json.load(urllib.request.urlopen(req, timeout=10)).get("value") or {}).get("capture_signal"))
PY
)"
if [ "$capture" = false ]; then echo "CHECK capture_signal_off PASS"; else echo "CHECK capture_signal_off FAIL $capture"; fail=1; fi

exit "$fail"
