# Preview release cycle

This is the standard end-to-end process for a SparkStudio preview release. A request to ship or publish an application release includes a **new Windows preview installer**, matching workshops, release documentation, website download links and hosted documentation. A source push or successful installer build alone does not complete a release. A request specifically limited to documentation or website maintenance can publish those changes independently without inventing a new binary version.

The release operator follows this checklist and records the resulting version, source commit, asset hashes, verification and website deployment. Installer building and GitHub release publication are currently operator-run steps. The website build, link validation and Pages deployment are automated after the website commit is pushed. There is no unattended end-to-end installer release job.

## Repository ownership

| Location | Responsibility |
| --- | --- |
| `source/` → `SparkStudioX/src` | Application, version, authored workshops, architecture docs, build tools and verification evidence summaries |
| `www/` → `SparkStudioX/www` | Landing page, `release.json`, `docs-source.json`, docs renderer and Pages workflow |
| `SparkStudioX/releases` | Published installer, workshop ZIP, checksums, manifests and release documentation; no application source |

Run application commands inside the source checkout and website commands inside the website checkout. Never commit from the mixed workspace root. Generated packages, runtime data, certificates, credentials, logs and private reference material must not enter either source repository. Follow each repository's `AGENTS.md` and source-boundary checks.

## 1. Prepare a new release candidate

1. Inspect published releases **and drafts** in `SparkStudioX/releases`. Select the next unused `X.Y.Z-preview.N` version. GitHub's stable latest-release endpoint excludes prereleases; use the release list. Never reuse a published version or silently replace published installer bytes.
2. Review the intended application changes. Preserve unrelated or ongoing work. Use a clean release checkout of an explicitly reviewed commit; do not build a release from an arbitrary dirty development tree.
3. Update `Version` and the four-part numeric `FileVersion` in `src/SparkStudio.Gateway/SparkStudio.Gateway.csproj`. For example, a `0.2.0-preview.N` release uses `0.2.0.N`. Keep `AssemblyVersion` deliberate; it is not automatically the preview sequence.
4. Reconcile affected architecture guides, the installation guide, source README release references, feature workshops and `examples/catalog.json`. Include new architecture guides in the architecture README navigation. Record compatibility requirements and unresolved acceptance in [Verification and roadmap](PARITY.md). Update the review date only for a review actually performed.
5. Run the application build and checks appropriate to the changed features, including workshop catalog/build checks. Review every staged path and diff. Run `node tools/check-source.mjs --staged` before committing; keep hooks enabled. Commit and push the candidate, then require successful source CI. Record its full commit as the **build source revision**.
6. Reconfirm the candidate checkout is clean and its HEAD is the reviewed build source revision. Dependency acquisition requires network access when caches are absent. Use the pinned toolchain and dependency locks; do not substitute unreviewed local runtime files.

Useful source checks include `node tools/check-source.mjs --tree HEAD`, `node tools/test-source-boundary.mjs` and `node tools/test-workshop-build.mjs`, plus the feature-specific checks documented with each change. Source CI does not replace installer or runtime acceptance.

## 2. Build the installer and matching workshops

Run these commands from the clean source checkout, one step at a time. Stop on any nonzero exit or thrown error; PowerShell does not automatically stop for every failed native command.

```powershell
[xml]$releaseProject = Get-Content src/SparkStudio.Gateway/SparkStudio.Gateway.csproj
$releaseVersion = [string]$releaseProject.Project.PropertyGroup.Version
$releaseTag = "v$releaseVersion"
$releaseSource = git rev-parse HEAD

.\tools\publish-windows.ps1
.\tools\build-installer.ps1
node tools/build-workshops.mjs --version $releaseVersion
```

`publish-windows.ps1` builds the browser and gateway and writes a fresh `artifacts/windows-x64-<version>/` payload. `build-installer.ps1` checks clean-source provenance and payload hashes, then writes the installer, its checksum, `package-manifest.json` and `build-result.json` under `artifacts/installer/`. Do not treat the local publish script as GitHub publication: it only builds files.

Loose workshop packages have one maintained home, `artifacts/sparkproj/`, with their guides and index. Immutable release ZIPs, manifests and checksums live under `artifacts/workshops/<version>/`. Verify the frozen versioned bundle, not mutable loose packages left by another build. Each workshop bundle must report the same version and clean source revision as the installer. If the intended commit does not yet implement this artifact layout, finish that change before releasing it.

Keep scratch payloads and verification output local. After release, archive or remove superseded generated output deliberately; retain the current installer and the single maintained loose-package folder. Check resolved path containment before any recursive cleanup.

