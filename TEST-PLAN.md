# Plan: Test Workflow for `docker-build-push.yml`

## 1. Motivation

The `docker-build-push.yml` reusable workflow is a critical, high-privilege component — it builds and pushes images to `ghcr.io` under the `cusk-io` org. Bugs in it (e.g. a broken Dockerfile escaping validation and pushing garbage, or a missing healthcheck causing tests to pass prematurely) could corrupt production images or leak tokens. We need a dedicated test workflow that exercises the reusable workflow in isolation, against a range of misconfiguration cases, without polluting the repo root.

---

## 2. Placement

```
.github/
  workflows/
    docker-build-push.yml               ← reusable workflow under test
    test-docker-build-push.yml          ← test orchestrator
  test-cases/
    docker-build-push/                 ← fixtures scoped to this workflow
      case-01-valid-setup/            ← one compose file per case
```

**`.github/test-cases/`** is the base directory. Each tested workflow gets its own subdirectory, keeping fixtures scoped and preventing collisions when other workflows get their own test suites (e.g. a future `test-ghcr-cleaner.yml` would have fixtures at `.github/test-cases/ghcr-cleaner/`).

The orchestrator workflow lives in `.github/workflows/` alongside the thing it tests, consistent with GitHub's conventions for workflow files.

---

## 3. Orchestrator Workflow: `test-docker-build-push.yml`

Triggered manually (`workflow_dispatch`) and on pushes to any branch that touch the workflow under test or its fixtures:

```yaml
name: Test docker-build-push

on:
  push:
    paths:
      - ".github/workflows/docker-build-push.yml"
      - ".github/workflows/test-docker-build-push.yml"
      - ".github/test-cases/docker-build-push/**"
  workflow_dispatch: {}

permissions:
  contents: read
  packages: write

jobs:
  case-01-valid-setup:
    uses: ./.github/workflows/docker-build-push.yml
    secrets: inherit
    with:
      image_name: ghcr.io/cusk-io/dot-github-test-docker-build-push-case-01-valid-setup
      compose_file: ./.github/test-cases/docker-build-push/case-01-valid-setup/docker-compose.yml

  teardown:
    needs: [case-01-valid-setup]
    if: always()
    runs-on: ubuntu-latest
    strategy:
      matrix:
        include:
          - image_name: dot-github-test-docker-build-push-case-01-valid-setup
    steps:
      - uses: snok/container-retention-policy@v3.0.0
        with:
          account: cusk-io
          token: ${{ secrets.GHT_PAT_CONTAINER_RETENTION_POLICY }}
          image-names: ${{ matrix.image_name }}
          image-tags: "!latest !buildcache-*"
          tag-selection: tagged
          cut-off: 0s
          keep-n-most-recent: 0
          dry-run: false
```

---

## 4. Test Case Structure

Every case is self-contained at `.github/test-cases/docker-build-push/<case-name>/`:

```
.github/test-cases/docker-build-push/
  case-01-valid-setup/
    docker-compose.yml   ← app (with dockerfile_inline) + test service
```

**Self-contained (intentional duplication):** Each case is a complete, independent snapshot. No base images, no shared fixtures. A single `docker-compose.yml` with `dockerfile_inline` replaces the need for separate Dockerfile and test script files.

**Image naming:** All test images are pushed to `ghcr.io/cusk-io/dot-github-test-docker-build-push-<case>`, e.g. `ghcr.io/cusk-io/dot-github-test-docker-build-push-case-01-valid-setup`. This keeps test images clearly segregated from production images in the `cusk-io` registry.

---

## 5. Case Definitions

Only case-01 is currently implemented. Cases 02–06 are pending an architecture review (see Section 7).

| Case | Status | Reusable workflow outcome | Rationale |
|---|---|---|---|
| case-01-valid-setup | ✅ Active | All jobs succeed; SHA tag pushed | Baseline sanity check |
| case-02-bad-dockerfile | ❌ Discarded | Build job fails | Requires `continue-on-error` + output assertion pattern; revisit if needed |
| case-03-missing-healthcheck | 🔁 Pending | Test job fails (compose run fails) | Service-based model — `app` no longer requires healthcheck; pending case definition |
| case-04-test-script-fails | 🔁 Pending | Test job fails | Pending case definition |
| case-05-image-name-wrong-scope | ❌ Discarded | Push fails (auth/permission error) | Not a realistic failure scenario |
| case-06-missing-compose-file | 🔁 Pending | Test job fails (file not found) | Pending case definition |

---

## 6. Teardown Job

