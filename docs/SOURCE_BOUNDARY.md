# Source repository boundary

This repository holds independently authored SparkStudio source. The marketing website is maintained in `SparkStudioX/www`; installer binaries and installation guides are published through `SparkStudioX/releases`.

**Never commit Ignition artifacts.** This includes gateway backups, native project exports, downloaded documentation, extraction output, reference-project analysis, artifact manifests and acquisition tools. Keep all such material outside this checkout, including its ignored directories. Reference material is not a test fixture.

Do not commit credentials, connection stores, runtime projects, certificates, keys, downloaded runtimes, package caches or generated builds. The ignored `.tools`, `.data`, `artifacts` and embedded-runtime folders are for local operation only. Examples in this repository must be independently authored synthetic examples.

## Prepare a checkout

Use Node.js and Git, then enable the repository-local hooks from the repository root:

```powershell
.\tools\install-source-hooks.ps1
node tools/test-source-boundary.mjs
node tools/check-source.mjs --worktree
```

The helper configures `core.hooksPath` only for this repository. Hook scripts use Git's shell and require Node on the command path. Clone operations do not automatically activate local hooks, so run the helper after cloning.

## Before committing

Review the exact paths and content being added. Stage named source files deliberately; do not force-add ignored content. When initially staging the hooks, preserve their executable mode:

```powershell
git add --chmod=+x .githooks/pre-commit .githooks/pre-push
node tools/check-source.mjs --staged
git diff --cached --stat
git diff --cached
```

The pre-commit hook checks the entire Git index and reads the actual staged blobs. Editing a working file after staging cannot hide prohibited content already in the index. The pre-push hook checks every reachable commit in each pushed history, including deleted files in older commits. CI runs boundary fixtures and a complete-history scan with a full checkout.

The checker uses a narrow path allowlist, rejects archive/binary/generated paths and nonregular Git modes, caps file sizes, verifies UTF-8 text, and checks selected proprietary-content and credential signatures. One independently authored PNG is approved by exact SHA-256. To add a new source location or asset, review its provenance and update the policy in `tools/check-source.mjs` deliberately. Do not weaken rules to admit a reference artifact.

The worktree check inventories tracked and nonignored files; ignored local data is not a publishable candidate. Staged and history checks still reject ignored files if someone force-adds them.

## Limits

These checks supplement source and secret review. They cannot prove authorship, detect every renamed or transformed artifact, or prevent an administrator from bypassing hooks or changing CI. Review policy changes as carefully as application code, and require the `Source boundary` workflow through repository protection settings where available. Those remote settings are separate from these local files.

If a check fails, remove the unintended file from the index while preserving any local material outside the checkout. Do not commit an artifact and remove it in a later commit: it remains in history and the push guard will reject it.
