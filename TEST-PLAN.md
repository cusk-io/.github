# Plan: Test Workflow for `docker-build-push.yml`

## 1. Motivation

The `docker-build-push.yml` reusable workflow is a critical, high-privilege component — it builds and pushes images to `ghcr.io` under the `cusk-io` org. Bugs in it (e.g. a broken Dockerfile escaping validation and pushing garbage, or a missing healthcheck causing tests to pass prematurely) could corrupt production images or leak tokens. We need a dedicated test workflow that exercises the reusable workflow in isolation, against a range of misconfiguration cases, without polluting the repo root.

---

## 2. Placement

```
.github/
  workflows/
    docker-build-push.yml               ← existing reusable workflow
    test-docker-build-push.yml          ← NEW: the test orchestrator
  test-cases/                           ← NEW: all test fixtures live here
    docker-build-push/                  ← fixtures scoped to this workflow
      .gitkeep                          ← placeholder; remove when cases are added
    ghcr-cleaner/                       ← placeholder for future workflow tests
      .gitkeep
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

Each case runs as an independent parallel job. All cases must pass for the overall run to succeed.

```yaml
jobs:
  case:
    strategy:
      matrix:
        include:
          - case: case-01-valid-setup
            expected: success
          - case: case-02-bad-dockerfile
            expected: failure
          - case: case-03-missing-healthcheck
            expected: failure
          - case: case-04-test-script-fails
            expected: failure
          - case: case-05-malformed-image-name
            expected: failure
          - case: case-06-image-name-wrong-scope
            expected: failure
          - case: case-07-missing-compose-file
            expected: failure
          - case: case-08-branch-tag-rejects-sha
            expected: success
    runs-on: ubuntu-latest
    timeout-minutes: 2
    outputs:
      expected: ${{ matrix.expected }}
    steps:
      - name: Run ${{ matrix.case }}
        run: |
          echo "::notice::Running case ${{ matrix.case }}, expecting ${{ matrix.expected }}"

  teardown:
    needs: [case]
    if: always()

---

## 4. Test Case Structure

Every case is self-contained at `.github/test-cases/docker-build-push/<case-name>/`:

```
.github/test-cases/docker-build-push/
  .gitkeep
  case-01-valid-setup/
    Dockerfile           ← valid, builds successfully
    docker-compose.yml   ← valid, has working healthcheck
    test.sh              ← exits 0
  case-02-bad-dockerfile/
    Dockerfile           ← intentionally broken (syntax error, bad ENTRYPOINT, etc.)
    docker-compose.yml   ← valid (copied from case-01)
    test.sh              ← valid (copied from case-01)
  case-03-missing-healthcheck/
    Dockerfile           ← valid
    docker-compose.yml   ← no healthcheck defined — compose --wait will timeout
    test.sh              ← valid
  case-04-test-script-fails/
    Dockerfile           ← valid
    docker-compose.yml   ← valid
    test.sh              ← exits non-zero
  case-05-malformed-image-name/
    Dockerfile           ← valid
    docker-compose.yml   ← valid
    test.sh              ← valid
    # image_name set to something un-pushable, e.g. "-badname" or "a" (too short)
  case-06-image-name-wrong-scope/
    Dockerfile           ← valid
    docker-compose.yml   ← valid
    test.sh              ← valid
    # image_name set to a registry/path the token cannot write to,
    # e.g. ghcr.io/some-other-org/an-image
  case-07-missing-compose-file/
    # No fixture files needed — compose path points to a non-existent file
  case-08-branch-tag-rejects-sha/
    Dockerfile           ← valid
    docker-compose.yml   ← valid
    test.sh              ← valid
    # Triggered on a branch ref — push-branch-tag should be skipped (not fail)
```

**Self-contained (intentional duplication):** Each case is a complete, independent snapshot. No base images, no shared fixtures. This prevents a change to a "common" file from silently fixing or breaking multiple cases without that being obvious from a diff.

**Image naming:** All test images are pushed to `ghcr.io/cusk-io/dot-github-test-docker-build-push-<case>`, e.g. `ghcr.io/cusk-io/dot-github-test-docker-build-push-case-01-valid-setup`. This keeps test images clearly segregated from production images in the `cusk-io` registry and prevents tag collision with other workflow test suites.

**Context:** The reusable workflow is invoked with `context: .github/test-cases/docker-build-push/${{ matrix.case }}` so it builds the case's Dockerfile, not the repo root.

---

## 5. Case Definitions

