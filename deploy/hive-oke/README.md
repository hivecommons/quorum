# Shared Vexa service on hive-oke

Quorum (RFC #1) uses one shared Vexa control plane per cluster. On hive-oke it runs in namespace
`meetings`, and nothing outside that namespace is touched. The only cluster-scoped object is the
`meetings` Namespace.

| File                 | What it is                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `namespace.yaml`     | Namespace `meetings` (Pod Security baseline in warn/audit mode)                              |
| `values.yaml`        | Helm values for the Vexa chart, plus the `quorum` block read by `install.sh`                 |
| `versitygw.yaml`     | In-namespace S3 endpoint (versitygw, POSIX backend on a 50Gi `oci-bv` PVC), bucket Job       |
| `transcription.yaml` | CPU Whisper (faster-whisper, int8): realtime tier (`base`) and batch tier (`small`)          |
| `tts.yaml`           | CPU text-to-speech (Kokoro via Kokoro-FastAPI) Deployment, Service, voice-map ConfigMap      |
| `searxng.yaml`       | SearXNG web search for hive Betty: Deployment, Service `searxng:8080`, settings ConfigMap    |
| `policy.yaml`        | LimitRange and gateway NetworkPolicy                                                         |
| `install.sh`         | Idempotent install/upgrade: Secrets, policy, ResourceQuota, storage, STT, TTS, search, Helm  |
| `smoke.sh`           | Smoke test with the tenant key from a throwaway Pod (includes a direct TTS call)             |
| `smoke_api.py`       | The API half of the smoke test (health, `/ws`, chat, speak), run inside that Pod             |
| `mail/`              | hive-mx, hive's receive-only mail receiver, in its own namespace `mail` (see mail/README.md) |

## Versions (all pinned by tag and digest)

Everything Vexa comes from one commit of hivecommons/vexa `main`: 70859c13728b6b819a64bb68cc5a7016e1c81f92 (chart 0.13.4).
It is upstream Vexa `main` plus our patches (hivecommons/vexa#2 Teams chat-write, #3 speak route, #7 Teams
per-track capture, #8 Google Meet end of turn, #9 cached and prewarmed short TTS lines).
Upstream v0.12.28 has no meeting chat-post route and its `/ws` sends no chat events; both
are on upstream `main`, and upstream publishes control-plane images only for releases.

| Component                                | Image                                                                            |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| Chart                                    | `deploy/helm/charts/vexa` at hivecommons/vexa 70859c1 (chart 0.13.4)             |
| gateway                                  | `ghcr.io/hivecommons/vexa-gateway:main-70859c1-quorum`                           |
| admin-api                                | `ghcr.io/hivecommons/vexa-admin-api:main-70859c1-quorum`                         |
| meeting-api                              | `ghcr.io/hivecommons/vexa-meeting-api:main-70859c1-quorum`                       |
| runtime                                  | `ghcr.io/hivecommons/vexa-runtime:main-70859c1-quorum`                           |
| meeting bot                              | `ghcr.io/hivecommons/vexa-bot:main-70859c1-quorum`                               |
| CPU transcription                        | `ghcr.io/hivecommons/vexa-transcription-cpu:main-70859c1-quorum`                 |
| agent-api, agent-worker (pinned, unused) | `ghcr.io/hivecommons/vexa-agent-api`, `vexa-agent-worker` `:main-70859c1-quorum` |
| mcp (pinned, disabled)                   | `ghcr.io/hivecommons/vexa-mcp:main-70859c1-quorum`                               |
| postgres                                 | `docker.io/library/postgres:17.11-alpine`                                        |
| redis                                    | `docker.io/valkey/valkey:8.1.11-alpine`                                          |
| S3                                       | `docker.io/versity/versitygw:v1.10.0`                                            |
| TTS (not Vexa; upstream image)           | `ghcr.io/remsky/kokoro-fastapi-cpu:v0.10.0`                                      |
| web search (not Vexa; upstream image)    | `docker.io/searxng/searxng:2026.11.15-2d500cb6b`                                 |

Digests are in `values.yaml`, `transcription.yaml`, `tts.yaml` and `searxng.yaml`. Each Vexa image is a manifest
list with linux/amd64 and linux/arm64, built on native runners by `.github/workflows/quorum-images.yml` in
hivecommons/vexa (`source=main`). Every hive-oke node is arm64. Images must be fully qualified
(`docker.io/...`, `ghcr.io/...`) because hive-oke runs CRI-O with short-name mode set to
enforcing.

## What runs

- Control plane: gateway x2, admin-api x2, meeting-api x2, runtime x1 (k8s backend, namespaced
  Role only), postgres, redis. agent-api, mcp, terminal, and dashboard are disabled: Quorum needs
  none of them, so no model credentials live here.
- The chart's bot seccomp installer (`runtime.botSandbox`, a hostPath DaemonSet on every node) is
  off: it writes node files outside `meetings` and its Pods would take the bot slots in the pod
  quota. Bots run under RuntimeDefault seccomp, as they did on v0.12.
- All Services are ClusterIP. There is no Ingress, LoadBalancer, or NodePort (the ResourceQuota
  also caps `services.loadbalancers` and `services.nodeports` at 0).
- Bots: one bare Pod per meeting, created by the runtime. Each is Guaranteed at 1 CPU / 2560Mi
  (`runtime.workloadResources.meetingBot`) and pinned to `kubernetes.io/arch: arm64`.
- Transcription, two tiers from one image (both need `TRANSCRIPTION_SERVICE_TOKEN`):
  - realtime: `vexa-transcription:8000` (Deployment `vexa-transcription-rt`, 2 replicas spread
    across nodes, model `base`, beam 1, 2-4 CPU / 1-2Gi each). The bots and Quorum's Discord and
    companion paths call it. Measured on a 2 s clip from inside the cluster: about 1.6-1.9 s per
    request (`small` with beam 5 took 8-10 s on the same clip; the encoder dominates, so beam
    size barely moves `small`). `base` is fetched at a pinned Hugging Face commit by an init
    container; the server runs offline.
  - batch: `vexa-transcription-batch:8000` (Deployment `vexa-transcription`, 1 replica, model
    `small`, beam 5, 2-4 CPU / 2-4Gi) for after-meeting transcription.
  - Probes time out at 5 s: a busy worker answers `/health` late, and the 1 s default once got
    the worker killed mid-meeting, which callers saw as 503s.
- Text-to-speech: `vexa-tts:8880`, 1-2 CPU / 1.5-3Gi (about 1.05Gi resident idle; a short
  sentence takes about 3 s on 2 CPUs). It needs `TTS_API_TOKEN`. See Voice.
- Web search: `searxng:8080`, 50m-500m CPU / 128-384Mi. Not part of Quorum; it is here for
  hive's Betty. See SearXNG.

## Meeting API used by Quorum

- `POST /bots/{platform}/{native_meeting_id}/chat` posts into the meeting chat (Teams: the
  bot types into the meeting chat, hivecommons/vexa#2). It answers a 4xx while the bot is not yet
  in the meeting.
- `/ws` (header `X-API-Key`) sends `meeting.status` frames for the tenant's meetings, and chat
  and transcript frames for meetings it subscribes to (`{"action": "subscribe", "meetings":
[{"platform": ..., "native_id": ...}]}`).
- `POST` / `DELETE /bots/{platform}/{native_meeting_id}/speak`: see Voice.

## Voice

Voice is **available per bot, off by default**.

**TTS service.** [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (model weights
Apache-2.0) served by [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) (Apache-2.0)
v0.10.0, the upstream CPU image
`ghcr.io/remsky/kokoro-fastapi-cpu:v0.10.0@sha256:f54c5960c2b9387f6349080a9944f8bc7e8cdb98a4ef9238cb0b0f9ff9795f44`
(manifest list, linux/amd64 + linux/arm64, model and voices baked in, `DOWNLOAD_MODEL=false` so it
never downloads). It runs only in `meetings` (`tts.yaml`, Service `vexa-tts:8880`, ClusterIP), on
CPU, and calls no external or paid API. Chosen on 2026-11-15: Kokoro-FastAPI had 140 commits in
the previous 90 days (v0.10.0 released 2026-11-08) and serves the OpenAI-compatible endpoint the
bot calls. Piper was the alternative, but rhasspy/piper (MIT) is archived and its maintained
successor, OHF-Voice/piper1-gpl, is GPL-3.0. Only the HTTP API is on: web player, websocket TTS,
inline `[voice:...]` tags and SSML are disabled (`ENABLE_*` in `tts.yaml`).

**What the bot sends.** A bot sent with voice gets `TTS_SERVICE_URL=http://vexa-tts:8880` and
`TTS_API_TOKEN` from meeting-api (as plain env on its Pod; bots without voice get neither) and, for each spoken line, POSTs
`/v1/audio/speech {"model": "tts-1", "input": <text>, "voice": <voice or "auto">,
"response_format": "pcm"}` with header `X-API-Key: $TTS_API_TOKEN`. It streams the reply (raw
24 kHz s16le mono, Kokoro's native rate) into `paplay` on its PulseAudio `tts_sink`, which
Chromium captures as its microphone; the sink is unmuted only while a line plays. Kokoro-FastAPI
checks the key against `API_KEYS` (a request without it gets 401). It rejects the voice `auto`,
so ConfigMap `vexa-tts-mappings` replaces the image's `openai_mappings.json` with the same file
plus `"auto": "af_heart"`; re-copy it from the new tag when the image is bumped. OpenAI voice
names (`alloy`, `nova`, ...) and Kokoro voice ids (`af_heart`, `bm_george`, ...) also work.

**How voice is gated.**

1. Hive policy decides whether hive may speak in a meeting (voice rules, consent, budgets; see
   `docs/contract.md`). Only then does it call quorum `say`.
2. quorum `meeting.join {voice: true}` (default `QUORUM_VEXA_VOICE=false`) is the only way a bot
   is started able to speak: quorum then sends `voice_agent_enabled: true` on `POST /bots`.
   Without it quorum's `say` answers `platform_unavailable`.
3. meeting-api: `VOICE_AGENT_ENABLED` stays `"false"`. It is the default for a `POST /bots` that
   does not say, and quorum omits the field when voice is off, so `true` would make every bot a
   speaking bot. `POST /bots` with `voice_agent_enabled: true` works because `TTS_SERVICE_URL`
   is set (without it, 422).
4. `POST .../speak` answers 409 until the bot is admitted, 409 for a bot sent without voice,
   and is limited per meeting (`SPEAK_POSTS_PER_WINDOW` per `SPEAK_WINDOW_SEC`).

`smoke.sh` checks the TTS directly (24 kHz PCM back for a short sentence, 401 without the key),
then sends a voice bot (201) and expects `/speak` to answer 409 "not in the meeting".

## SearXNG (web search for Betty)

Hive's Betty (hivecommons/hive#18393) searches the web through a self-hosted
[SearXNG](https://github.com/searxng/searxng) (AGPL-3.0, run unmodified) instead of a paid search
API:

```
GET http://searxng.meetings.svc.cluster.local:8080/search?format=json&q=<query>
```

- Image: the upstream
  `docker.io/searxng/searxng:2026.11.15-2d500cb6b@sha256:932f69dca010db9880bddebb2171f05d8e1a25d04a59149ff65409993d680024`
  (manifest list, linux/amd64 + linux/arm64 + linux/arm/v7). To bump, pick a newer date tag on
  Docker Hub, pin tag plus index digest (`crane digest`), and check the image's
  `entrypoint.sh` still serves with granian on `GRANIAN_HOST`/`GRANIAN_PORT` and that
  `/healthz` still exists in `searx/webapp.py`.
- `searxng.yaml`: ConfigMap `searxng-settings` (`settings.yml`), Deployment `searxng` (1
  replica, Recreate, runs as the image's `searxng` user 977, read-only root filesystem with
  emptyDir `/var/cache/searxng` and `/tmp`, all capabilities dropped, probes on `/healthz`),
  Service `searxng` (ClusterIP, 8080).
- Settings: upstream defaults with `engines.keep_only` duckduckgo, brave, wikipedia, github,
  stackoverflow (the `stackexchange` engine). `search.formats` adds `json`. `limiter`,
  `public_instance` and `image_proxy` are off: the Service is ClusterIP only, so no valkey is
  needed. `general.contact_url` is set because the wikipedia engine refuses to load without
  it. A plain query uses category `general` (duckduckgo, brave, wikipedia); github and
  stackoverflow answer `&categories=it` (or `!gh` / `!st` in `q`).
- Secret `searxng-secret` (key `SEARXNG_SECRET`, the `server.secret_key`) is created by
  `install.sh` with a random value if it does not exist.
- Startup logs two harmless lines: `/etc/searxng` and `/var/cache/searxng` "not owned by
  searxng:searxng" (they are `root:searxng`; the ConfigMap is read-only and the cache is group
  writable), and "X-Forwarded-For nor X-Real-IP header is set!" once (the limiter is off).
- Pods: it is one of the `controlPlanePods` in the ResourceQuota (16 to 17 Pods when it was
  added; bot slots stay 4).

Smoke test (2026-11-16, from a throwaway Pod in `meetings`): `q=kubernetes`,
`q=golang generics`, `q=rust borrow checker` each returned 26 results with title, url and
content in 0.6-0.9 s; `categories=it` returned 40 (github 30, stackoverflow 10) in 1.1 s.
From the hive-oke egress address duckduckgo answered CAPTCHA (listed in
`unresponsive_engines`), so general results came from brave; wikipedia adds infobox
results rather than list results.

```bash
kubectl --context hive-oke -n meetings run searxng-smoke --rm -i --restart=Never \
  --image=docker.io/curlimages/curl:8.23.0@sha256:3fb7e13e5d179a845c97d78204f3f1064d1907037f26a3ebf91710571151fd93 \
  -- curl -s -m 20 'http://searxng.meetings.svc.cluster.local:8080/search?format=json&q=kubernetes'
```

The smoke Pod takes a bot slot while it runs.

## Privacy defaults

- `RECORDING_ENABLED=false`: no audio or video recording unless a request explicitly asks for it.
- The captured-signal tape (raw capture uploads for replay) is off twice: the chart default
  (`diagnostics.captureSignal: "false"`, `VEXA_CAPTURE_SIGNAL_DEFAULT`), and fleet-wide through
  admin-api `PUT /internal/settings/diagnostics {"capture_signal": "false"}`, which `install.sh`
  applies on every run. `smoke.sh` checks the setting reads `"false"` and the bucket is empty.
- Bot display name: "Hive notes (AI notetaker)".

## Limits

- `quorum.maxConcurrentBots: 4` in `values.yaml` is the single source. It is enforced in two places:
  - ResourceQuota `meetings-quota` sets `pods` = `controlPlanePods` (15, including vexa-tts, searxng
    and the three transcription Pods) + 4.
    A quota cannot select only bot Pods, so while a rollout surges or an ops Pod runs, that Pod uses a bot slot, and
    a rollout waits for a free slot.
  - The tenant user's `max_concurrent_bots` in admin-api, set to the same value.
- LimitRange `meetings-defaults` sets defaults for containers without resources: 1-1.5 CPU,
  1100Mi-2560Mi, per upstream bot guidance. The per-container max is 4 CPU / 6Gi.

## Network

NetworkPolicy `vexa-gateway-ingress` (`policy.yaml`) allows gateway ingress (TCP 8000) only from
namespaces with the label key `hive.kubestellar.io/hive-id`, and from `meetings`. The chart's own
NetworkPolicies (`networkPolicy.enabled`) are off: one has the same name, and its namespace-wide
default-deny would also block versitygw and the transcription service, which the chart does not
render.

**hive-oke runs flannel, which does not enforce NetworkPolicy.** The policy records intent and
starts working only if the CNI changes. The real boundary is the per-tenant Vexa API key: the
bot, meeting, and transcript routes require `X-API-Key` (scopes `bot` / `tx`), and each tenant
sees only its own meetings.

## Secrets (names only; values are random, created by install.sh, never in git)

| Secret                         | Keys                                                                                                                                                                                                                                                        | Used by                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `vexa-admin`                   | `ADMIN_API_TOKEN`, `INTERNAL_API_SECRET`, `TRANSCRIPTION_SERVICE_TOKEN`, `VEXA_DISPATCH_SIGNING_KEY`, `NEXTAUTH_SECRET`, `VEXA_SERVICE_AUTHORITY_SECRET`, `VEXA_SYSTEM_WEBHOOK_SECRET`, `REDIS_PASSWORD`, `RUNTIME_API_TOKEN`, `VEXA_MCP_DELEGATION_SECRET` | chart (`secrets.existingSecretName`), transcription                                      |
| `vexa-tts`                     | `TTS_API_TOKEN`, `API_KEYS` (the same value as a JSON list)                                                                                                                                                                                                 | meeting-api (handed to voice bots), vexa-tts                                             |
| `vexa-s3`                      | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`                                                                                                                                                                                                                | chart (`storage.s3.existingSecret`), versitygw root user                                 |
| `vexa-tenant-hivecommons-hive` | `api-key`                                                                                                                                                                                                                                                   | hive's hive (hosted hive `hosted-available-oke-11-placeholder-r05x`); scopes `bot`, `tx` |
| `postgres-credentials`         | chart-managed                                                                                                                                                                                                                                               | postgres                                                                                 |

The admin credential is `ADMIN_API_TOKEN` (header `X-Admin-API-Key` on admin-api). Following
the upstream Kubernetes docs, it is minted at install time and kept in `vexa-admin`.

## Install / upgrade

```bash
git clone https://github.com/hivecommons/vexa.git /tmp/hivecommons-vexa
git -C /tmp/hivecommons-vexa checkout 70859c13728b6b819a64bb68cc5a7016e1c81f92   # quorum.vexaCommit in values.yaml
KUBE_CONTEXT=hive-oke VEXA_CHART=/tmp/hivecommons-vexa/deploy/helm/charts/vexa ./install.sh
KUBE_CONTEXT=hive-oke ./smoke.sh
```

`install.sh` adds any `vexa-admin` key a newer chart needs (random value, existing keys never
change), then runs `helm upgrade --install --wait`.

Chart 0.13 refuses the database password the 0.12 chart published (`postgres`): admin-api and
meeting-api do not boot with it. The chart's fix is a `post-upgrade` hook, but `--wait` waits
for those Pods first, so the first 0.12 to 0.13 upgrade never finishes alone. On hive-oke this was
done by hand while helm waited (2026-11-15): `ALTER ROLE postgres` with a new random password over
the postgres Pod's local socket, the same value into Secret `postgres-credentials`, then the
crashing Pods deleted. The hook then ran and rotated it once more. Later upgrades are not affected.

New tenant: run admin-api `POST /admin/users` (with `max_concurrent_bots`), then
`POST /admin/users/{id}/tokens` with `{"scopes": ["bot", "tx"]}`, from inside the admin-api Pod
(see `install.sh`). Store the key in `vexa-tenant-<tenant>`.

## Rebuilding from hivecommons/vexa main

1. Land the change on hivecommons/vexa `main` (a PR, merged with a merge commit). The daily
   `quorum-upstream-sync.yml` merges upstream `main` in as well.
2. A push to `main` builds that commit (`quorum-images.yml`, `source=main`). To build by hand:
   `gh workflow run quorum-images.yml --repo hivecommons/vexa --ref main -f source=main -f ref=main`
   (or `-f ref=<sha>`).
3. The run's summary and its `digests` artifact list each image as
   `ghcr.io/hivecommons/vexa-<name>:main-<short sha>-quorum@sha256:...` with both platforms.
4. Open a PR here that sets `quorum.vexaCommit`, every tag and digest in `values.yaml`, and the
   transcription image in `transcription.yaml`. Pin `main-<short sha>-quorum` plus the digest,
   never the moving `main-quorum`. Then check out that commit and run `install.sh` and `smoke.sh`.

`source=release` (upstream release tag + our patches, `<tag>-quorum.N`) still exists for the
bot images, and with `images=all` for the control plane. It works only while our patches apply
to the release tag.

## Rollback

To the previous Helm revision (Secrets, PVCs and the tenant key are kept):

```bash
helm --kube-context hive-oke -n meetings history vexa
helm --kube-context hive-oke -n meetings rollback vexa <revision> --wait
```

The database is not rolled back: services migrate its schema forward at startup. Before the
0.12 to 0.13 upgrade a `pg_dumpall` was saved on the postgres volume
(`/var/lib/postgresql/data/backup/`).

To remove everything:

```bash
helm --kube-context hive-oke uninstall vexa -n meetings
kubectl --context hive-oke delete namespace meetings   # also deletes PVCs, Secrets, tenant keys
```
