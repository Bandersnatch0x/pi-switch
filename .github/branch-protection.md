# Branch & tag protection

This repository combines **GitHub Rulesets** and **classic branch protection**.

> Note: the ruleset `pull_request` rule returned HTTP 422 on this personal repository via the REST API, so PR requirements are enforced with **classic branch protection** instead. Tag protection uses rulesets.

## Active policy

### A. Classic branch protection — `main`

| Setting | Value |
|---|---|
| Required status checks | **Test** (strict / up-to-date) |
| Require pull request | yes |
| Required approvals | **0** (solo-friendly; still forces PR workflow) |
| Dismiss stale reviews | yes |
| Require conversation resolution | yes |
| Allow force pushes | **no** |
| Allow deletions | **no** |
| Enforce for admins | **no** (admin emergency push allowed) |

Source snapshot: `.github/classic-main-protection.json`

### B. Ruleset — Protect main

| Setting | Value |
|---|---|
| Target | `refs/heads/main` |
| Enforcement | active |
| Block force push | yes (`non_fast_forward`) |
| Block deletion | yes |
| Required checks | **Test** (strict) |
| Bypass | repository **Admin** (always) |

Source snapshot: `.github/ruleset-main.json`

### C. Ruleset — Protect release tags

| Setting | Value |
|---|---|
| Target | tags `refs/tags/v*` |
| Enforcement | active |
| Block force push / retarget | yes |
| Block deletion | yes |
| Bypass | repository **Admin** (always) |

Source snapshot: `.github/ruleset-tags.json`

## Workflow

1. Create a feature branch and open a PR into `main`.
2. Wait for CI job **Test** (`.github/workflows/ci.yml`) to pass.
3. Resolve review conversations, then merge (merge / squash / rebase all allowed).
4. Release: tag `vX.Y.Z` matching `package.json` version and push the tag. CI publishes to npm.
5. Do **not** delete or move `v*` tags (ruleset blocks; Admin can bypass).

## Apply / refresh

```bash
# Classic main protection
gh api repos/Bandersnatch0x/pi-switch/branches/main/protection \
  --method PUT --input .github/classic-main-protection.json

# Rulesets (create if missing)
gh api repos/Bandersnatch0x/pi-switch/rulesets --method POST --input .github/ruleset-main.json
gh api repos/Bandersnatch0x/pi-switch/rulesets --method POST --input .github/ruleset-tags.json

# Inspect
gh api repos/Bandersnatch0x/pi-switch/branches/main/protection --jq "{checks: .required_status_checks.contexts, pr: .required_pull_request_reviews.required_approving_review_count, force: .allow_force_pushes.enabled, delete: .allow_deletions.enabled}"
gh api repos/Bandersnatch0x/pi-switch/rulesets --jq ".[] | {id,name,target,enforcement}"
```

## CI check name

Branch protection requires the exact check name **`Test`**, which is the job name in `.github/workflows/ci.yml`:

```yaml
jobs:
  test:
    name: Test
```

Do not rename that job without updating protection config.
