# Build process and quality checks

This guide describes the build policy in the published application source used for **Windows preview.13**, reviewed on **October 3, 2026**. That release passed the frontend/backend lint, offline tests and cyclomatic complexity gates described below. Building requires a source checkout containing `tools/build-quality.mjs` and `Directory.Build.targets`; the installer contains the built application and runtimes. Older source revisions and releases retain their own build instructions and recorded verification. This Windows release does not update the existing Docker edition.

Run application commands from the application repository root, which is `source/` in the shared workspace. The website has a separate repository and publication process. Building application files does not publish a release.

## Prepare the toolchain

Windows development uses Node/npm, Git and PowerShell. Node **22.17.1** is the version configured for product CI. The workspace bootstrap downloads the reviewed Windows x64 **.NET SDK 10.0.401** and **CPython 3.14.7** archives and verifies their checksums. The SDK is selected by `global.json`; NuGet and npm dependencies have committed lockfiles.

```powershell
.\tools\bootstrap.ps1
```

Bootstrap prepares `.tools/dotnet/` and `runtimes/python/windows-x64/`, including the Windows native runtime dependency used by the industrial connector. It does not install Node/npm or restore the application packages. The full build below performs the dependency preparation.

Linux CI and Docker supply the same reviewed SDK/Python versions through their setup steps or pinned images. A local Linux checkout needs Node/npm, Git, the SDK selected by `global.json` and CPython. `SPARKSTUDIO_DOTNET` and `SPARKSTUDIO_PYTHON` select available executables; they do not disable any gate.

First-time tool acquisition and package restore require network access. The offline tests use synthetic local resources and disposable loopback fixtures; their name does not mean a cold machine can acquire its dependencies without a network.

## Run a full application build

```powershell
.\tools\build.ps1
```

The script ensures the workspace SDK/Python are available, performs a locked Gateway dependency restore, runs `npm ci` for the browser, and calls the shared full-build coordinator. The coordinator runs all four quality gates below, then checks TypeScript, builds the Vite browser bundle, copies it into the Gateway web root and builds the Gateway with its connector/source-worker dependencies.

Use the warm-checkout option when the required packages have already been restored:

```powershell
.\tools\build.ps1 -SkipRestore
```

`-SkipRestore` skips the preparation Gateway restore and `npm ci`. It still checks the runtime prerequisites and executes all quality gates, including the test runner's isolated locked restores. It is not a way to prepare a fresh machine.

The direct coordinator command is also available after dependency preparation:

```powershell
node tools/build-quality.mjs full
```

Like `build.ps1 -SkipRestore`, this requires prepared npm dependencies and the production Gateway restore. Test fixtures never supply or replace that production restore as a side effect.

## Frontend and direct .NET builds

After preparing the SDK/Python and browser dependencies:

```powershell
npm run build --prefix apps/web
```

This frontend build runs the same frontend lint, backend lint, complete offline tests and application complexity checks. It then runs TypeScript checking and Vite, producing `apps/web/dist/`. A frontend build therefore requires the backend toolchain too.

Normal `dotnet build` and `dotnet publish` commands for **Gateway, Connectors, SourceWorker and ServiceHelper** enter the shared gates through `Directory.Build.targets`. For example, using the bundled Windows SDK:

```powershell
.\.tools\dotnet\dotnet.exe build src/SparkStudio.Gateway
.\.tools\dotnet\dotnet.exe publish src/SparkStudio.Gateway -c Release --self-contained false -o .data/manual-publish
```

Each command is a separate public build and runs the gates. Use the relevant reviewed runtime lockfile when restoring for a specific runtime identifier. A matching `--no-restore` publish can reuse those assets: nested lint and test builds use separate intermediate/output directories and preserve the caller's production dependency assets.

Windows release packaging uses `tools/publish-windows.ps1` and `tools/build-installer.ps1`. Their production Gateway/helper builds reach these gates too. Release provenance, exact-package checks, installer creation and publication have additional requirements in the [preview release cycle](RELEASE_PROCESS.md).