| Case | Reusable workflow outcome | Expected overall job result | Rationale |
|---|---|---|---|
| 01-valid-setup | All jobs succeed; SHA tag pushed | **Success** | Baseline sanity check |
| 02-bad-dockerfile | Build job fails | **Failure** | Detects broken Dockerfile escapes |
| 03-missing-healthcheck | Test job fails (compose --wait times out) | **Failure** | healthcheck is a required guard |
| 04-test-script-fails | Test job fails | **Failure** | test_script exit code is respected |
| 05-malformed-image-name | Build or push fails (validation error) | **Failure** | Rejects syntactically invalid names |
| 06-image-name-wrong-scope | Push fails (auth/permission error) | **Failure** | Workflow handles wrong-scope gracefully |
| 07-missing-compose-file | Test job fails (file not found) | **Failure** | compose_file validation works |
| 08-branch-tag-rejects-sha | push-branch-tag skipped; no error | **Success** | Non-main-branch SHA-tag run does not push spurious tags |

**Timeout:** All case jobs have `timeout-minutes: 2`. This is well above what a locally-succeeding build/test/cleanup cycle should need (~30–60s in the common case) while catching hung compose waits or infinite build loops promptly. Individual cases can override this later if needed.

---

## 6. Teardown Job

The `teardown` job runs after all cases (via `needs:`), with `if: always()` so it fires even on cancellation or timeout. It deletes the specific test package versions it pushed to ghcr.io:

```yaml
teardown:
  needs: [case-01-valid-setup, ..., case-08-branch-tag-rejects-sha]
  if: always()
  runs-on: ubuntu-latest
  permissions:
    packages: write
  steps:
    - name: Delete test images
      env:
        CASES: case-01-valid-setup case-02-bad-dockerfile case-03-missing-healthcheck \
               case-04-test-script-fails case-05-malformed-image-name \
               case-06-image-name-wrong-scope case-07-missing-compose-file \
               case-08-branch-tag-rejects-sha
      run: |
        for case in $CASES; do
          gh api \
            --method DELETE \
            "https://ghcr.io/v2/cusk-io/dot-github-test-docker-build-push-${case}/ \
            --fail || true
        done
```

Key behaviors:
- `|| true` ensures one failed deletion does not abort cleanup of remaining images.
- `ghcr-cleaner.yml` already exists in this repo; this teardown is scoped only to the images this run created and does not replace or conflict with that workflow.
- Package version deletion requires `package: delete` permission on the org-level `packages` scope; `packages: write` on the job token is sufficient.

---

## 7. Design Decisions

**Why parallel jobs?**  
All eight cases are independent and self-contained. Running them in parallel keeps total wall-clock time near that of the slowest single case (~2 minutes). Sequential execution would multiply that by 8.

**Why self-contained cases with duplication?**  
Shared base files would create hidden coupling — a change to a "base" Dockerfile could silently fix or break multiple cases without an obvious diff. Self-contained snapshots make each case's contract explicit.

**Why test images are always pushed, even in failure cases?**  
Some cases (02, 05, 06, 07) may fail before an image is pushed, but cases 01 and 08 will push one. Teardown cleans all images that were actually pushed. Cases that fail before push have nothing to clean.

**Why path-filtered `push` trigger instead of `workflow_call`?**  
`workflow_call` is for when another workflow invokes this one. This test workflow is self-triggering — it runs on changes to the files it tests. The path filter ensures it only fires when relevant files change.

**Why `dot-github-test-` prefix on image names?**  
The `cusk-io` org is where production images live. The `dot-github-test-` prefix keeps test images clearly distinguishable and filterable in the GitHub UI, and prevents accidental pushes to production tag names (the test workflow never pushes to a tag without this prefix).

---

## 8. Extensibility

Adding a new case:

1. Create `.github/test-cases/docker-build-push/case-XX-<name>/` with the required fixture files.
2. Remove `.gitkeep` from `docker-build-push/` (if this is the first case).
3. Add `case-XX-<name>:` to the `needs:` list of the `teardown` job.
4. Add the `case-XX-<name>:` job block to `test-docker-build-push.yml`.
5. Add the case name to the `CASES` env var in the teardown job.
6. Commit. The next run (manual or on push) includes the new case.

No fixture framework, no script generation, no dynamic configuration — plain YAML and plain files. Auditable, disableable, and understandable at a glance.

Adding a test for a new workflow (e.g. `ghcr-cleaner`):

1. Create `.github/workflows/test-ghcr-cleaner.yml`.
2. Create `.github/test-cases/ghcr-cleaner/` and add cases.
3. The `test-cases/` directory now has two workflow-specific subdirectories with no coordination needed.

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
| 1 | Case 05 scope | Split into `case-05-malformed-image-name` and `case-06-image-name-wrong-scope` |
| 2 | Timeout per case | `timeout-minutes: 2`; adjustable per-case later |
| 3 | Cleanup | Teardown job, `if: always()`, unconditionally deletes pushed test images |
| 4 | Failure = gate? | Yes — a failing case causes the overall run to fail, acting as a release gate |
| 5 | Image namespace | `ghcr.io/cusk-io/dot-github-test-docker-build-push-<case>` |