The `teardown` job uses `snok/container-retention-policy@v3` to delete all pushed test tags, preserving `buildcache-*` cache tags for subsequent builds:

```yaml
teardown:
  needs: [case-01-valid-setup]
  if: always()
  runs-on: ubuntu-latest
  strategy:
    matrix:
      include:
        - image_name: dot-github-test-docker-build-push-case-01-valid-setup
  steps:
    - uses: snok/container-retention-policy@v3.0.0
      with:
        account: cusk-io
        token: ${{ secrets.GHT_PAT_CONTAINER_RETENTION_POLICY }}
        image-names: ${{ matrix.image_name }}
        image-tags: "!latest !buildcache-*"
        tag-selection: tagged
        cut-off: 0s
        keep-n-most-recent: 0
        dry-run: false
```

Key behaviors:
- `image-tags: "!latest !buildcache-*"` — negate both patterns; delete everything EXCEPT `latest` and `buildcache-*`. This preserves the `buildcache-<branch>` tags that subsequent builds will import from.
- `tag-selection: tagged` — only tagged versions. Untagged/dangling images are handled separately by GHCR's own garbage collection.
- `cut-off: 0s` / `keep-n-most-recent: 0` — no retention, delete everything matching immediately.
- Uses `${{ secrets.GHT_PAT_CONTAINER_RETENTION_POLICY }}` (PAT), not `GITHUB_TOKEN`, because the retention policy action requires a PAT with `packages: write` scope for org-level package operations.

---

## 7. Design Decisions

**Why explicit jobs (not a matrix)?**
GitHub Actions does not allow `uses:` at job level to coexist with `strategy: matrix:` — a job is either a reusable workflow call (`uses:`) or a regular job (`runs-on`/`steps`/`strategy:`), not both. Explicit named jobs is the correct pattern for case jobs. The teardown job is a regular `runs-on` job, so it uses a matrix freely.

**Why self-contained cases with duplication?**
Shared base files would create hidden coupling — a change to a "base" file could silently fix or break multiple cases without an obvious diff. Self-contained snapshots make each case's contract explicit.

**Why multiple `--set` for cache sources?**
Buildx interprets each `--set key=value` as a replacement. When the same key appears multiple times (e.g., `--set app.cache-from=source1 --set app.cache-from=source2`), buildx merges them into a list. Space-separated values in a single `--set` are treated as a literal string, not multiple sources. One `--set` per cache source is the correct pattern.

**Why `docker buildx bake` with `dockerfile_inline`?**
Buildx bake reads compose files natively and supports `dockerfile_inline` for single-file case fixtures. The compose-based approach is simpler and more maintainable than separate Dockerfile + script + action config.

**Why `dot-github-test-` prefix on image names?**
The `cusk-io` org is where production images live. The `dot-github-test-` prefix keeps test images clearly distinguishable in the GitHub UI and prevents accidental pushes to production tag names.

**Why `image-tags: "!latest !buildcache-*"` in teardown?**
`buildcache-*` tags are the registry cache source for subsequent builds. Deleting them would force a full rebuild every run. `latest` is the fallback cache source used by all branches — keeping it out of the delete scope is safer.

---

## 8. Extensibility

Adding a new case requires changes in three places:

1. Create `.github/test-cases/docker-build-push/case-XX-<name>/docker-compose.yml`.
2. Add a new named job to `test-docker-build-push.yml`:
   ```yaml
   case-02-some-new-case:
     uses: ./.github/workflows/docker-build-push.yml
     secrets: inherit
     with:
       image_name: ghcr.io/cusk-io/dot-github-test-docker-build-push-case-02-some-new-case
       compose_file: ./.github/test-cases/docker-build-push/case-02-some-new-case/docker-compose.yml
   ```
3. Add the new case name to the teardown's `needs:` list.
4. Add an entry to the teardown's `strategy.matrix.include`.

Adding a test for a new workflow (e.g. `ghcr-cleaner`):

1. Create `.github/workflows/test-ghcr-cleaner.yml` with its own case jobs.
2. Create `.github/test-cases/ghcr-cleaner/` and add cases.
3. The two workflow-specific fixture directories coexist with no coordination needed.

---

## 9. Trigger Summary

| File changed | Test runs? |
|---|---|
| `.github/workflows/docker-build-push.yml` | Yes |
| `.github/workflows/test-docker-build-push.yml` | Yes |
| Any file under `.github/test-cases/docker-build-push/` | Yes |
| Any file under `.github/test-cases/ghcr-cleaner/` | Yes (future) |
| `README.md`, `ghcr-cleaner.yml`, etc. | No |
| `workflow_dispatch` (manual) | Always |