## The four mandatory gates

The coordinator runs these stages in order. A failed stage returns a nonzero exit code and stops the requested final build or publish. Lint/test intermediate files can remain for diagnosis; their existence does not establish a successful product build.

| Gate | Tool and scope | Failure condition |
| --- | --- | --- |
| Frontend lint | ESLint with `@eslint/js` and `typescript-eslint`, using `apps/web/eslint.config.mjs`. Checks authored `apps/web/src` TypeScript/JavaScript modules and `vite.config.ts`. | Any error or warning; the command uses `--max-warnings 0`. |
| Backend lint | `tools/lint-backend.mjs`: .NET SDK Recommended analyzers plus configured style diagnostics, and pinned Ruff for production Python. Recompiles Gateway, Connectors, SourceWorker and the Windows ServiceHelper in isolated output. | Production compiler/analyzer warnings are errors; Ruff findings or setup/checksum failures also fail. |
| Offline unit and acceptance tests | `tools/test-all.mjs`, including .NET console test suites, Node/Python checks and disposable SDK model fixtures. | A failed suite, restore, compiler step or fixture produces a failed aggregate. |
| Cyclomatic complexity | `tools/check-complexity.mjs`, using TypeScript AST, Roslyn and Python AST analysis with reviewed per-language metrics. | A new unit above 20, an existing hotspot above its individual ceiling, incomplete coverage or an analysis/parse failure. |

Frontend lint catches correctness issues such as unused names, constant expressions, self-comparisons and unmodified loop conditions. TypeScript type checking is a separate check and also remains part of the build. Intentional control-character validators have narrow documented lint exceptions.

The .NET production lint scope excludes generated output and test/fixture projects. Production unused imports are checked; missing public XML documentation comments are not treated as a new documentation requirement. Test projects retain their compiler diagnostics and assertions.

Ruff checks these four production Python inputs for syntax, undefined/unused names and bug-prone constructs:

- `runtimes/python/worker.py`
- `tools/container-admin.py`
- `tools/docker-entrypoint.py`
- `tools/collect-docker-runtime.py`

`tools/ruff-runtime.json` pins the reviewed platform wheel and SHA-256. The runner verifies both the cached archive and extracted standalone binary under `.tools/ruff/`. It does not require pip in the embedded Python runtime.

## What the test aggregate covers

The reviewed October 2 development aggregate contains **117 suites**. This is an observation about that source revision, not a fixed count required of future versions. The report from the actual run is authoritative, including platform-specific skips.

The aggregate includes:

- Locked restores, builds and execution of the Gateway and Connector test consoles, including disposable SQLite integration.
- Python worker compilation, container administration and entrypoint fixtures.
- TypeScript checking, a browser build and the authored `apps/web/check-*.mjs` model/authoring checks.
- Backup destination, scheduler and online configuration snapshot model tests using synthetic files and local fixtures.
- Source-boundary, workshop, version/inventory, documentation-policy and other engineering acceptance checks.
- Actual negative lint fixtures, build-context/cleanup regressions, an SDK project-reference/publish regression, and complexity policy regressions.

The backup model fixtures put their restores and compiled output in unique fixture directories. They assert that the existence and SHA-256 content of all four normal production `obj/project.assets.json` files remain unchanged. Nested test compiler commands receive the same validated context as global MSBuild properties, avoiding duplicate project instances writing to one output path.

The aggregate does not start or mutate an installed gateway. Real industrial devices, external accounts/databases, elevated installation, exact release artifacts and opt-in load tests have their own acceptance steps. See the [release process](RELEASE_PROCESS.md), [verification ledger](PARITY.md) and [synthetic load testing](LOAD_TESTING.md).

## Complexity policy

