# hive-mx on hive-oke: mail in for hive

hive-mx is hive's receive-only mail receiver (hivecommons/hive#18395, plan #18391). People invite
Betty by adding `hive@<hive dashboard host>` (for example `hive@acme.hive.hivecommons.dev`) to a
calendar invite, prove their calendar emails, and mail Markdown, audio and image files into a
hive's Inbox. One receiver serves every hive on the cluster through a wildcard MX record; no spoke
opens port 25.

hive-mx runs in namespace `mail` and touches nothing else, except one key it can add to the hub's
Secret (see "Hub" below) and one read-only Role and RoleBinding in `hive-hub` for the STARTTLS
certificate (see "STARTTLS" below).

| File             | What it is                                                                         |
| ---------------- | ---------------------------------------------------------------------------------- |
| `namespace.yaml` | Namespace `mail` (Pod Security restricted, enforced)                               |
| `policy.yaml`    | NetworkPolicy: SMTP in from anywhere; egress only to CoreDNS and the hub Service   |
| `hive-mx.yaml`   | Deployment (2 replicas), PodDisruptionBudget, Service type LoadBalancer on port 25 |
| `tls-sync.yaml`  | Hourly CronJob and least-privilege RBAC that copy the wildcard cert for STARTTLS   |
| `install.sh`     | Idempotent install/upgrade; generates the hub bearer token once, never prints it   |

## What hive-mx does

- Accepts `RCPT TO` only for `hive@<host>` where the host is a hive the hub knows (subdomain, vanity
  or dashboard host). The list comes from `GET /api/mail/hosts` on the hub every 60 seconds; until
  the first list loads, RCPT gets a temporary 451.
- At most 5 recipients and 2 MB per message, per-IP and per-sender-domain rate limits, at most 100
  connections, no AUTH, no relay. It never sends mail.
- After DATA it records SPF, DKIM and DMARC alignment, keeps only calendar invites (scheduling
  fields and join details), Markdown/audio/image attachments, or a proof code, and posts the result
  to `POST /api/mail/inbound` on the hub. The hub signs it with the target hive's relay key and
  forwards it; it stores nothing. A hub or spoke that cannot take the mail makes hive-mx answer a
  temporary 451, so the sender's server retries.

## Versions (pinned by tag and digest)

| Component | Image                                                                                                                                                                                    |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| hive-mx   | `ghcr.io/hivecommons/hive-mx:aa286e8@sha256:bbed51d5f92fe208f566ca19b2dab54e14a5985481dcb6ae0c1893ef9d6c764f` (manifest list, linux/amd64 and linux/arm64; distroless static, uid 65532) |

Built from `src/Dockerfile.mx` in hivecommons/hive by `docker.yml` (`build-mx`, `merge-mx`). Every
hive-oke node is arm64. Update by changing both the tag and the digest in `hive-mx.yaml`.

## Install

```sh
KUBE_CONTEXT=hive-oke deploy/hive-oke/mail/install.sh --hub-secret
```

`install.sh` applies the namespace, creates Secret `mail/hive-mx-hub-token` with a random token if it
does not exist, and with `--hub-secret` copies the same value into key `mail-token` of Secret
`hive-hub/hive-hub-secrets`. Then it applies the policy and the Deployment and prints the Service.

## Hub

The hub's mail endpoints answer 404 until it has `HIVE_HUB_MAIL_TOKEN`. That needs one env entry on
the `hub` container of Deployment `hive-hub/hive-hub`, which rolls the hub, so it is an operator
step:

```sh
kubectl --context hive-oke -n hive-hub patch deployment hive-hub --type json -p '[
  {"op":"add","path":"/spec/template/spec/containers/1/env/-","value":
    {"name":"HIVE_HUB_MAIL_TOKEN","valueFrom":{"secretKeyRef":{"name":"hive-hub-secrets","key":"mail-token"}}}}
]'
```