## 3. Verify the exact release artifacts

```powershell
$previousDemoSetting = [Environment]::GetEnvironmentVariable('SparkStudio:EnableDemoTags', 'Process')
try {
    # The smoke suite explicitly exercises synthetic demo values. This setting
    # applies only to the disposable verifier process, never the packaged defaults.
    [Environment]::SetEnvironmentVariable('SparkStudio:EnableDemoTags', 'true', 'Process')
    .\tools\test-installer.ps1 -ExpectedVersion $releaseVersion -WorkshopDirectory "artifacts/workshops/$releaseVersion"
} finally {
    [Environment]::SetEnvironmentVariable('SparkStudio:EnableDemoTags', $previousDemoSetting, 'Process')
}
```

This verifies extraction, payload hashes, version/source provenance, bundled runtimes, served browser assets and authenticated workshop import/publication/re-export against the extracted package on isolated loopback port 5091. The smoke fixture requires explicit demo-tag opt-in because production defaults disable simulation. The colon-form configuration key above survives the verifier's clearing of inherited host/listener overrides. Check production-default readiness separately; do not enable simulation in shipped configuration to satisfy a test. Ensure that port is available; do not stop an unrelated running gateway. Read `artifacts/installer/verification-result.json` and the test output. A successful extraction test does **not** establish elevated service installation, upgrade, uninstall, network trust or rollback acceptance.

Exercise the changed Designer/operator flows against the packaged gateway. For installer or service changes, use a disposable Windows environment for the relevant install/upgrade/service-account/uninstall checks. Record what passed and what remains unverified; retain existing acceptance limitations in the notes. Fix failures and rebuild a clean candidate before proceeding. If code changes after the build, produce and verify fresh artifacts with new provenance.

Preserve installer and workshop SHA-256 values, sizes, payload counts and the build source revision in the release evidence. Summaries committed after verification may use a later documentation-only commit; they must identify the actual build source revision rather than imply that the installer was rebuilt from the evidence commit.

## 4. Stage and publish the GitHub prerelease

Assemble an explicit reviewed upload list from this build, with these public asset names:

| Asset | Origin |
| --- | --- |
| `SparkStudio-Setup-<version>-windows-x64-unsigned.exe` | Verified installer |
| Same filename plus `.sha256` | Installer checksum generated by the builder |
| `SparkStudio-Windows-Installation-Guide.md` | Reviewed release-specific installation guide |
| `SparkStudio-Workshops-<version>.zip` | Frozen workshop bundle |
| Same ZIP filename plus `.sha256` | Frozen workshop ZIP checksum |
| `SparkStudio-Package-Manifest-<version>.json` | Installer `package-manifest.json`, renamed for publication |
| `SHA256SUMS` | Release-level hashes for every public payload/document asset except the checksum file itself |

Include additional operational guides when the release needs them. The workshop directory's own `SHA256SUMS` describes files **inside** its ZIP; do not mistake it for the release-level checksum list. Do not upload the whole artifacts directory, private verification fixtures, test accounts or local-path-bearing build logs.

Write release notes to a local UTF-8 file and pass it with `--notes-file`. Include changes, installer version, full source revision/link, prerequisites, unsigned status, tested coverage, limitations, workshop compatibility and asset hashes. Create a draft prerelease in **SparkStudioX/releases**, upload the explicit assets, inspect the draft and download its assets into a separate local verification directory. Compare downloaded hashes and sizes with the verified originals.

The following commands illustrate the publication stages; `$releaseAssets` is the explicit array of reviewed upload paths and `$releaseNotes` is the notes-file path prepared above:

```powershell
gh release create $releaseTag @releaseAssets --repo SparkStudioX/releases --draft --prerelease --latest=false --title "SparkStudio $releaseVersion" --notes-file $releaseNotes
gh release view $releaseTag --repo SparkStudioX/releases
```

Inspect any existing draft with the same tag before continuing; resume a matching draft rather than creating duplicate versions. The tag in the releases repository identifies the assets repository, not an application commit. The notes and package manifest must link to `$releaseSource` in `SparkStudioX/src`; never use that SHA as a target commit in the unrelated releases repository.

After the uploaded asset verification passes, publish the draft:

```powershell
gh release edit $releaseTag --repo SparkStudioX/releases --draft=false --prerelease --latest=false
```

