# GHCR cleanup of stale docker images with `ghcr-cleaner`

Safely remove stale images from GHCR using [quartx-analytics/ghcr-cleaner](https://github.com/marketplace/actions/ghcr-cleaner).  
Handles multi‑arch, multi‑stage, and BuildKit cache images without breaking them.

## Key Points

- **Truly untagged deletion** – only untagged images **not referenced** by any surviving tagged image are removed. References are extracted from OCI indexes and Docker manifest lists (covers multi‑arch images and `mode=max` build cache).
- **`filter-tags` vs `skip-tags`**:
  - `filter-tags` narrows which tagged images are considered by the `keep-at-most` retention limit.
  - `skip-tags` unconditionally protects tags from being deleted, even if they match `filter-tags`.
  - Tagged images that don’t match `filter-tags` (when set) are completely ignored by the retention rule and are **never deleted**; their untagged dependencies remain protected.
- **`keep-at-most`** keeps the _N_ most recent tagged images that pass `filter-tags` and aren’t skipped. All older matching ones are deleted.
- **Untagged protection chain**: dependencies are gathered **after** `keep-at-most` pruning, so only untagged images orphaned by the deletion of all their referencing tags become eligible for removal.

## Minimal Workflow

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
