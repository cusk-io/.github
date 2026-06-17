# dot-github

Shared GitHub infrastructure for cusk-io.

## Reusable Workflows

Import from external repos:

```yaml
jobs:
  my-job:
    uses: cusk/dot-github/.github/workflows/<workflow>.yml@<version>
    secrets: inherit
```

See [workflows/README.md](.github/workflows/README.md) for individual workflow docs.

## Workflows

| Workflow | Purpose |
|---|---|
| `docker-build-push` | Build and push Docker images to GHCR |
| `ghcr-cleaner` | Remove stale GHCR images |
| `test-docker-build-push` | Self-test for `docker-build-push` |