# Runbook: rolling back a bad quorum release

A `v<version>` tag push runs `.github/workflows/release.yml`, which lints,
typechecks, tests, builds, smoke-tests on amd64 and arm64, and then creates a
GitHub release carrying `quorum.mjs` and `quorum.mjs.sha256`. Nothing is
published to npm. CI cannot catch everything (a real Vexa or Discord
interaction, a deployment-specific failure), so this covers a bad version that
has already been released.

## Who is affected

Anyone running the downloaded `quorum.mjs`, including the `hive-oke`
deployment. A bad release can drop live meeting participation (join, speak,
transcript, `/events`), so treat it as user-impacting.

## Detect

- `GET /healthz` on the loopback port answers `{ ok, version, contract }`. It
  proves the process is up and which version runs; it does not check Vexa or
  Discord, so a healthy answer does not rule out a regression.
- `gh release list --repo hivecommons/quorum` shows what shipped.
- Check open issues for reports naming the new version.

## Contain

1. **Pin the last good bundle.** Download it and verify the checksum:
   ```sh
   curl -fsSLO https://github.com/hivecommons/quorum/releases/download/v<last-good>/quorum.mjs
   curl -fsSLO https://github.com/hivecommons/quorum/releases/download/v<last-good>/quorum.mjs.sha256
   sha256sum -c quorum.mjs.sha256
   ```
2. **Reinstall it** where the bad one runs (for example `/opt/quorum/quorum.mjs`)
   and restart the process. Keep `@snazzah/davey` installed next to it at the
   version that release's `package-lock.json` pins.
3. **Mark the bad release** so nobody downloads it by accident:
   ```sh
   gh release edit v<bad-version> --repo hivecommons/quorum --prerelease \
     --notes "Known issue: <short description>. Use v<last-good>."
   ```
4. **Do not delete the release or move its tag.** Consumers may have pinned the
   URL or checksum; deleting breaks them and a moved tag breaks reproducibility.

## Fix forward

1. Branch from `main`, fix the regression and add a regression test.
2. Bump `version` in `package.json` and `src/version.ts` and merge through the
   normal PR process.
3. Push tag `v<new-version>`. If the workflow fails before publishing, fix the
   cause and re-run it rather than re-tagging.

## After

- `curl` the running instance's `/healthz` and confirm `version` is the intended
  one, then run a real `meeting.join` against a test meeting.
- Record the rollback steps actually used in the issue or PR that tracked the fix.