Each executable unit starts at complexity 1; the language-specific metric counts its decisions. Nested functions and callbacks have their own counts. The gate analyzes frontend modules under `apps/web/src`, production C# under `src` and `installer/ServiceHelper`, and the same four production Python files listed above. Generated output, dependencies and .NET test projects are excluded. No production file is exempted because it is large or complex.

New functions and other executable units must have complexity **at most 20**. Existing units above 20 have individually reviewed ceilings in `tools/complexity-baseline.json`. A change cannot increase one beyond its recorded ceiling. Renamed or new units without an exception use the limit of 20.

Builds never regenerate that baseline. Reductions and removed exceptions appear in the report so a reviewer can deliberately lower or remove the relevant ceilings. Baseline changes require an explicit reviewed source change.

## Check quality without building the final product

```powershell
node tools/build-quality.mjs
```

This runs all four gates without copying a final browser build into the development Gateway output. The test/lint stages still compile their isolated fixtures and create reports.

For targeted diagnosis, the stage entrypoints are `npm run lint --prefix apps/web`, `node tools/lint-backend.mjs`, `node tools/test-all.mjs` and `node tools/check-complexity.mjs`. Running one stage checks only that stage; the normal build commands still require the complete sequence.

A recorded development gate cycle took roughly **ten minutes**. Machine speed, caches, network restore, platform and test changes affect this time. It is not a build-time guarantee.

## Docker and CI

The Dockerfile supplies Node, the SDK, Python and the other fixture prerequisites on the builder architecture. A separate Python/runtime stage supplies the target architecture's shipped runtime. The allowlisted build context excludes local gateway data, caches, private references and generated artifacts.

For a local Linux x64 builder-stage check, run from the application checkout:

```powershell
$buildRevision = (git rev-parse HEAD).Trim()
$buildVersion = (Get-Content apps/web/package.json -Raw | ConvertFrom-Json).version
docker build --target build --platform linux/amd64 --build-arg "VERSION=$buildVersion" --build-arg "SOURCE_REVISION=$buildRevision" .
```

The Dockerfile invokes a public frontend build and then a public Gateway publish. Each runs the four gates independently; nested compiler/test operations reuse their current coordinator's validated context. An uncached Docker build therefore executes the full gate sequence twice. Docker's normal layer cache can reuse previously completed steps; add `--no-cache` when fresh execution is required. Building and publishing a release image also requires the [container edition checks and publication process](DOCKER_RELEASE.md#build-and-verify-a-container-edition).

The product workflow in `.github/workflows/product.yml` runs on pushes, pull requests and manual dispatch, with independent Windows and Ubuntu jobs. It prepares the pinned toolchain and exact dependencies, then invokes `node tools/build-quality.mjs`. Its report-upload step runs even after a failure. Passing this workflow does not perform an installer, registry or website publication.

## Read the diagnostics

| Location | Contents |
| --- | --- |
| `.data/quality/summary.json` | Gate status, exit code and duration for the latest coordinator run. |
| `.data/quality/*.log` | Captured diagnostics for each coordinator stage. |
| `.data/test-results/summary.json` and `junit.xml` | Offline aggregate status and per-suite log references. |
| `.data/test-results/gateway.json` and `connectors.json` | Detailed .NET console suite/check results. |
| `.data/quality/complexity/application.json` and `application.md` | Coverage, source hashes, measured units, ceiling violations and reductions. |

These are ignored local outputs. Preserve a run's reports with its command, source revision and platform when comparing results; later runs can replace shared report files. Keep runtime data, fixture evidence, caches and generated binaries out of source commits. The [source-boundary policy](../SOURCE_BOUNDARY.md) governs source review and commit checks.

The coordinator uses temporary validated contexts to keep nested compilers/tests from recursively starting the complete aggregate. A context is valid only while its owner is alive; normal completion removes it. Production lint and compiler diagnostics remain enabled inside nested builds. There is no public quality-bypass switch or persistent passing-build stamp. Restore and read-only SDK metadata queries do not create production artifacts and do not start the build gates.