Verify the public release is no longer a draft, remains a prerelease, and all intended download URLs resolve. Treat published files as immutable. A binary correction gets a new preview version. CLI flags are described in the official [release creation](https://cli.github.com/manual/gh_release_create) and [release editing](https://cli.github.com/manual/gh_release_edit) documentation.

## 5. Publish website downloads and matching docs

After the new prerelease and all required assets are public, switch to `www/`:

```powershell
npm ci --ignore-scripts
npm run release:update
npm run release:check
```

Review `release.json` and the homepage: visible version, installer, notes, guide, workshop ZIP and checksum must all identify the intended release. The updater selects the most recently published preview; if another release was published concurrently, reconcile the candidate instead of assuming the selection is yours. Docker remains “Coming soon” until a separate tested Docker release is actually available.

Update `docs-source.json` to the full reviewed source/docs commit containing the release's guides and navigation. Prefer the build source revision or a documentation-only follow-up containing its verification evidence. If development docs intentionally describe newer work, keep the Development docs label and explicit release compatibility; do not present those features as part of the released installer. Remove unpublished-source exceptions as their files become available. Fetch the pinned commit into the local source checkout, then run:

```powershell
npm test
npm run build
npm run preview
```

Check the Docs navigation, search, internal links, code/tables, desktop/mobile layouts and the download card. The website build validates every indexed architecture document and generated local link. Commit and push the reviewed website changes. Require success from **Publish website and docs**, including the deploy job; a successful build alone is insufficient.

## 6. Confirm release completion

A release is complete only when all of these agree:

- The published prerelease contains the verified installer and companion assets, with recorded source revision and hashes.
- The workshop bundle matches the installer and its portable packages passed the documented round trips.
- The live [download section](https://sparkstudiox.com/#download) shows the new preview and resolves to its assets.
- The live [Docs section](https://sparkstudiox.com/docs/) contains the reviewed guides, a direct guide URL works, and the displayed docs revision matches the intended pin.
- Source CI and website deployment passed; source/release/website references and verification notes are recorded.

If publication or Pages deployment fails, inspect the failing stage and finish or report the specific blocker. Do not describe the entire release as shipped while website/docs updates are still pending. A website rollback re-pins the last known-good website/docs revision; a bad installer is superseded by a new preview and clearly identified in release notes. Preserve older release assets for recovery and traceability.

## Version and dependency inventory gates

`src/SparkStudio.Gateway/SparkStudio.Gateway.csproj` owns the product and numeric
Windows file versions. After advancing them, run `node tools/version.mjs --write`
to synchronize package metadata, Compose and the installer defaults. CI and both
Windows packaging commands reject drift. The source version is not advanced merely
by running tests or repairing release tooling.

Run `node tools/test-all.mjs` after the documented locked dependency restore and
retain its aggregate JSON/JUnit output with release evidence. Both test consoles
report independent suites even when another fails. The offline job does not replace
real-device, service, browser or exact-installer acceptance.
The configuration-backup fixture exercises the current Windows user's DPAPI
keyring in a synthetic temporary gateway. Run it under the normal test account;
an isolated security token without that user's DPAPI profile cannot validate this
round trip. Do not treat such a failure as a successful test or disable production
key protection to make the fixture pass.

Installer staging includes `sbom.cdx.json` (CycloneDX 1.6), identifying the exact
payload's NuGet packages, locked browser production dependencies, bundled CPython
and .NET frameworks. The SBOM and third-party notices enter the hashed package
manifest. Browser/.NET/CPython notice text is retained; NuGet package notices are
copied when present. For specifically reviewed package versions whose packages omit
the text, the installer builder also copies official upstream licenses/notices from
immutable source revisions with verified SHA-256 pins. Downloaded texts remain in
the ignored cache and release payload, outside source commits. The inventory
records their source URLs, revisions and hashes; a future package version needs a
new review. Review any remaining dependencies without embedded license text against
their package metadata before distribution. The NuGet inventory preserves declared
license expressions, copyright and license URLs and marks packages without copied
notice files as `requiresLicenseReview`; a successful build does not clear that
review. Available SPDX license expressions also enter the SBOM. SBOM generation is an inventory, not a
legal permission grant or a vulnerability audit. SparkStudio's proprietary LICENSE
does not supersede third-party terms.

The manual published-folder service script delegates to the very same helper used
by Setup. Both use the ProgramData directory, ownership checks, LocalService ACLs,
local/HTTPS listener rules and bundled-Python readiness. No second `sc.exe`-only
installation route remains. Elevated upgrade/rollback acceptance still requires a
Windows administrator on the target machine.

Builds use locked dependencies and deterministic managed compilation, but do not
claim byte-identical installer files: signing, timestamps, Inno output and platform
tooling must be accounted for. Unsigned previews remain visibly labelled unsigned.
Authenticode signing requires the product owner's certificate/signing service and
must not be simulated with a locally generated identity.
