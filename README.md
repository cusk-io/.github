# cusk-io/.github

Shared GitHub infrastructure for [cusk-io](https://github.com/cusk-io), sometimes
referred to as "dot-github".

## Reusable Workflows

Import from external repos:

```yaml
jobs:
  my-job:
    uses: cusk-io/.github/.github/workflows/<workflow>.yml@<version>
    secrets: inherit
```

Replace `<version>` with a tag, branch, or commit SHA. Prefer a tag (for example
`@v0.2.0`): it keeps consumers stable, whereas `@main` pushes every change to
every repository immediately. Use a SHA when you need immutability.

Note: the duplicated `.github` in the path is intended: once for the repo name,
the other for the path within the repo.

## Workflows

| Workflow                                                             | Purpose                                     |
| -------------------------------------------------------------------- | ------------------------------------------- |
| [`docker-build-push`](.github/workflows/README.md#docker-build-push) | Build, test, and push Docker images to GHCR |
| [`npm-publish`](.github/workflows/README.md#npm-publish)             | Test, then publish an npm package via OIDC  |
| [`ghcr-cleaner`](.github/workflows/README.md#ghcr-cleaner)           | Scheduled cleanup of stale GHCR images      |
| [`test-docker-build-push`](.github/workflows/README.md#self-tests)   | Self-test for `docker-build-push`           |
| [`test-npm-publish`](.github/workflows/README.md#self-tests)         | Self-test for `npm-publish`                 |

See [.github/workflows/README.md](.github/workflows/README.md) for each workflow's
inputs and behaviour.

## Repo layout

| Path                   | Contents                                                    |
| ---------------------- | ----------------------------------------------------------- |
| `.github/workflows/`   | Reusable workflows (`workflow_call`) and `test-*` self-tests |
| `fixtures/`            | Sample projects used by the self-tests                      |

## Releasing changes

Consumers pin a tag, so changes only reach them when you tag this repository:

1. Merge to `main`; the self-tests run on every push.
2. Tag the merge commit and push it:

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push github vX.Y.Z
   ```

`v*` tags are protected by a repository ruleset: only repository admins can
create, move, or delete them, so a tag always resolves to the commit that
consumers reviewed. If you add non-admin maintainers, give them the maintainer
role or add a bypass actor for the tag ruleset.

Treat renamed or removed inputs as breaking changes, and mention the new tag in
the callers you update.
