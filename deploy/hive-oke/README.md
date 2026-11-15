# Shared Vexa service on hive-oke

Quorum (RFC #1) uses one shared Vexa control plane per cluster. On hive-oke it runs in namespace
`meetings`, and nothing outside that namespace is touched. The only cluster-scoped object is the
`meetings` Namespace.

| File                 | What it is                                                                             |
| -------------------- | -------------------------------------------------------------------------------------- |
| `namespace.yaml`     | Namespace `meetings` (Pod Security baseline in warn/audit mode)                        |
| `values.yaml`        | Helm values for the Vexa chart, plus the `quorum` block read by `install.sh`           |
| `versitygw.yaml`     | In-namespace S3 endpoint (versitygw, POSIX backend on a 50Gi `oci-bv` PVC), bucket Job |
| `transcription.yaml` | CPU Whisper (faster-whisper `small`, int8) Deployment and Service                      |
| `policy.yaml`        | LimitRange and gateway NetworkPolicy                                                   |
| `install.sh`         | Idempotent install/upgrade: Secrets, policy, ResourceQuota, storage, STT, Helm, tenant |
| `smoke.sh`           | Smoke test with the tenant key from a throwaway Pod                                    |

## Versions (all pinned by tag and digest)

| Component                                | Image                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Chart                                    | `deploy/helm/charts/vexa` from hivecommons/vexa tag `v0.12.28` (chart 0.12.2, appVersion 0.12.28) |
| gateway, admin-api, meeting-api, runtime | `docker.io/vexaai/v012-*:v0.12.28` (upstream, amd64 + arm64)                                      |
| meeting bot                              | `ghcr.io/hivecommons/vexa-bot:v0.12.28-quorum.1`                                                  |
| CPU transcription                        | `ghcr.io/hivecommons/vexa-transcription-cpu:v0.12.28-quorum.1`                                    |
| postgres                                 | `docker.io/library/postgres:17.11-alpine`                                                         |
| redis                                    | `docker.io/valkey/valkey:8.1.11-alpine`                                                           |
| S3                                       | `docker.io/versity/versitygw:v1.10.0`                                                             |

Upstream publishes `vexaai/vexa-bot` for amd64 only and no CPU transcription image. Every
hive-oke node is arm64, so hivecommons/vexa builds both for amd64 and arm64
(`.github/workflows/quorum-images.yml`). Images must be fully qualified (`docker.io/...`)
because hive-oke runs CRI-O with short-name mode set to enforcing.

## What runs

- Control plane: gateway x2, admin-api x2, meeting-api x2, runtime x1 (k8s backend, namespaced
  Role only), postgres, redis. agent-api, terminal, and dashboard are disabled: Quorum needs none
  of them, so no model credentials live here.
- All Services are ClusterIP. There is no Ingress, LoadBalancer, or NodePort (the ResourceQuota
  also caps `services.loadbalancers` and `services.nodeports` at 0).
- Bots: one bare Pod per meeting, created by the runtime. Each is Guaranteed at 1 CPU / 2560Mi
  (`runtime.workloadResources.meetingBot`) and pinned to `kubernetes.io/arch: arm64`.
- Transcription: `vexa-transcription:8000`, 2-4 CPU / 2-4Gi. It needs `TRANSCRIPTION_SERVICE_TOKEN`.

## Privacy defaults

- `RECORDING_ENABLED=false`: no audio or video recording unless a request explicitly asks for it.
- The captured-signal tape (raw capture fixture uploads, upstream default ON) is turned off
  fleet-wide by `install.sh` through admin-api `PUT /internal/settings/diagnostics
{"capture_signal": "false"}`.
- Bot display name: "Hive notes (AI notetaker)".

## Limits

- `quorum.maxConcurrentBots: 4` in `values.yaml` is the single source. It is enforced in two places:
  - ResourceQuota `meetings-quota` sets `pods` = `controlPlanePods` (11) + 4. A quota cannot select
    only bot Pods, so while a rollout surges or an ops Pod runs, that Pod uses a bot slot, and
    a rollout waits for a free slot.
  - The tenant user's `max_concurrent_bots` in admin-api, set to the same value.
- LimitRange `meetings-defaults` sets defaults for containers without resources: 1-1.5 CPU,
  1100Mi-2560Mi, per upstream bot guidance. The per-container max is 4 CPU / 6Gi.

## Network

NetworkPolicy `vexa-gateway-ingress` allows gateway ingress (TCP 8000) only from namespaces
with the label key `hive.kubestellar.io/hive-id`, and from `meetings`.

**hive-oke runs flannel, which does not enforce NetworkPolicy.** The policy records intent and
starts working only if the CNI changes. The real boundary is the per-tenant Vexa API key: the
bot, meeting, and transcript routes require `X-API-Key` (scopes `bot` / `tx`), and each tenant
sees only its own meetings.

## Secrets (names only; values are random, created by install.sh, never in git)

| Secret                         | Keys                                                                                                                                                                                   | Used by                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `vexa-admin`                   | `ADMIN_API_TOKEN`, `INTERNAL_API_SECRET`, `TRANSCRIPTION_SERVICE_TOKEN`, `VEXA_DISPATCH_SIGNING_KEY`, `NEXTAUTH_SECRET`, `VEXA_SERVICE_AUTHORITY_SECRET`, `VEXA_SYSTEM_WEBHOOK_SECRET` | chart (`secrets.existingSecretName`), transcription                                      |
| `vexa-s3`                      | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`                                                                                                                                           | chart (`storage.s3.existingSecret`), versitygw root user                                 |
| `vexa-tenant-hivecommons-hive` | `api-key`                                                                                                                                                                              | hive's hive (hosted hive `hosted-available-oke-11-placeholder-r05x`); scopes `bot`, `tx` |
| `postgres-credentials`         | chart-managed                                                                                                                                                                          | postgres                                                                                 |

The admin credential is `ADMIN_API_TOKEN` (header `X-Admin-API-Key` on admin-api). Following
the upstream Kubernetes docs, it is minted at install time and kept in `vexa-admin`.

## Install / upgrade

```bash
git clone --branch v0.12.28 https://github.com/hivecommons/vexa.git /tmp/vexa-v0.12.28
KUBE_CONTEXT=hive-oke VEXA_CHART=/tmp/vexa-v0.12.28/deploy/helm/charts/vexa ./install.sh
KUBE_CONTEXT=hive-oke ./smoke.sh
```

New tenant: run admin-api `POST /admin/users` (with `max_concurrent_bots`), then
`POST /admin/users/{id}/tokens` with `{"scopes": ["bot", "tx"]}`, from inside the admin-api Pod
(see `install.sh`). Store the key in `vexa-tenant-<tenant>`.

## Upgrading to a new upstream release

1. hivecommons/vexa syncs upstream `main` daily (`quorum-upstream-sync.yml`). For each new
   upstream release it builds `ghcr.io/hivecommons/vexa-bot` and `vexa-transcription-cpu` as
   `<tag>-quorum.N` automatically.
2. The cluster does not follow by itself. Open a PR here that bumps every pinned tag and digest
   in `values.yaml` and `transcription.yaml` (and the chart tag in the install command), then run
   `install.sh` and `smoke.sh`.

## Rollback

```bash
helm --kube-context hive-oke uninstall vexa -n meetings
kubectl --context hive-oke delete namespace meetings   # also deletes PVCs, Secrets, tenant keys
```
