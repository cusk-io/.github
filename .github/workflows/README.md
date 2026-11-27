# Workflows

Reusable workflows (triggered via `workflow_call`) and their self-tests.

For how to import these from another repo, see the
[root README](../../README.md#reusable-workflows).

## Naming convention

Use the `test-` prefix for a workflow that tests a reusable workflow.
All reusable workflows are triggered via `workflow_call`; self-tests use `push`
and `workflow_dispatch`.

## docker-build-push

Builds one service from a compose file with `docker buildx bake`, runs the
compose `test` service, and only pushes branch/version tags after the tests pass.

| Input                | Required | Default              | Description                                       |
| -------------------- | -------- | -------------------- | ------------------------------------------------- |
| `image_name`         | yes      | –                    | Full image name, e.g. `ghcr.io/cusk-io/my-app`    |
| `compose_file`       | no       | `docker-compose.yml` | Compose file defining the build and test services |
| `build_service_name` | no       | `app`                | Compose service to build (must have a `build:`)   |
| `test_service_name`  | no       | `test`               | Compose service run as the test stage             |
| `timeout_minutes`    | no       | `5`                  | Timeout for the test job                          |

Output: `test_passed`.

Tags, in order:

- `sha-<7>` — pushed by every build.
- `latest` on the default branch, `branch-<name>` on other branches — pushed
  only if the tests pass (`/` in branch names becomes `-`).
- `X.Y.Z`, `X.Y`, and `X` for `vX.Y.Z` tags — pushed only if the tests pass.

Cache: `buildcache-<branch>` with `mode=max`, falling back to `latest`.

## npm-publish

Tests a Node package on a matrix of Node versions, then publishes it to the
public npm registry from a tag using [trusted publishing
(OIDC)](https://docs.npmjs.com/trusted-publishers) — no `NPM_TOKEN`. A GitHub
Release with generated notes is created afterwards.

Requires npm CLI >= 11.5.1 (Node 24 satisfies this) and the package's trusted
publisher on npmjs.com configured for the **calling** workflow's filename
(`release.yml` below), not for `npm-publish.yml`.

| Input                  | Required | Default            | Description                                                        |
| ---------------------- | -------- | ------------------ | ------------------------------------------------------------------ |
| `node-versions`        | no       | `["22","24"]`      | JSON array of Node versions for the test matrix                    |
| `publish-node-version` | no       | `24`               | Node version used to publish                                       |
| `working-directory`    | no       | `.`                | Directory containing `package.json`                                |
| `install-command`      | no       | `npm ci`           | Dependency install command                                         |
| `test-command`         | no       | `npm run test:run` | Test command, run once per matrix entry                            |
| `typecheck-command`    | no       | `npm run type-check` | Type check command; set to `''` to skip                          |
| `dry-run`              | no       | `false`            | Run everything except `npm publish` and the GitHub Release         |
| `create-release`       | no       | `true`             | Create a GitHub Release after publishing                           |
| `default-branch`       | no       | repository default | Branch the release tag must be an ancestor of                      |

No outputs.

Behaviour:

- The publish job only runs for tag refs, unless `dry-run` is set.
- Before publishing it verifies the npm CLI version, that the tag is an
  ancestor of the default branch, and that the tag (minus a leading `v`)
  equals `package.json`'s version. A tag cut from a feature branch is rejected.
- The caller must grant `id-token: write` (OIDC) and `contents: write` (release
  notes). Called workflows cannot request more than the caller allows, and
  GitHub validates this for every job in the called workflow — including jobs
  skipped by `if`. Granting `contents: write` is therefore required even when
  `create-release` is `false`.

Minimal caller:

```yaml
name: Release

on:
  push:
    tags: ['v*']

permissions:
  contents: write
  id-token: write

jobs:
  release:
    uses: cusk-io/.github/.github/workflows/npm-publish.yml@v0.2.0
    with:
      node-versions: '["22","24"]'
```

## Self-tests

- `test-docker-build-push.yml` — self-test for `docker-build-push`.
- `test-npm-publish.yml` — dry-run of `npm-publish` against
  `fixtures/npm-package`, so nothing is published.

## ghcr-cleaner

Not reusable — this repo's own scheduled workflow (daily 07:00 UTC, plus
`workflow_dispatch`) that removes stale images from GHCR using
[quartx-analytics/ghcr-cleaner](https://github.com/marketplace/actions/ghcr-cleaner).
Handles multi‑arch, multi‑stage, and BuildKit cache images without breaking them.

### Key Points

- **Truly untagged deletion** – only untagged images **not referenced** by any surviving tagged image are removed. References are extracted from OCI indexes and Docker manifest lists (covers multi‑arch images and `mode=max` build cache).
- **`filter-tags` vs `skip-tags`**:
  - `filter-tags` narrows which tagged images are considered by the `keep-at-most` retention limit.
  - `skip-tags` unconditionally protects tags from being deleted, even if they match `filter-tags`.
  - Tagged images that don’t match `filter-tags` (when set) are completely ignored by the retention rule and are **never deleted**; their untagged dependencies remain protected.
- **`keep-at-most`** keeps the _N_ most recent tagged images that pass `filter-tags` and aren’t skipped. All older matching ones are deleted.
- **Untagged protection chain**: dependencies are gathered **after** `keep-at-most` pruning, so only untagged images orphaned by the deletion of all their referencing tags become eligible for removal.

### Minimal Workflow

```yaml
- uses: quartx-analytics/ghcr-cleaner@v1
  with:
    owner-type: org
    token: ${{ secrets.PAT }}
    repository-owner: ${{ github.repository_owner }}
    delete-untagged: true
    keep-at-most: 5
    filter-tags: "sha-*" # only count these towards retention
    skip-tags: "latest,buildcache-*" # never delete these (redundant safety)
    dry-run: true
```
