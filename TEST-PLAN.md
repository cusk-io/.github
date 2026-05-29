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
      - '.github/workflows/docker-build-push.yml'
      - '.github/workflows/test-docker-build-push.yml'
      - '.github/test-cases/**'
  workflow_dispatch: {}
```

Each case runs as an explicit independent job. All cases must pass for the overall run to succeed. Cases are not implemented as a matrix because `uses:` at job level (reusable workflow call) and `strategy: matrix:` are mutually exclusive in GitHub Actions — a job is either a reusable workflow call or a regular job with a matrix, not both.

```yaml
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
```

## 4. Test Case Structure

Every case is self-contained at `.github/test-cases/docker-build-push/<case-name>/`:

```
.github/test-cases/docker-build-push/
  case-01-valid-setup/
    docker-compose.yml   ← app (with dockerfile_inline) + test service
  case-02-bad-dockerfile/
    docker-compose.yml   ← app dockerfile_inline has syntax error
  case-03-missing-healthcheck/
    docker-compose.yml   ← no healthcheck defined — compose --wait will timeout
  case-04-test-script-fails/
    docker-compose.yml   ← test service exits non-zero
  case-05-image-name-wrong-scope/
    docker-compose.yml   ← app build succeeds, push fails (wrong org scope)
  case-06-missing-compose-file/
    # No fixture files needed — compose_file points to non-existent path
```

**Self-contained (intentional duplication):** Each case is a complete, independent snapshot. No base images, no shared fixtures. A single `docker-compose.yml` with `dockerfile_inline` replaces the need for separate Dockerfile and test script files.

**Image naming:** All test images are pushed to `ghcr.io/cusk-io/dot-github-test-docker-build-push-<case>`, e.g. `ghcr.io/cusk-io/dot-github-test-docker-build-push-case-01-valid-setup`. This keeps test images clearly segregated from production images in the `cusk-io` registry.

---

## 5. Case Definitions

| Case | Reusable workflow outcome | Rationale |
|---|---|---|
| case-01-valid-setup | All jobs succeed; SHA tag pushed | Baseline sanity check |
| case-02-bad-dockerfile | Build job fails | Detects broken Dockerfile escapes in dockerfile_inline |
| case-03-missing-healthcheck | Test job fails (compose --wait times out) | healthcheck is a required guard |
| case-04-test-script-fails | Test job fails | test service exit code is propagated |
| case-05-image-name-wrong-scope | Push fails (auth/permission error) | Workflow handles wrong-scope gracefully |
| case-06-missing-compose-file | Test job fails (file not found) | compose_file validation works |

---

## 6. Teardown Job

The `teardown` job uses `snok/container-retention-policy@v3` to delete all pushed test tags, preserving `buildcache-*` cache tags for subsequent builds:

```yaml
teardown:
  needs: [case-01-valid-setup]
  if: always()
  runs-on: ubuntu-latest
  steps:
    - uses: snok/container-retention-policy@v3
      with:
        account: cusk-io
        token: ${{ secrets.GHT_PAT_CONTAINER_RETENTION_POLICY }}
        image-names: dot-github-test-docker-build-push-case-01-valid-setup
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
- Each case has its own full package name (no wildcards in `image-names`); add one `uses:` step per case.
- Uses `${{ secrets.GHT_PAT_CONTAINER_RETENTION_POLICY }}` (PAT), not `GITHUB_TOKEN`, because the retention policy action requires a PAT with `packages: write` scope for org-level package operations.
- `dry-run: true` first to verify targeting before enabling actual deletion.

---

## 7. Design Decisions

**Why explicit jobs (not a matrix)?**
GitHub Actions does not allow `uses:` at job level to coexist with `strategy: matrix:` — a job is either a reusable workflow call (`uses:`) or a regular job (`runs-on`/`steps`/`strategy:`), not both. Explicit named jobs is the correct pattern. GitHub still runs independent jobs concurrently by default.

**Why self-contained cases with duplication?**
Shared base files would create hidden coupling — a change to a "base" file could silently fix or break multiple cases without an obvious diff. Self-contained snapshots make each case's contract explicit.

**Why multiple `--set` for cache sources?**
Buildx interprets each `--set key=value` as a replacement. When the same key appears multiple times (e.g., `--set app.cache-from=source1 --set app.cache-from=source2`), buildx merges them into a list. Space-separated values in a single `--set` are treated as a literal string, not multiple sources. Newline characters in env vars become literal `\n` in shell expansion, causing parse failures. One `--set` per cache source is the correct pattern.

**Why `docker buildx bake` instead of `docker/build-push-action`?**
Buildx bake reads compose files natively and supports `dockerfile_inline` for single-file case fixtures. The compose-based approach is simpler and more maintainable than separate Dockerfile + script + action config.

**Why test images are always pushed, even in failure cases?**
Some cases (02, 05) may fail before an image is pushed, but cases 01, 03, 04 will push one. Teardown cleans all images that were actually pushed. Cases that fail before push have nothing to clean.

**Why path-filtered `push` trigger instead of `workflow_call`?**
`workflow_call` is for when another workflow invokes this one. This test workflow is self-triggering — it runs on changes to the files it tests. The path filter ensures it only fires when relevant files change.

**Why `dot-github-test-` prefix on image names?**
The `cusk-io` org is where production images live. The `dot-github-test-` prefix keeps test images clearly distinguishable in the GitHub UI and prevents accidental pushes to production tag names.

**Why `image-tags: "!latest !buildcache-*"` in teardown?**
`buildcache-*` tags are the registry cache source for subsequent builds. Deleting them would force a full rebuild every run. `latest` is the fallback cache source used by all branches — keeping it out of the delete scope is safer.

---

## 8. Extensibility

Adding a new case requires changes in two places:

1. Create `.github/test-cases/docker-build-push/case-XX-<name>/docker-compose.yml`.
2. Add a new named job to `test-docker-build-push.yml`:
   ```yaml
   case-02-bad-dockerfile:
     uses: ./.github/workflows/docker-build-push.yml
     secrets: inherit
     with:
       image_name: ghcr.io/cusk-io/dot-github-test-docker-build-push-case-02-bad-dockerfile
       compose_file: ./.github/test-cases/docker-build-push/case-02-bad-dockerfile/docker-compose.yml
   ```
3. Add the new case name to the teardown's `needs:` list.

No other edits required. The teardown uses a separate `uses:` step per case package name, and the path filter on the `push` trigger already covers any new case directory.

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

## 10. Open Questions — Resolved

| # | Question | Resolution |
|---|---|---|
| 1 | Build approach | `docker buildx bake` reads compose natively, `dockerfile_inline` replaces separate Dockerfile files |
| 2 | Test execution | `docker compose run --rm test` — test service defined in compose, exit code propagated |
| 3 | Multiple cache-from | One `--set app.cache-from=...` per source, not space/comma/newline separated |
| 4 | Teardown | `snok/container-retention-policy` with `image-tags: "!latest !buildcache-*"` preserves cache tags |
| 5 | Jobs vs matrix | Explicit jobs required; `uses:` and `strategy: matrix:` are mutually exclusive |
| 6 | Discarded cases | case-05 (malformed image name) and case-08 (branch-tag rejects SHA) discarded |
| 4 | Failure = gate? | Yes — a failing case causes the overall run to fail, acting as a release gate |
| 5 | Image namespace | `ghcr.io/cusk-io/dot-github-test-docker-build-push-<case>` |