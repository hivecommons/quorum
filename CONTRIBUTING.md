# Contributing to Quorum

Every commit must carry a Developer Certificate of Origin sign-off (`git commit -s`), certifying you have the right to submit the change under the project license. See https://developercertificate.org/.

Open an issue before large changes. Keep pull requests focused, with tests for new behaviour.

## Finding something to work on

- Issues labelled [`good first issue`](https://github.com/hivecommons/quorum/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) are scoped for a first PR; [`help wanted`](https://github.com/hivecommons/quorum/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) issues are open to anyone.
- Not sure where to start, or want to check an approach before writing code? Ask in the [Hive Commons Discord](https://hivecommons.dev/discord) or bring it to the biweekly [Hive Commons community meeting](https://docs.hivecommons.dev/docs/community/meetings).

## Before you open a pull request

- Run the checks in [README.md, Local development](README.md#local-development): `npm run lint`, `npm run typecheck`, `npm run test:coverage` (90% lines and branches on `src/`), `npm run build` and `npm run smoke`. CI runs the same checks and the DCO check on every commit.
- Tools, events and the hive API are fixed in [docs/contract.md](docs/contract.md) (`quorum.contract/v1`), which hive and Spektacular build against. A change to any of them updates that file in the same pull request.