---

## 10. Architecture — Implemented (Profiles Approach)

The reusable workflow uses **Docker Compose profiles** to separate the build stage (`app` service) from the test stage (`test` service with `profiles: [test]`).

### Compose file contract

```yaml
services:
  app:
    build:
      context: .
      dockerfile_inline: |
        FROM alpine:3.19
        ...
    image: ${IMAGE:-${COMPOSE_PROJECT_NAME}-app}:${TAG:-latest}
    # healthcheck optional — if present, test service can use:
    #   depends_on:
    #     app:
    #       condition: service_healthy

  test:
    image: ${IMAGE:-${COMPOSE_PROJECT_NAME}-app}:${TAG:-latest}
    # profiles: [test]  # optional; only useful if test should be excluded from `docker compose up` by default
```

**`app` service:** Built by `docker buildx bake app` (or whatever `service_name` specifies). Never started by compose in the test stage. A healthcheck is optional — it only matters if `test` expresses a `service_healthy` dependency on `app`.

**`test` service:** Must be named `test`. Has an `image:` key (not `build:`), so compose will pull it implicitly. `profiles: [test]` is supported but not required — `docker compose run --rm test` explicitly names the service and does not filter by profile.

> **Note:** `service_name` (default `app`) controls what gets **built** by bake. The test service is always **`test`** (fixed name). The compose file must contain both a service matching `service_name` (with a `build:` block) and a service named `test`.

**Variable defaults:** `${IMAGE:-${COMPOSE_PROJECT_NAME}-app}:${TAG:-latest}` enables local dev without pre-set env vars. Compose will re-interpolate nested defaults, so if `IMAGE` is unset, the fallback resolves to `{COMPOSE_PROJECT_NAME}-app:latest`.

### Build stage (unchanged contract)

```bash
docker buildx bake --push \
  --set app.cache-from=... \
  --set app.cache-to=... \
  --set app.tags=${IMAGE}:${SHA_TAG} \
  --file compose.yml \
  app
```

### Test stage (simplified)

```bash
docker compose -f compose.yml run --rm test
```

- `docker compose run --rm test` explicitly targets the `test` service by name
- `app` is never started in the test stage, so no healthcheck is required on `app`
- Compose implicitly pulls the `${IMAGE}:${TAG}` image if not cached locally
- Compose implicitly pulls the `${IMAGE}:${TAG}` image if not cached locally
- `docker compose down --volumes` cleans up any started services

### Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `image_name` | Yes | — | Full image name, e.g. `ghcr.io/cusk-io/my-app` |
| `compose_file` | No | `docker-compose.yml` | Path to the compose file defining build and test services |
| `service_name` | No | `app` | Docker compose service name to build (must have a `build:` block) |
| `timeout_minutes` | No | `5` | Timeout for the test job in minutes |

---

## 11. Open Questions — Resolved

| # | Question | Resolution |
|---|---|---|
| 1 | Build approach | `docker buildx bake` reads compose natively, `dockerfile_inline` replaces separate Dockerfile files |
| 2 | Test execution | `docker compose run --rm test` — test service has `profiles: [test]`, auto-activated; app is never started |
| 3 | Multiple cache-from | One `--set app.cache-from=...` per source, not space/comma/newline separated |
| 4 | Teardown | `snok/container-retention-policy` with `image-tags: "!latest !buildcache-*"` preserves cache tags |
| 5 | Jobs vs matrix | Explicit jobs required for `uses:` (reusable workflow call); matrix allowed on regular `runs-on` jobs |
| 6 | Discarded cases | case-02 (bad-dockerfile), case-05 (wrong-scope) discarded |
| 7 | Teardown matrix | Matrix works in teardown because it uses step-level `uses:` (action), not job-level `uses:` (reusable workflow call) |
| 8 | App healthcheck | Optional — app is never started in test stage via compose; only needed if test expresses `service_healthy` dependency |
| 9 | Local dev without env vars | `${IMAGE:-${COMPOSE_PROJECT_NAME}-app}:${TAG:-latest}` — nested substitution works in compose; `COMPOSE_PROJECT_NAME` auto-derived |
| 10 | Test stage no longer needs `up --wait` | Removed — `docker compose run --rm test` activates `test` profile automatically |
| 11 | `service_name` input | Kept — build targets `service_name` (default `app`) via `inputs.service_name` |
| 12 | Test timeout | `timeout_minutes` input (default 5) passed through to `timeout-minutes` on test job |