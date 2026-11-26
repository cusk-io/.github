# dot-github

Shared GitHub infrastructure for cusk-io.

## Reusable Workflows

Import from external repos:

```yaml
jobs:
  my-job:
    uses: cusk-io/.github/.github/workflows/<workflow>.yml@<version>
    secrets: inherit
```

Replace `<version>` with a tag, branch, or SHA — e.g. `@main` or `@v1`.

Note: the duplicated `.github` in the path is intended: once for the repo name,
the other for the path within the repo.

## Workflows

| Workflow                                                             | Purpose                                     |
| -------------------------------------------------------------------- | ------------------------------------------- |
| [`docker-build-push`](.github/workflows/README.md#docker-build-push) | Build, test, and push Docker images to GHCR |
| [`ghcr-cleaner`](.github/workflows/README.md#ghcr-cleaner)           | Scheduled cleanup of stale GHCR images      |
| [`test-docker-build-push`](.github/workflows/README.md#self-tests)   | Self-test for `docker-build-push`           |

See [.github/workflows/README.md](.github/workflows/README.md) for each workflow's
inputs, outputs, and tagging behaviour.