(container index 1 is `hub`; check with
`kubectl -n hive-hub get deploy hive-hub -o jsonpath='{.spec.template.spec.containers[*].name}'`).
The hub must also run a build that has `/api/mail/*` (hivecommons/hive#18395 part 3).

## DNS

hivecommons.dev DNS is on DNSimple; these two records are added by the operator:

| Type | Name                      | Value                     | Priority |
| ---- | ------------------------- | ------------------------- | -------- |
| A    | `mx.hive.hivecommons.dev` | the Service's external IP | n/a      |
| MX   | `*.hive.hivecommons.dev`  | `mx.hive.hivecommons.dev` | 10       |

The root `hivecommons.dev` MX (a legacy mailbox) is left alone.

## Load balancer

The Service is an OCI Network Load Balancer (`oci.oraclecloud.com/load-balancer-type: nlb`) in the
same subnet as ingress-nginx, with `externalTrafficPolicy: Local`, so hive-mx sees the sender's IP
(SPF and the per-IP rate limit need it). The node security list or NSG must allow TCP 25 to the
Service's node port from the internet.

## STARTTLS

hive-mx offers STARTTLS (TLS 1.2 minimum) with the wildcard certificate `*.hive.hivecommons.dev`,
which covers `mx.hive.hivecommons.dev`. cert-manager issues it as Certificate `hive-wildcard-tls` in
namespace `hive-hub`; the cluster has no reflector, so `tls-sync.yaml` copies it:

- CronJob `mail/hive-mx-tls-sync` runs hourly (minute 17) and writes Secret `mail/hive-mx-tls` only
  when the certificate's SHA-256 differs from the copy's `hive.hivecommons.dev/source-cert-sha256`
  annotation. It never prints key material.
- Its ServiceAccount can `get` only Secret `hive-hub/hive-wildcard-tls` (Role and RoleBinding
  `hive-mx-tls-sync-read` in `hive-hub`, the only objects outside `mail`) and
  `get`/`create`/`update`/`patch` only Secret `mail/hive-mx-tls` (Role `hive-mx-tls-sync-write`). It
  writes with server-side apply, so `create` is authorized against that one name.
- The Deployment mounts `hive-mx-tls` read-only (no `subPath`) and sets `HIVE_MX_TLS_CERT` and
  `HIVE_MX_TLS_KEY`. hive-mx re-reads the certificate when the file changes and the kubelet refreshes
  the mounted Secret in place, so a renewal reaches hive-mx within about an hour plus the kubelet sync
  period, with no rollout. The job has no rights on the Deployment.

`install.sh` applies `tls-sync.yaml` and, when `mail/hive-mx-tls` does not exist yet, seeds it once
with a Job made from the CronJob. To force a copy by hand:

```sh
kubectl --context hive-oke -n mail create job --from=cronjob/hive-mx-tls-sync hive-mx-tls-sync-manual
```

The CronJob image is `docker.io/alpine/kubectl:1.34.2@sha256:96a7d245a74d461925a56e3024d2f027c2a7a822b3e9e0117ec558db42de9c35`
(kubectl plus busybox; `registry.k8s.io/kubectl` has no shell).

### TLS posture

Decided in hivecommons/hive#18503 (closed as not planned):

- STARTTLS is offered with the wildcard certificate, and it stays opportunistic: a sender that does
  not use it is still accepted.
- MTA-STS (and TLS-RPT) is not published, because each hive host is its own mail domain
  (`hive@<host>`), so a policy would be needed per host.
- Senders are trusted through SPF, DKIM and aligned DMARC, plus the allowlisted organizer, not
  through the transport.

## Check

```sh
kubectl --context hive-oke -n mail get pods,svc
kubectl --context hive-oke -n mail logs deploy/hive-mx | tail
```

`/readyz` is 503 until the first host list loaded from the hub; the logs carry only delivery ids,
kinds and DMARC results, never message content.
