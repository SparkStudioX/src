# Verification and roadmap

This ledger records the scope of checks performed on the preview. Dated entries are historical observations, including process ports, artifact locations and limitations at that time; later entries may supersede them. The [documentation index](README.md) and capability table below describe current source scope. The September 30 documentation audit did not rerun or expand prior runtime acceptance. A passing check does not establish complete feature parity, production readiness or support for every environment. No Ignition importer or Java-module compatibility layer is included.

The [gateway implementation track](#gateway-implementation-track-2026-09-29) covers administration, operations and backend services alongside the application-building and component tracks. Remaining delivery gates are planned work, not additional completed verification.

The [Designer implementation track](#designer-implementation-track-2026-09-29) adds prioritized authoring, binding, event, layout and preview requirements. It complements the [component-family roadmap](COMPONENTS.md#full-component-family-roadmap); these requirements do not promote unverified work to implemented status.

## Preview.13 release-candidate review, 2026-10-03

The Windows `0.2.0-preview.13` candidate uses file version `0.2.0.13`. This entry describes reviewed source scope and outstanding release gates; it does not claim that candidate artifacts have passed verification or been published. The clean build source revision, aggregate results, source CI, installer/workshop hashes, exact-package acceptance and website deployment must be recorded from this candidate's evidence before release completion. Earlier preview.12 results below apply only to that earlier package.

The candidate includes:

- [Ask Spark](ASK_SPARK.md) across Projects, Designer and Gateway Settings, with typed and dictated input, pasted screenshots, Markdown answers and Gemini configuration. Authorized tools are discovered on demand; independent reads can run in parallel while mutations remain ordered. Designer operations include opening projects/documents, batch edits, bindings/scripts, reviewed image crops, rendered captures and resource refresh. Separate operator sessions retain the normal permissions and approvals.
- Ask Spark recovery for authorized but unloaded tools and malformed, truncated or empty generations. A failed round executes no calls. Recovery is bounded by the configured step limit and explicit retry limits; unfinished work is reported. Compact component schemas and replacement of superseded capture pixels reduce repeated context without discarding original references, tool-call pairs or model signatures. Input, output, thinking and cached-input counters identify historical usage that lacks a breakdown.
- Timestamped plaintext provider request/reply files under the gateway data directory's `askspark/` folder. Logging remains enabled by default, with no logging size cap or automatic deletion; administrators can turn off new recording. The default model-step limit remains 100 and the monthly token allowance remains unlimited until configured. Read the guide before collecting sensitive source material or estimating storage and provider spend.
- [Read-only source connections](DATA_SOURCES.md) for MQTT, MTConnect and i3X, including source browsing, reviewed point/tag imports, explicit freshness/type policies and diagnostics. MQTT supports opt-in automatic tag ownership and payload transformations in a bounded source worker. The [setup guides](README.md#data-source-setup) explain creating tags in a connection or later in Tags. Connection panes use tabs and field guidance; i3X authentication follows the service's requirements.
- Layers-pane Shift/Ctrl multiple selection and deletion, preserved canvas Z order on selection, and a clear explanation when the last screen cannot be deleted. Normal build entry points enforce [frontend/backend lint, offline tests and cyclomatic complexity checks](BUILD_PROCESS.md).

The catalog retains **37 portable projects** and adds setup-required Ask Spark and read-only-source exercises, for **21 setup-required examples**. The frozen bundle must be built from the same clean source revision as the installer and its portable projects verified by import, explicit publication and re-export. The Ask Spark exercise needs a user-supplied Gemini account/key; source exercises need the documented synthetic servers or the user's endpoints. Neither is a credential-bearing portable project.

Development provider-log reviews are diagnostic evidence, not exact-release acceptance. Live requests made with a development account do not prove acceptance for every deployed account/model. Fake-provider fixtures do not establish Gemini endpoint behavior, model availability, provider caching support or the final-answer-without-tools request against a live provider. A canvas capture verifies rendered appearance, not hidden interactive overlay geometry, button execution, or publication. Python button feedback still requires the action's runtime permissions and execution path; a saved script alone does not establish a working toast in Preview or Operate.

Physical controllers, real broker/agent/i3X interoperability, real SQL Server, elevated preview.13 install/upgrade/uninstall, LocalService secret and ACL lifecycle, remote TLS/browser trust, rollback and complete real-data preservation remain separate acceptance gates. Broader load/soak behavior and domain SMB, trusted external FTPS and real S3 account-policy delivery remain pending. This Windows candidate does not establish a new Docker image, Linux native-driver acceptance, macOS package or signed installer.

## Preview.12 exact release verification, 2026-10-01

The unsigned Windows x64 [`v0.2.0-preview.12` prerelease](https://github.com/SparkStudioX/releases/releases/tag/v0.2.0-preview.12) was built from clean application source [`f094906712abe07c663f5d841886b76bf13559e3`](https://github.com/SparkStudioX/src/commit/f094906712abe07c663f5d841886b76bf13559e3), Windows file version `0.2.0.12`. This build revision identifies the installer and workshop bundle. Any later commit containing this evidence is a documentation-only follow-up and does not identify rebuilt installer bytes; the releases-repository tag identifies the assets repository separately.

All **110 aggregate suites** passed with zero failures, including **83 browser suites**, **24 gateway suites / 1,341 checks** and **5 connector suites / 516 checks**. The latter includes **260 native-driver checks**. [Source-boundary CI](https://github.com/SparkStudioX/src/actions/runs/36936087575) and [Windows/Linux product CI](https://github.com/SparkStudioX/src/actions/runs/36936087539) passed for the exact build commit. Local offline reports supplement that commit-bound CI evidence; their files do not independently embed a source revision.

The exact installer passed **9 integration groups**, all **566 payload hashes**, bundled .NET/Python readiness and **all 37 portable workshop import, explicit publication and re-export round trips**. Workshop verification archived its synthetic projects and left gateway connections/tags unchanged. Production-default checks confirmed demo simulation disabled and bundled Python available in the owned extracted process; the packaged browser review passed for this same source build.

EtherNet/IP native-module checks confirmed both `plctag.dll` and the pinned CPython-bundled `vcruntime140.dll` came from the verified private cache under the gateway's explicitly resolved data directory, including `--DataDirectory` selection. Native loading has no environment/LocalAppData fallback; a different later root is rejected before native I/O. The runtime remains process-lived. ControlLogix/CompactLogix String points remain rejected before device access until controller structure-schema qualification is implemented; Micro800's distinct String layout also remains unsupported. Six-family numeric/Boolean profiles and PCCC ST strings retain their supported software boundaries.

All **11 public release assets** were downloaded separately and matched the reviewed byte sizes and SHA-256 hashes. The portable ZIP contains **37 projects**; the catalog's **19 setup-required examples** remain outside that ZIP. Downloaded Markdown guides use build-commit-pinned links for their source-relative document references.

| Public asset | Bytes | SHA-256 |
| --- | ---: | --- |
| [SparkStudio-Setup-0.2.0-preview.12-windows-x64-unsigned.exe](https://github.com/SparkStudioX/releases/releases/download/v0.2.0-preview.12/SparkStudio-Setup-0.2.0-preview.12-windows-x64-unsigned.exe) | 87,669,716 | `98639212a9902af74c60e235caa4d3fbdd94d39629689684d05bfbc7be624b61` |
| [SparkStudio-Setup-0.2.0-preview.12-windows-x64-unsigned.exe.sha256](https://github.com/SparkStudioX/releases/releases/download/v0.2.0-preview.12/SparkStudio-Setup-0.2.0-preview.12-windows-x64-unsigned.exe.sha256) | 127 | `52728fec11fda3e3a9836e7f9526755b16c73620da7231631bd331e2f98b59e4` |
| [SparkStudio-Windows-Installation-Guide.md](https://github.com/SparkStudioX/releases/releases/download/v0.2.0-preview.12/SparkStudio-Windows-Installation-Guide.md) | 24,372 | `e032abfbb84d10abc80418326beca3e5a1467754f556ab77a36f293947018b52` |
| [SparkStudio-Workshops-0.2.0-preview.12.zip](https://github.com/SparkStudioX/releases/releases/download/v0.2.0-preview.12/SparkStudio-Workshops-0.2.0-preview.12.zip) | 409,638 | `ee0f50dfee6390cc29a0328dd48099a8596b66668b28fb15690d34f266539661` |
| [SparkStudio-Workshops-0.2.0-preview.12.zip.sha256](https://github.com/SparkStudioX/releases/releases/download/v0.2.0-preview.12/SparkStudio-Workshops-0.2.0-preview.12.zip.sha256) | 109 | `e376f42e7f7a0809088bf82f11a8e0205e2435e0c28fd85a0f3585d45f03c768` |
| [SparkStudio-Package-Manifest-0.2.0-preview.12.json](https://github.com/SparkStudioX/releases/releases/download/v0.2.0-preview.12/SparkStudio-Package-Manifest-0.2.0-preview.12.json) | 102,625 | `84952b9cdffa3e5ce85f8e0c6435b0ce4d1a8f1012dcb677e3e2430e71f46c02` |
| [NETWORK_ACCESS.md](https://github.com/SparkStudioX/releases/releases/download/v0.2.0-preview.12/NETWORK_ACCESS.md) | 12,020 | `9774467167741d4606f8594d4e359a06541154c24f1f402e6532fdd9df428521` |
| [SCHEDULED_BACKUPS.md](https://github.com/SparkStudioX/releases/releases/download/v0.2.0-preview.12/SCHEDULED_BACKUPS.md) | 13,127 | `cc3d1a9b3ce61ad81f6c77fc3a3c78ad81b659228f50dc51d81c599ea4a6a611` |
| [GATEWAY_RECOVERY.md](https://github.com/SparkStudioX/releases/releases/download/v0.2.0-preview.12/GATEWAY_RECOVERY.md) | 11,453 | `700badfabe116f419faadc89051a2bdf75b9281c418a1781502ebe045d68f5fb` |
| [INDUSTRIAL_DEVICE_CONNECTIONS.md](https://github.com/SparkStudioX/releases/releases/download/v0.2.0-preview.12/INDUSTRIAL_DEVICE_CONNECTIONS.md) | 17,586 | `c433e7b6c2d29b1a55aaa66ec468ad9eb1ae824eb8b6627ddfb53f40dbc6c8bb` |
| [SHA256SUMS](https://github.com/SparkStudioX/releases/releases/download/v0.2.0-preview.12/SHA256SUMS) | 1,065 | `50b45bd55fa59047cfd8b0e3641b9452b54336c011fa9e28b1a227426d256cdc` |

These checks establish software/artifact provenance, not physical controller/model/firmware acceptance or deployment acceptance of the new Linux driver payloads. Elevated preview.12 service installation/upgrade/uninstall, LocalService secret/ACL lifecycle, rollback, complete real-data preservation and remote listener/TLS acceptance remain separate gates. Current-user extraction does not establish those results. The installer remains unsigned; no new Docker image or macOS package is claimed. Website/docs publication is recorded separately after its own deployment and live checks.

## Preview.12 release-candidate review, 2026-10-01

The final offline acceptance run passed **110 aggregate suites with zero failures**,
including **83 browser suites**, **24 gateway suites / 1,341 checks**, and
**5 connector suites / 516 checks**. TypeScript, the production browser build,
Python, normal-account Windows DPAPI backup round trips, workshop generation,
source-boundary and dependency-inventory policy checks passed. The inventory
fixtures now cover missing and corrupt native runtime dependencies without
requiring Windows binaries on Linux. Exact-installer, uploaded-asset and website
verification are recorded separately after the clean candidate is built.

The candidate includes four industrial drivers and six EtherNet/IP family profiles,
reference-safe connection removal, point-map authoring and connection/menu fixes.
Release review corrected stale asynchronous map-file imports and quick-read busy
state after a connection revision changes. Pointer and keyboard focus now agree
in the shared New Connection/New Tag menu; the action tag browser closes on Escape
without discarding its editor draft.

Windows libplctag now loads the exact pinned CPython-bundled Microsoft VC runtime
from its verified private cache. Native fixture checks confirm both module origins
and hashes; the installer smoke check also exercises an owned rejected loopback
endpoint and verifies loaded module provenance. This does not establish physical
controller acceptance. Linux publishes omit the Windows dependency.

Exact-installer review of the first unpublished candidate found that the native
cache used an environment/default directory instead of the gateway's resolved
`--DataDirectory`. The corrected session factory passes the configured absolute
directory explicitly to every native entry point. Equivalent normalized paths
share initialization; a different process-wide root is rejected before cache or
protocol I/O. Fixtures cover missing and misleading environment overrides and
read/write rejection without dispatch. The failed installer remains local and
was not published; final release verification uses a fresh clean-source build.

ControlLogix, CompactLogix and Micro800 String maps are rejected before native tag creation,
reads, setters or writes. The pinned SDK's 82-character capacity is a default
layout, and an 88-byte STRUCT or observed `0x0FCE` handle does not establish the
remote controller's LEN/DATA schema. The earlier positive Logix String fixture
results below describe synthetic layout exercises, not accepted schema identity.
PCCC ST strings remain supported, as do the six families' reviewed numeric and
Boolean profiles. The final native suite passed **260 checks**, including rejection
of both the synthetic standard-looking handle and an unrelated same-size UDT.
Physical-device, firmware and Linux execution acceptance remain pending.

## Industrial device driver source verification, 2026-10-01

The current working source adds Modbus TCP, EtherNet/IP profiles for ControlLogix,
CompactLogix, Micro800, MicroLogix, SLC 500 and PLC-5, classic Siemens S7 and Beckhoff
ADS through shared device sessions. Saved point
maps separate native addresses, stable point IDs, raw encodings and engineering
types. Native Logix/ADS metadata is distinct from map browsing; mapped tags poll
through the existing acquisition engine and writes retain published command
authority, fresh review, physical-device serialization and single dispatch.
See the [implementation guide and setup-required workshop](INDUSTRIAL_DEVICE_CONNECTIONS.md).

The following counts record the initial four-driver verification before the
additional EtherNet/IP family fixtures. The final Windows gateway build passed
with no compiler warnings. The full
gateway suite passed **24 suites / 1,320 checks**, including 31 new device/workshop
checks against an independently authored loopback Modbus endpoint. Connector
suites passed **302 checks**, including 77 industrial transport/configuration
checks and 46 native SDK/codec checks. Modbus and S7 fixtures verify native
read/write payloads and lost-acknowledgement behavior. The EIP suite loads the
actual packaged native runtime with a read-only payload file and checks verified
cache integrity. Existing OPC UA subscription integration also passed its
disposable-server checks during this implementation.

All **83 browser suites** passed, including 19 industrial UI groups for map
validation, raw/engineering encoding, native identity/capacity, revision fencing
and successful save acknowledgements during parent refresh. TypeScript and the
production browser build passed.

Locked gateway publish passed for Windows x64 and Linux x64/ARM64; native PE/ELF
architecture and payload selection were checked. Dependency license/notice,
source-boundary and workshop guards passed. Linux execution, actual Logix,
TwinCAT and physical-controller acceptance remain unverified. This entry records
source validation, not publication of a new installer or container release.
The development gateway on loopback port **6090** reports ready and serves the
rebuilt browser bundle.

### Additional EtherNet/IP families, 2026-10-01

The source now selects all six documented EtherNet/IP families explicitly with
the pinned native core **2.6.0**. Micro800 and PCCC use saved maps and direct blank
routes; the family/address matrix and setup-required workshop record their
supported raw encodings, native masked bit writes and excluded address spaces.

The updated full gateway suite passed **24 suites / 1,341 checks**, including
**52 device/workshop checks** for family configuration, mapped tag validation,
offline browsing and saved-reference guards. The backend build passed with no
warnings or errors. Focused browser runs passed **26 industrial UI groups** and
**24 gateway lifecycle groups**; TypeScript and the production build passed.
These focused runs do not rerun the historical 83-suite browser result above.

The final connector run passed **5 suites / 481 checks, zero failures**:
78 configuration guards, 85 SQLite, 16 reliability, 77 industrial transport and
**225 native industrial checks**. Independently authored loopback fixtures use
the actual pinned SDK for all six EtherNet/IP families. They cover PCCC bit-15
reads and exact set/clear masks, family Float ordering, 84-byte counted strings,
MicroLogix signed/unsigned L bounds, Micro800 WORD/DWORD and connected Logix
scalar/standard STRING reads and writes, including four-byte type metadata.
Mismatch rejection before dispatch, cancellation and lost-acknowledgement
behavior verify that a failed reviewed intent is not resent.

Those fixtures exposed two pinned-SDK issues: positive metadata byte counts
were interpreted as errors, and unconnected Logix write acknowledgements were
misclassified. The implementation now uses an assembly/field-shape-guarded
metadata bridge with bounded, exact-length native copies and connected Logix
scalar operations. Read-only Logix catalogs retain unconnected messaging.
Dependency versions and public gateway APIs remain unchanged; future SDK
upgrades require requalifying the bridge and family fixtures.

The offline workshop checks passed **11 groups across 37 portable examples**,
including rejection of all 19 setup-required examples from portable packaging.
The industrial loader syntax, source boundary and engineering policy checks
passed. No physical controller or installed gateway data was used by these
tests; model/firmware hardware acceptance and release publication remain
separate delivery gates.

## Docker edition publication verification, 2026-10-01

The [Docker prerelease](https://github.com/SparkStudioX/releases/releases/tag/v0.2.0-preview.11-docker.1)
and [Docker Hub repository](https://hub.docker.com/r/ladder99/sparkstudio) distribute
**0.2.0-preview.11-docker.1** for **Linux x86-64 and ARM64**, with product version
**0.2.0-preview.11**. Both its version tag and `preview` alias resolve to index
`sha256:054b36a79bbe70e1617996926b8768b750d650f1b10d8ad22d83911b4dea47a1`.
The actual clean image-build source is
[`2dd4173c12a91b908d83ce8a74755c129e48fc5a`](https://github.com/SparkStudioX/src/commit/2dd4173c12a91b908d83ce8a74755c129e48fc5a);
later documentation commits do not rebuild or change that image. The frozen
[Compose example](https://github.com/SparkStudioX/src/blob/2dd4173c12a91b908d83ce8a74755c129e48fc5a/compose.yaml)
maps loopback **8090** for the HTTPS redirect and **8443** for authenticated TLS.

The image's [Product validation](https://github.com/SparkStudioX/src/actions/runs/36841461165)
and [source boundary](https://github.com/SparkStudioX/src/actions/runs/36841460915)
passed. Windows and Ubuntu each passed **109 aggregate suites**, including
**1,289 Gateway checks**, **163 Connector checks**, eight container-administration
tests and **15 TLS entrypoint tests**. The latter include six actual OpenSSL
certificate fixtures, with no skips in either final CI job.

Both final local images and fresh deployments of the **published digest** passed
all seven deployment groups on this laptop's Docker Desktop **4.85.0 / Engine
29.6.2**. X86-64 ran natively; ARM64 ran under emulation. Each platform exercised
certificate-validated TLS, fixed-origin redirects, an unpublished management
listener, local administrator bootstrap, secure isolated cookies/CSRF, native
SQLite, memory tags, Python actions, separate operator login/query/button actions,
all **37 portable workshops** through import/publication/export, and graceful
restart retaining accounts, projects, tags, databases, keys and certificate
identity. Disposable test containers and volumes were removed without touching
other applications. This verifies a same-edition restart, not a version migration.

Independent payload review verified **292 application hashes** and **205 original
notice hashes** per architecture. Each SBOM identifies **157 components**; all
**17 distributed layers** per platform were inspected to exclude unused
pip/site-packages/ensurepip bytes. Anonymous registry checks verified the index,
both platform/configuration digests, architecture/source labels and committed
Compose pin. The public repository initially inherited private visibility; it
was made public, and anonymous pull authorization passed before website delivery.

All **11 GitHub release assets** were downloaded and SHA-256 checked, including
the complete **381,453,238-byte** corresponding-source archive for **73 exact Ubuntu
source versions** and CPython 3.14.7. The archive SHA-256 is
`c013b0cbca5235f846de9c7a7ab772b3c94cc030cee928defc4504ac8efaf3cc`;
its source-manifest SHA-256 is
`31aa2144b1a0a77cd39779acf343f2eabc11b24e86b87391321fdda16486fb45`.
Original archives, patches, licenses and build directions cover runtime packages
and retained ancestor-layer versions. No downloaded dependency sources, runtime
data, credentials, keys or layer-inspection archives were committed or included
as unrelated public assets.

The independently versioned Docker metadata and hosted guide follow this frozen
build; the existing Windows preview.11 installer/workshop bytes stay unchanged.
Website tests, public Windows/Docker link gates, a reviewed documentation pin,
successful Pages deployment and live verification remain the website delivery
contract. Physical ARM hardware, remote client trust, factory-network connectors,
actual remote SMB/FTPS/S3 destinations, trusted proxies, cross-version migration
and elevated Windows service acceptance remain separate gates. See
[Docker deployment](DOCKER_RELEASE.md) for operation and recovery scope.

## Docker edition implementation, 2026-10-01

The container edition candidate is **0.2.0-preview.11-docker.1**, retaining
application version **0.2.0-preview.11**. The Dockerfile builds Linux x86-64 and
ARM64 using four immutable base-image indexes and target-specific NuGet locks.
Compose maps loopback host **8090** to an HTTP landing redirect and **8443** to
direct HTTPS; management remains inside the container on loopback 5090. It runs
nonroot with a read-only root filesystem, a temporary `/tmp` and a persistent
private gateway volume. Local terminal setup uses the existing guarded bootstrap
API. Persisted certificate identities, distinct cookie names and loopback-only
HSTS suppression support parallel Windows/Docker use without changing Windows
installer bytes or its default authentication behavior.

Local source validation passed **109 aggregate suites** (including **1,279 Gateway**
and **163 Connector** checks at that build). Subsequent focused redirect/cookie/HSTS
verification passed **72 checks**. The first aggregate's Windows OpenSSL absence
skipped five TLS fixtures; a separate run with Git's OpenSSL executed all **15**
final entrypoint checks without skips. The container administration CLI passed
eight checks. Native x86-64 and emulated ARM64 provisional images ran on Docker
Desktop 4.85.0 / Engine 29.6.2 on this x86-64 Windows laptop. Checks exercised
validated HTTPS, guarded bootstrap, memory tags, native SQLite, Python, all 37
portable workshop imports/publications/exports, graceful shutdown and retained
accounts, projects, databases, keys and certificates. ARM64 additionally exercised
the separate operator audience and its published Python action at that stage.

The final clean-source image build, both final platform checks, registry
publication/digest verification, public-image rechecks and website deployment
were release gates at this candidate stage; the publication entry above records
subsequent verification. Physical ARM hardware, real SQL Server,
factory-network connectors, remote certificate trust, cross-version migration and
external backup destinations are not established by the container fixtures. See
[Docker deployment](DOCKER_RELEASE.md) for startup, certificates, data scope,
recovery and the separate container release cycle.

## Preview.11 package verification, 2026-09-30

The published prerelease version is **0.2.0-preview.11**, with Windows file version
**0.2.0.11**. Its scope includes component-specific/custom runtime bindings,
native fixed/property-sourced tag buttons, camera capture and visitor photo
badges, receiver discovery, multiple backup schedules/destinations with S3, and
the revised Designer/Gateway Settings presentation and preview footer. The
companion catalog contains **37 portable workshops** and **18 setup-required
examples**; the visitor exercise additionally needs a webcam and Labelary access.

The corrected installer and frozen workshop bundle were built from clean source
commit **`fcd26034153d4192bd6e11b352b1d57ba3324aeb`**. This is their actual build
revision; a later documentation commit does not change their provenance.

- Installer: `SparkStudio-Setup-0.2.0-preview.11-windows-x64-unsigned.exe`,
  **85,806,613 bytes**, SHA-256
  `665ee1a637077e3d2fd8631ca2451639cbf9c224644d86975c658edd4b495b93`.
- Workshop bundle: `SparkStudio-Workshops-0.2.0-preview.11.zip`, SHA-256
  `cfa46e73ce737e4e76145ae8dcdd7a2d4799a24005f19feb7f1e215367c50d20`.
  All **37 portable projects** passed import, explicit publication, operator
  snapshot and re-export against the extracted installer. The **18 setup-required
  examples** remain documented separately.
- Local validation passed **106 suites**, including **1,217 Gateway checks** and
  **163 Connector checks**. Exact extraction verified **540 payload file hashes**
  and bundled .NET module loading. Authenticated execution used the packaged
  **CPython 3.14.7**; the production-default readiness probe reported `demoMode: false`.
- The exact-package verifier passed **19 gateway smoke**, **12 assets/popup**,
  **three deployment**, **four connection** and **three query-cancellation**
  groups, plus all workshop round trips. Nine equipment-command API groups also
  passed against that extracted package. Local evidence is recorded in ignored
  `artifacts/installer/verification-result.json` and accompanying test logs.
- The manifest/SBOM and notice audit found **57 SBOM components**, including
  **32 NuGet** and **22 browser dependencies**, with **21 reviewed supplements**
  and **47 original notice/license copies**. Reviewed AWS SDK and SQLite notices
  are included in the hashed payload; no unresolved notice flags or optional
  authentication-broker files remained. This is an inventory check, not a legal
  or vulnerability guarantee.

Browser checks on the extracted package confirmed chart legend/axis bindings
(120→240), table filtering (two rows→one), the footer Live actions toggle and
screen dimensions, and the separated live-actions confirmation. Visitor checks
confirmed the application-only form, field entry, hidden images no longer
blocking clicks and missing-photo validation. These checks did not capture a
real camera photo or call Labelary.

Gateway Settings browser checks on the same package confirmed the summary tiles
without project/connection inventories; Configuration's Tags, Connections and
Public OPC certificates tabs; the New Tag menu and corrected path-example
punctuation; and Backups' Schedules, Destinations and Restore tabs. The default
schedule was disabled at **02:00, Central Standard Time, with seven-day
retention**. S3 destination fields were inspected and the draft was canceled.
Gateway warning/error logs were empty during these checks. No remote backup
delivery was attempted.

Exact-package testing exposed a stale memory-definition cache that could reset a
recent write while applying a pending configuration generation. The fix reads
authoritative memory state during that application without rebuilding plans for
ordinary writes. A deterministic regression failed before the fix and passed
after it; the isolated Gateway suite passed 1,217 checks. The rebuilt package
above passed the assets/popup checks that exposed the defect. It also uses core
SqlClient 7.0.3, omitting optional Azure/WAM authentication dependencies that are
outside SparkStudio's supported SQL password/Windows integrated connection model.

Source CI's Windows and Linux jobs passed in
[Product validation run 36815605947](https://github.com/SparkStudioX/src/actions/runs/36815605947),
and [source-boundary run 36815605853](https://github.com/SparkStudioX/src/actions/runs/36815605853)
passed. The [preview.11 prerelease](https://github.com/SparkStudioX/releases/releases/tag/v0.2.0-preview.11)
is public. All **nine release assets** were uploaded, downloaded again and matched
their expected hashes and sizes. The website pins its reviewed documentation
source through `www/docs-source.json`; that reference can differ from the binary
build revision above. Earlier dated entries retain their original source/build
evidence and do not establish acceptance of these installer bytes.

Elevated service install/upgrade/uninstall, rollback and complete real-data
preservation, broader service-account/ACL behavior, remote HTTPS trust/renewal,
real SQL Server and device/site workloads, actual domain SMB, trusted external
FTPS and real AWS/S3-compatible account-policy/delivery remain separate
acceptance gates. No production credential, gateway data or private reference
material belongs in the release package or companion workshops.

## Visitor check-in, camera capture and hidden-component hit testing, 2026-09-30

The portable Visitor check-in workshop accepts name/email and a static host,
captures a square photo through the new Computer camera input, renders a 4×3-inch
badge through Labelary and clears local visitor values on Dismiss. Its maintained
package is `artifacts/sparkproj/visitor-checkin.sparkproj`; the [guide](VISITOR_CHECKIN.md)
covers camera permission, HTTPS/localhost, third-party data handling and source
compatibility. No visitor register, host notification or printer dispatch is
included. Earlier preview.10 installers lack these source additions.

Computer camera starts only on an explicit action and owns its transient PNG URL;
capture/disable/departure stop camera tracks and reset/retake/departure revoke the
photo. Image supports bound, same-origin blob URLs without persisting image data
in typed state. Visitor text is UTF-8 hex-escaped into ZPL; the captured photo is
cropped and dithered into a one-bit graphic. The bounded browser request checks
HTTP status, PNG signature/type/size, duplicate admission and retired-owner effects.

The actual RenderBoundary DOM wrapper had prevented the hidden-geometry CSS from
matching. Hidden Image/Button/Input wrappers now use `display:none` in runtime,
so they cannot block pointer/focus access, while Designer retains selection and
React retains the component lifetime. The selectors cover positioned canvas,
popup and template geometry without hiding a visible container merely because
one of its leaves is hidden.

Native form controls now use a light or dark `color-scheme` derived from their
resolved opaque background; white authored inputs no longer inherit dark native
control treatment. Transparent controls retain the surrounding scheme. The
browser and operating system still determine the mouse pointer's appearance.

Send message authoring suggests declared message types and lists matching
receivers with component/handler IDs, document, scope, language and template
placement. It distinguishes potential receivers from other locations and reports
inspection limits. Discovery never executes scripts or claims a listener is
currently mounted. General properties now expose a read-only Component ID;
blank layer captions fall back to that ID, making the tiny visitor controller
selectable by name.

Verification: production browser build, gateway publish build, 10 synthetic camera
groups, seven visitor-script/form/lifetime groups, 28 bound-renderer groups, 16
runtime-property groups, 65 gateway runtime-property checks and 43 input-constraint
checks passed. Fourteen receiver discovery groups, 41 unified action-authoring
groups, eight property-authoring groups and eight visual-style renderer groups
also passed. All 37 portable workshops passed real import, explicit publication,
operator snapshot and re-export checks on an isolated gateway without changing
shared tags/connections. Broader offline suites passed, including corrected
inventory and settings-form checks rerun after their initial failures.

A live Labelary POST using synthetic details and a geometric portrait returned a
valid 812×609 PNG with permissive CORS headers. Browser inspection confirmed the
corrected package import and the user's 6090 form, missing-photo validation,
camera startup/cancellation and restored mouse hit testing. No real camera photo
was captured or sent; photo processing/Dismiss used synthetic automation. Real
camera-image rendering remains a manual acceptance exercise.

## Live-preview confirmation presentation, 2026-09-30

The live-actions confirmation now separates its real-data impact from script
permissions, the 15-minute project/session scope and mode-switch cancellation.
A compact header, divided footer and scrolling body replace the dense paragraphs.
Keep read-only receives initial focus; Escape, the close icon and cancellation
restore focus to the opener. Preview execution permissions are unchanged.

Verification: production web build, 12 existing preview communication checks,
source-boundary and diff checks passed. An isolated browser inspection verified
light/dark appearance, dismissal/focus behavior and a 390×520 viewport with the
footer visible and the body scrolling without horizontal overflow. Live actions
were not enabled during visual verification.

## Consistent Gateway Settings panels and automatic observations, 2026-09-30

Overview, Deployment, Backups/Restore, Sessions, Diagnostics, Security and Audit
now share the contrasting content surface, divided panel headers, compact field
spacing and secondary text used by Configuration, Alarms and History. Backups
and Security place their inner tabs above that surface. Decorative section
overlines and routine Refresh/Reload controls are removed; functional titles,
configuration actions and contextual Retry remain.

Read-only observations update while visible, with duplicate-request and disposal
guards. Configuration, tag definitions and certificate lists update quietly;
tag/certificate dialogs and drafts pause relevant reads. Users/Audit observations
pause while editing accounts. Listener, alarm/history and operator settings
never receive automatic replacements over drafts. Their Cancel action retrieves
the newest saved configuration and preserves edits if retrieval fails.
Connection cancellation also retains credentials until successful retrieval.
Backup cancellation instead adopts the latest successfully polled saved snapshot,
clears staged secrets and retains observation errors. Background status reads do
not unlock ongoing downloads, erase failed restore approval or acknowledge a
changed recovery receipt.

Verification: 105 focused UI/lifecycle groups, the production web build and
source-boundary checks passed. Existing certificate and tag-manager checks also
passed. Isolated browser checks covered all ten main sections, backup
Schedules/Destinations/Restore, Security's two tabs, S3 fields, light/dark
presentation and a 720-pixel layout with no page-wide horizontal overflow.
Backups/Security tab placement and the absence of normal Refresh/Reload controls
were checked in the rendered DOM; no console errors were observed. Active guides
and the Gateway operations workshop instructions were updated. This frontend
change does not change installed service settings, account grants or equipment.

## Security tabs and selected-project tag access, 2026-09-30

Gateway Settings → Security now uses underlined **Users & access** and
**Operator settings** tabs with keyboard navigation. Operator settings has a
searchable, paged project list and one selected project's multiline **Tag-path
prefixes** form. Each project's draft remains intact when switching projects,
tabs or refreshing accounts. Saving applies the public URL and the complete
scope map together, including mappings outside the visible list. Cancel restores
the loaded baseline; explicit reload refreshes the saved revision. Account APIs,
authorization and tag-scope matching rules are unchanged.

Verification: 11 focused Security UI groups, 20 authentication UI groups and
the production web build passed. Isolated browser checks verified keyboard tabs,
independent project drafts, account refresh, search, cancellation and save/reload
in light and dark themes. An authenticated API comparison confirmed that saving
one project's synthetic prefixes preserved unrelated settings; the disposable
gateway's original scope map was restored afterward. The access workshop
walkthrough and security documentation were updated. No live account grants or
installed gateway settings were changed.

## Multiple backup destinations and schedules, 2026-09-30

Gateway Settings now has one **Backups** page with **Schedules**, **Destinations**
and an administrator-only **Restore** tab. Legacy Recovery bookmarks open
Restore. Searchable lists use one selected-item property form, with shared drafts
preserved across tabs, optimistic revision checks and write-only secret edits.
SMB, FTP, FTPS and S3 show only their relevant connection properties.

The gateway persists up to 32 named destinations and 64 independent schedules.
Schedules select a destination, daily or selected-weekday execution, time zone
and retention; new schedules start disabled at 02:00 with seven-day retention.
Due jobs run serially and keep independent attempt dates and retention owners.
A failed destination does not prevent another due schedule from being considered.
Single-target settings migrate while preserving protected secrets, prior dates
and existing archive ownership. Invalid settings/state disable scheduling until
reviewed, rather than silently resetting dates.

S3 uses the pinned official AWS SDK, HTTPS endpoints, signed requests and
streamed single/multipart uploads. Delivery verifies staging and final bytes,
conditionally publishes without overwriting an existing key, and runs bounded
owner-specific retention only after success. Failed-run cleanup is limited to
the run's own object versions/upload IDs. Configuration downloads and full-data
offline restoration retain their documented scope and authorization boundaries.

Verification: 14 scheduler groups, 15 transport groups (including seven S3
groups), 20 backup UI groups, 20 authentication UI groups and five authenticated HTTP groups passed.
Production browser and gateway builds and locked default/Windows dependency
restores passed. Isolated browser checks verified type-specific forms, new
schedule defaults, cross-tab drafts, save/reload, local encrypted archive creation
and Restore presentation in dark/light themes. The independently authored
setup-required backup workshop and catalog walkthrough were updated and the
checkpoint project was explicitly published on the disposable gateway.
These checks use synthetic data and owned loopback fixtures; real domain SMB,
trusted remote FTPS, AWS account policies and S3-compatible-server delivery remain
environment-specific acceptance gates. The source feature is not included in the
preview.10 installer. See [scheduled backups](SCHEDULED_BACKUPS.md).

## Alarm and history configuration, 2026-09-30

Gateway Settings now separates **Alarms** and **History** into top-level tabs.
Each uses a searchable, paged list and one selected-rule property form. Both tabs
share a draft: switching tabs preserves edits, Save configuration applies both
as one revision, and Cancel changes restores both. Validation can select an
invalid rule in the other tab. New rules begin disabled, removal requires an
inline confirmation, and alarm journal retention has its own compact form.

Both tag-path fields offer **Browse** with searchable, paged configured tags and
source/type hints. Choosing a tag updates only the selected rule's draft;
manual paths remain supported. Loading, retry, empty results and stale responses
are handled without saving configuration or writing a tag value. The process
data documentation and setup-required workshop walkthrough describe this flow.

Verification: the production web build, 19 authentication UI groups and 16
process-data UI groups passed. Browser checks against an isolated synthetic
gateway verified both tag browsers, cross-tab drafts, validation navigation,
cancel and a saved revision followed by reload. Dark and light presentation
were inspected. This change does not alter recording behavior, alarm conditions
or gateway permissions, and does not expand device/site acceptance.

## Gateway Settings presentation, 2026-09-30

Configuration now uses accessible Tags, Connections and Public OPC certificates
tabs with keyboard navigation. The shared-resource refresh button was removed;
resource panels retain their refresh controls, and overview status refresh appears
only in Overview, Sessions and Diagnostics. Public OPC certificates use the same
heading and bordered form surfaces as the other management pages, with controls
sized to avoid clipped text. Checkbox labels align consistently across resource,
security, backup, deployment, alarm/history and recovery forms. Shared tag-folder
help no longer leaves punctuation below its example. The Designer's screen hint
places its lightning icon and title on one line.

Verification: production web build, source-boundary checks and existing UI checks
passed. An isolated gateway/browser pass checked tab keyboard activation,
certificate forms, account/backup checkbox rows, the shared tag help and the
Designer hint. This presentation change does not change tag-write permissions,
certificate trust or saved gateway configuration.

## Native button tag actions, 2026-09-30

Buttons now offer **Edit actions & events → On click → Set tag value** with a
configured tag browser, typed fixed values and a component-property picker.
References select self, another component in the same form, a scalar custom
property or the containing screen/template's name and dimensions. Input value
sources use the current scoped form values. Saved expression/query bindings,
assigned styles and validated Python UI overrides are reconstructed on the
gateway. Caption sources precede translation; inherited/theme-only appearance,
passwords and structured values are excluded.

Only explicitly published operator applications write. Both memory and OPC UA
targets require Commands permission and readable tag scope. Optional confirmation
uses a bounded, one-use reviewed intent; an existing equipment command's limits,
confirmation and readback take precedence. The gateway owns the saved target and
value source and rechecks publication, session, source dependencies and tag
configuration before dispatch. Uncertain writes are never automatically retried.
Reference search/deletion, copy remapping and custom-property editing preserve
the authored graph. See [equipment commands](EQUIPMENT_COMMANDS.md).

The setup-required equipment workshop now includes fixed, current input and
parent-property button examples using four independently authored synthetic
memory tags. This feature is in the source build, not the preview.10 installer.

Verification: the production web build and all 89 Node acceptance suites passed;
Gateway completed 22 suites and
1,164 checks, including 78 native action checks; Connectors completed four suites
and 179 checks. Nine authenticated command HTTP groups passed against an owned
loopback gateway. A separate loopback OPC UA fixture confirmed fixed and
property-sourced writes with readback and rejected a read-only target. Browser
verification covered the property picker, parent metadata choices, current input
review, cancellation without a write, confirmed memory readback, and one-click
fixed/parent writes. The setup-required workshop was loaded and explicitly
published on the isolated gateway. Device/site acceptance remains separate.

## Component runtime-property bindings, 2026-09-30

The browser and gateway now share a typed catalog for component runtime
properties. Component-specific rows and typed custom properties expose ƒx,
including nested chart settings, structured choices and datasets, input rules,
process displays, drawing/media properties, repeater layout and container pane
presentation. The property-sheet order remains General/Layout/Appearance,
component-specific settings, shared configuration, then Custom properties.

Expressions and named-query results resolve nested targets without mutating
saved definitions. Custom dependencies resolve recursively within their form;
invalid types, cycles, unavailable sources and inconsistent grouped values fail
with diagnostics. Structured values use bounded JSON text. Supplied table data
supports display/selection, while database editing retains its named-query
source requirements. Gateway input constraints and permissions remain
authoritative. Configuration IDs, scripts, declarations and initial form
defaults remain static; input state and template/query datasets retain their
dedicated binding editors. Existing scalar event watches are unchanged.

The [runtime bindings guide](RUNTIME_PROPERTY_BINDINGS.md) documents the contract
and independently authored portable workshop. Its maintained package is
`artifacts/sparkproj/runtime-property-bindings.sparkproj`. All **36 portable
workshops** passed authenticated import, explicit publication, operator
snapshot and re-export checks on an isolated loopback gateway. The full gateway
suite passed **1,086 checks across 21 suites**, including **44 runtime-binding
acceptance checks**. No installed or development gateway data was replaced.
This feature is not yet included in an installer.

The production web build and **88 frontend/tool suites** passed. Additional
focused checks cover same-render query dependency invalidation, transitive tag
updates, chart dataset precedence and explicit query preview prerequisites.
Live browser review verified component-specific ƒx rows, Custom properties last,
and workshop changes to chart limits/legend, table rows, repeater layout and a
source-controlled split ratio.

## Component property-sheet order, 2026-09-30

Every component now presents General, Layout and Appearance first, followed
immediately by its component-specific settings. Shared visual style, translation
and event settings follow those sections; Custom properties is always last.
The DOM and keyboard reading order match the visual order.

The production web build and **102 focused authoring checks** passed. Live
Designer review checked all **47 palette entries** and adding a custom numeric
property after the chart settings. Temporary project edits were undone without
saving or publishing. This change is available in the development Designer and
has not been packaged in an installer.

## Authored tag paths and demo isolation, 2026-09-30

Removed the old blanket reservation of `[default]Line` and `[default]Setpoints`.
These names are valid for configured tags, including the sample project's
`[default]Line/Line2/Temperature`. Optional demo generation now skips explicitly
configured paths, including disabled or unavailable tags. Authored setpoint
writes use their declared datatype and persistent memory state before any demo
fallback. Deleted ordinary tags under these folders are removed from runtime;
only the nine exact demonstration paths can be recreated in explicit demo mode.
Reconfiguring a tag as OPC UA clears its previous source value until acquisition.

**35 namespace checks**, **40 backend reliability checks** and **30 tag-capacity
checks** passed. They cover the reported temperature value of 666, persistence,
disabled memory/OPC and expression precedence, demo target fallback after direct
configuration removal, and unchanged definition caching/checkpoint behavior.
The authenticated HTTP tag-definition suite passed **14 groups** against a fresh
disposable gateway on loopback 5091, including saves under both folder names,
Python writes, invalid-path rejection and deletion. Windows DPAPI required the
HTTP fixture to run outside the restricted sandbox; no security setting was
disabled. The installed and development gateway data were unchanged. This fix
has not yet been packaged in an installer.

## Designer visual review, 2026-09-30

Property-sheet rows now share consistent text, control heights, help text and
wrapping buttons; non-bindable rows reclaim the unused binding-button column.
Collection and dataset dialogs render outside the compact property grid, and
container pane fields have a dedicated aligned layout. Duplicate React editor
keys were corrected. Publication review separates the version summary, operator
impact, saved-draft scope and script details; legacy restore warnings remain in
publication history rather than appearing on a new complete publication review.

Tags and Connections now use matching keyboard-accessible **New Tag** and
**New Connection** menus. The unsupported Designer `D` badge was removed.
Canvas fitting measures the actual content box, reserves scrollbar space and
clips the transformed canvas's unscaled layout bounds. Repeaters reserve their
own scrollbar space. The [view-container guide](VIEW_CONTAINERS.md) and existing
workshop catalog entry now include explicit authoring steps and prerequisites.

Browser review opened all **47 palette entries**, including template-dependent
controls, checked light and dark property sheets down to the 220-pixel pane
minimum, and inspected collection, input-rule, dataset and container dialogs.
Publication review was checked at narrow and short window sizes. Both creation
menus were checked through their source-specific forms without saving gateway
configuration. A constrained 3,200 × 2,400 canvas at minimum zoom retained stable
geometry across 20 observations with both scrollbars visible. Repeater wheel
scrolling advanced its rows and then the outer canvas at its boundary. Temporary
project edits were undone; no operator publication or equipment write was made.

All **75 frontend check suites** passed, alongside **31 unified-publication
checks**, **14 gateway view-container checks** and **11 workshop-build groups**
covering 35 examples. Two headless test harnesses were updated to provide the
document body used by detached modal portals while preserving their behavior
assertions. This is source verification, not a new installer release or a full
re-run of release acceptance.

## Preview.10 release verification, 2026-09-30

The unsigned Windows x64 installer and 35-project portable workshop bundle were
built from clean revision `e0b37332a9f19df00dd199edc1a0244c68d65209`.
[Windows/Linux product CI passed](https://github.com/SparkStudioX/src/actions/runs/36753658069),
as did the source-boundary workflow. This documentation-only evidence was added
after packaging; it is not the installer build revision. Companion assets belong
to [v0.2.0-preview.10](https://github.com/SparkStudioX/releases/releases/tag/v0.2.0-preview.10).

Installer size is **86,555,922 bytes**, SHA-256
`8babdff9ca6e4e0e8a2ca11c4cab8ebfe29d5189cf4634aa99e380c1eb81b7d8`.
The workshop ZIP is **375,046 bytes**, SHA-256
`93afd3e36e0edb3cf82dd007ea3d9a4a449339511f46a896b0aebbe115bc9197`.
Both manifests identify the same clean build revision. The payload contains a
61-component dependency inventory and third-party notices; notice-less NuGet
entries were checked against their declared MIT/Apache-2.0 package metadata.
This is a distribution inventory review, not a vulnerability or legal audit.

Exact-package acceptance verified **500 payload hashes**, bundled .NET paths,
actual CPython 3.14.7, the real process-bound installer readiness probe before
authentication, isolated first-account setup, 19 gateway/SSE smoke checks,
12 assets/popup checks, deployment/connection/query-cancellation checks and all
**35 workshop import/publication/operator-read/re-export round trips**. Helper
fixtures covered ownership, network identity/certificates, readiness, process exit
and unavailable debug privilege. Windows service registration, shortcuts, trust
stores and shared test credentials were unchanged.

The first production-default extraction reached readiness and passed setup/Python
checks with demo tags disabled; the older smoke suite then rejected its absent
synthetic tags. The successful complete run explicitly enabled demo tags only in
the disposable process, as documented in [the release process](RELEASE_PROCESS.md).
The packaged production default remains disabled. A separate restart without that
override passed **14 tag-definition HTTP groups**, including 10,000 accepted,
10,001 rejected, edits at capacity and cleanup. Browser acceptance with 10,000
synthetic memory tags verified 100-row pages, last-page navigation, filter/page
clamping, and the Designer's 200-match display with search reaching tag 9,999.
Browser error logs were empty. This is functional acceptance, not a browser
throughput or real OPC load measurement.

Local offline acceptance passed **97 suites**, including **1,006 gateway checks**.
The first Windows CI run exposed a host-speed-dependent queue fixture. Its
replacement controls admission occupancy, retains the production two-second
deadline, and passed all 139 focused Python event checks. A temporary negative
control resetting the budget after queueing failed the intended assertion;
restoring production code passed again. The final Windows/Linux CI run passed.

Evidence remains local under `artifacts/installer/verification-result.json`,
`.data/installer-verification-8b76953e63334ebc83067612d154da72/` and
`.data/test-results/`. Elevated preview.10 service installation/upgrade/uninstall,
rollback, full installed-data preservation, remote trust/SMB/FTPS, real SQL Server,
broader OPC interoperability and long-duration load acceptance remain open.
Docker and macOS distributions are not included. High-rate multi-session limits
remain as recorded in [load testing](LOAD_TESTING.md). GitHub publication and live
website deployment are separate final release gates.

## Reliability, security and process-data review follow-up, 2026-09-30

The subsequent capacity increment raises the gateway validation ceiling to
**10,000 expanded tags**, with indexed bulk imports, bounded 32 MiB tag-import
requests, paged tag/review lists and partitioned OPC watches. Thirty capacity
checks and forty backend regression checks passed. Memory loads at 1,000/5,000/
10,000 tags preserved all final and reloaded values. With 10,000 configured tags,
100 protocol sessions at 1,000 aggregate updates/second had 8 ms HTTP-read p95
and 970 ms SSE fresh-value-age p95. At 10,000 updates/second, 50/100 sessions
became slow (4.4/22.9 seconds SSE p95), despite correct final convergence; full
snapshot fallback and saturation of the same-host Node consumer were observed.
These high-rate runs are not acceptable live-delivery capacity claims. Historian
limits remain independent at 5,000 recorded tags and 2,000 alarms.

Initial isolated load tests measured the then-current **1,000-expanded-tag limit**
and rejected 5,000/10,000-tag imports without bypassing validation. Thirty-second
internal memory stages reached 125,000–174,000 writes/second with eight writers,
without network or historian overhead. The real operator transport sustained
1,000 aggregate tag updates/second with 1/10/50/100 independent sessions and no
final-value mismatches or disconnects. At 100 sessions, tag-read p95 was 6 ms,
SSE sample-age p95 was 956 ms, and gateway working set peaked near 164 MiB.
Historian recording with 1,000 tags and four concurrent query workers had
140 ms query-service p95 and 386 ms mean recorded intervals despite a 250 ms
fixed delay. All recorded quality, database integrity and reload checks passed.
These are short synthetic Windows desktop measurements, not production capacity
or real OPC/network/browser/soak acceptance. See [methodology and results](LOAD_TESTING.md).

Load preparation also exposed and fixed the readiness probe's incompatibility
with the Python worker's protected stdout descriptor. The probe now uses the
actual stdin/stdout protocol; 14 worker/protocol checks and six HTTP/startup
groups passed. No worker isolation mechanism was removed. Event-driven operator
delivery and historian read/recording separation remain
performance work.

The review follow-up adds administrator approval for changed executable publications and restores, operator Python tag scopes (including queued messages), raw-transport authentication checks, bounded password verification/Python workers and hardened response headers. Unchanged code with layout edits remains publishable by a project publisher. Authored Python and browser JavaScript remain trusted code; synchronous JavaScript loops are not isolated from the browser UI thread.

Tag definitions and connection plans are generation-cached, memory values use a coalesced durable checkpoint, and script diagnostics append outside the scheduler lock. Operator streams send bounded deltas and named heartbeats, with scope-change resets and connection caps. Project startup isolates invalid projects, draft writes flush before replacement, publication history is loaded on demand, and archived runtimes are evicted. The browser has application/component error boundaries, validated project payloads, path-indexed tag subscriptions, memoized tiles and separate Designer/Gateway bundles.

The review request reopens the previously deferred G14/G15 baseline: gateway-wide numeric alarms support priorities, hysteresis, quality-aware state, occurrence-bound acknowledgements and a local SQLite journal. Local raw tag history supports sampling/deadband, retention and bounded queries with explicit truncation. Alarm status, alarm journal and historical trend components bring the palette to **44 types**. Numeric inputs can invoke reviewed equipment commands on commit. Public OPC certificate administration, monitored-item deadband/queue settings and UInt16/UInt32 values are supported. See [process data](PROCESS_DATA.md) and [connection operations](CONNECTION_OPERATIONS.md).

This is a limited local baseline. Durable ingestion/replay, historical aggregation, alarm shelving/suppression/notifications, external identity, native device drivers and production-scale load/failure acceptance remain open. The catalog has **53 authored workshops: 35 portable and 18 setup-required**, including the synthetic alarms/history workshop. Product CI now builds on Windows/Linux, runs aggregate tests and retains JSON/JUnit reports. Source licensing is proprietary; release payload tooling produces an SBOM and existing third-party notices. Signing still requires a provisioned signing identity. No new installer release is implied by these source changes.

Acceptance passed **962 gateway checks and 163 connector checks on both Windows and Linux**, with actual CPython 3.14.7. The Windows offline aggregate passed 96 suites. Sixteen authenticated HTTP security groups passed on a fresh isolated gateway with forwarded-header middleware enabled. Browser acceptance covered numeric command confirmation/readback, alarm activation/acknowledgement, hysteresis at 78/74, retained history/journal, settings validation/Cancel, public-certificate controls and idle-session heartbeat stability. The container built and started as a non-root user with production demo generation disabled.

An explicitly authorized live Kepware check used the existing encrypted endpoint and certificate pin: one UInt16 tag was read at 0, written to 1, observed by readback and subscription, then restored and read back at 0 with Good quality. This establishes acceptance against that configured vendor server; it does not establish every underlying PLC/device or failure-mode matrix. The test gateway and credentials were disposable, and private evidence remains under ignored `.data/`.

## Component interactions, containers and application forms, 2026-09-30

The three application-workflow increments are implemented. D03 adds Python/JavaScript focus, blur, key down/up, double-click and pointer down/up in the staged Actions & Events editor. Payloads are bounded typed snapshots, password keys are redacted, and nearest-component ownership avoids nested event duplication. Retained inactive panes suspend authored handlers and messages and revoke queued or captured helpers.

D06 adds optional embedded, tab, split and dock containers over shared templates while preserving the free-positioned canvas. Pane identity and private state survive tab switches and dock closure; saved template paths, hidden references, cycles, expansion budgets and popup provenance are validated. Pointer sizing accounts for scaled canvases, and keyboard navigation/sizing is available. The workshop has authored navigation for application-only runtime mode. Flex/breakpoint layout and object snapping remain separate roadmap work.

The palette now has 41 component types and sixteen inputs. Formatted fields support bounded masks and ASCII case conversion; barcode fields preserve leading zeroes and commit repeated identical scans using Enter or Tab. Inline required/length/text-format rules are enforced again on gateway submissions and captured nested form contexts. Empty required defaults and incomplete local drafts remain editable. Tables support exact typed multiple row selection and staged atomic database batches: one transaction, complete membership validation, version checks, one increment per changed row and all-row rollback on failure. SQLite is verified; the SQL Server implementation still needs live provider acceptance. See [interaction events](COMPONENT_INTERACTIONS.md), [view containers](VIEW_CONTAINERS.md), [validated inputs](VALIDATED_INPUTS.md) and [table batches](TABLE_BATCH_EDITING.md).

Verification passed **813 gateway checks**, including **54 real SQLite atomic batch checks** and **61 interaction-event checks**, all **71 frontend suites**, five focused container gateway groups, five authenticated workflow HTTP groups, TypeScript/production build, 38 source-boundary regression groups and 11 workshop-builder groups. All **35 portable workshops** passed import, explicit publication, operator reads and re-export. The catalog contains **52 authored workshops: 35 portable and 17 setup-required**. Loose packages remain only in `artifacts/sparkproj/`; the verified development bundle is `artifacts/workshops/application-workflows-20260930-verified/` and records its dirty-source provenance.

Browser acceptance on isolated port 5093 covered formatted state-bound entry, repeated Python barcode commits and invalid scan rejection; focus/keyboard/pointer/double-click execution and password redaction; independent pane drafts, hidden-message suppression, nested Python/popup contexts, keyboard split resizing and pointer/keyboard dock resizing; batch Cancel, successful two-row Apply and later-row database-constraint rollback. Designer checks covered the common event editor, validation-rule rejection/Cancel and pane references in the property grid. Evidence is local-only under `.data/application-workflows-20260930/` and `.data/test-evidence/`. No installed gateway data or release assets were changed.

**G14 historian and G15 alarms are deferred at the user's request.** Remaining priorities include deeper Designer diagnostics/preview simulation and refactoring, conditional styles/localization, real SQL Server/OPC and service/container acceptance, external identity/secrets/durable audit, remaining component families, notifications/reporting, durable messaging and fleet/redundancy. This source increment is not a new installer release.

## Application releases, data, commands and consistent properties, 2026-09-30

G03/G17 now publish and restore screens, query definitions, Python libraries, browser resources and gateway events as one reviewed application revision. D01 adds live tag parameter sources and bounded, typed indirect addresses with authoritative gateway reconstruction. D04 adds strict rectangular datasets and nested query repeaters with shared concurrency, cancellation and stale-result guards. Supplied-data charts cover ten chart modes plus sparkline; this is not a historian implementation.

G10 adds immutable UDT versions, pinned instances, retained member overrides, named scan groups and default-provider lifecycle. G07/G11 add delegated gateway capabilities and a separate project Commands grant. Declared memory/OPC UA commands require typed review, a short-lived actor/revision-bound confirmation, current authority/value checks, a single dispatch and bounded readback. Failures after dispatch report uncertainty rather than silently retrying a device write.

All 38 component types use the same property-grid layout, including component-specific settings, appearance assignments, template parameters, input defaults and behavior launchers. Collections such as options, states, table columns and drawing definitions open staged editors from grid rows; supported bindings retain real ƒx controls. Apply, Cancel and Undo preserve their existing data contracts. This standardizes authoring without implying that structural settings have runtime binding support.

Verification passed **674 gateway checks**, **68 frontend suites**, **88 connector checks**, and authenticated acceptance for unified publication, commands, tag parameters, tag models and delegated access. Connector coverage includes seven real loopback OPC UA write/readback and rejection cases. All **32 portable workshops** passed import, explicit publication and re-export. The catalog now contains **48 authored examples: 32 portable and 16 setup-required**, maintained as loose packages only under `artifacts/sparkproj/`.

Browser checks covered all chart families, nested row isolation and popup context, complete publication review, command confirmation/readback/range rejection, and independent UDT upgrades: West moved to version 2 and 62.5% while East remained at version 1 and 75%. Inspector checks covered chart Apply/Undo and option collection Cancel/Apply/Undo. Evidence is local-only under `.data/roadmap-20260930/` and `.data/test-evidence/`.

This is current source work beyond preview.9, not a new installer release. Real device/vendor interoperability, SQL Server, service/container/platform acceptance, external identity, durable history/alarming and durable messaging retain separate roadmap gates.

## Preview.9 release verification, 2026-09-30

The unsigned Windows x64 installer and 29-workshop bundle were built from clean source revision `50d52b036ec26a1dc7ab18d399bf0fc7b145c219`. [Source CI passed](https://github.com/SparkStudioX/src/actions/runs/36706081588). This documentation entry was committed after artifact verification; it is not the installer build revision. Companion assets and release notes belong to [v0.2.0-preview.9](https://github.com/SparkStudioX/releases/releases/tag/v0.2.0-preview.9).

The installer is 86,319,296 bytes, SHA-256 `f677f719c1853e44f673a7373d4d90ec3a8e0ee27e04539d97d60c6473edbb27`. Workshop ZIP SHA-256 is `fb07b6ae0e3e5586b194d32b5a5a7273006f3bfdede440a9c2dfdfe20a436d11`; its clean source and version match the installer. Loose packages remain only under `artifacts/sparkproj/`, with the frozen distribution under `artifacts/workshops/0.2.0-preview.9/`.

Current-user extraction verified all **486 payload file hashes**, bundled .NET module paths, CPython 3.14.7 execution, installer readiness/authentication, the served browser hash, 19 gateway smoke checks, 12 assets/popup checks, deployment/connection/query cancellation checks and all **29 workshop import/publication/re-export round trips**. The helper passed 24 ownership/path checks, 85 network/certificate fixtures, 18 readiness checks and six process-exit checks, without changing service registration or certificate trust. Source regression passed 570 gateway checks, all 63 frontend suites (964 checks/groups), typechecking, 38 source-boundary fixtures and 11 workshop-builder groups.

The final extracted package separately passed nine authenticated HTTP/SSE scripting groups. Browser acceptance covered Python mounts, shared-editor syntax success/error positions and Cancel, local `self.text`/`self.value` effects, broadcasts to two same-login tabs, single-tab targeting, captured unmount text and fresh remounts without replay. Browser error logs were empty. Local evidence is in `.data/installer-verification-6a880723868442a8a78789d65cdfd110/` and `.data/test-evidence/lifecycle-session-424a8143-cda7-4d9d-9af8-37fc72eaa518/`; credentials and logs are not release assets.

This verifies the packaged local evaluation path. Elevated preview.9 service install/upgrade/uninstall, rollback, complete real-data preservation, remote browser trust, service-account/ACL behavior, real SQL Server/OPC interoperability and remote domain SMB/trusted FTPS remain separate acceptance gates. Messaging is bounded and transient; unmount cleanup is best effort. Docker and macOS are not released. GitHub asset publication and website deployment are separate completion gates in [the release process](RELEASE_PROCESS.md).

## Unified scripting, lifecycle and operator messages, 2026-09-30

D03 now has one staged **Actions & Events** editor for button/native actions, input events, lifecycle events and named messages. Apply commits the whole draft in one undo step; Cancel retains the previous definitions. Python supports mount/unmount plus template/repeater wrapper property/message handlers. Password controls support redacted, non-input Python events; their change/commit handlers remain JavaScript, and automatic snapshots exclude password values. Captured unmount context is read-only and cleanup is best effort. Static template identities now survive initial connection updates without remounting their children.

Python `self.value` and `self.props.value` read captured non-password input values and stage typed assignments to writable, unbound controls. Input, state and presentation effects validate as a complete batch, reject newer edits or retired forms, and do not recursively fire input events. Bound, read-only, dynamic-option and selection-backed fields retain their source rules. `self.text` continues to edit the caption, and a script with no returned result displays a successful completion instead of `null`.

Every shared script editor offers **Check syntax**. Python uses an isolated compile-only process with four gateway slots, a two-second deadline and bounded source; no authored statements or project imports execute. Invalid source reports positions, while unavailable/busy/timeout responses remain distinct failures. Design permission and CSRF remain required, including valid read-only/live Preview sessions. Common system API completions and context help cover components, gateway resources and table commits. Browser resources remain JavaScript; gateway and row-commit scripts expose their documented non-component contexts.

`system.ui.sendMessage` and `getSessionInfo` support same-project broadcasts and single-tab targeting from gateway events and Python actions. Server-issued identities distinguish tabs sharing one login. Authenticated SSE validates session/publication ownership, multiplexes tags, reconnects with fresh identities and never replays an old mailbox. Messages expire and queues/rates are bounded; receipts acknowledge queue admission, not handler completion. Durable shared state continues to use tags or databases. Python automatic events now have bounded waiting queues with cancellation and a total admission/execution deadline.

Verification passed **570 gateway checks**, **31 affected frontend suites (486 checks/groups)**, **eight compile-check model cases**, and **nine authenticated HTTP/SSE acceptance groups**. Coverage includes actual CPython execution, syntax checks that do not execute writes or infinite loops, Design-only checking, read-only Preview execution rejection, eight concurrent mounts, input effects, published gateway broadcasts, two same-cookie tabs plus a separate login, targeting, stale publication, cancellation and no replay. Browser verification covered shared-editor Apply/Undo/Cancel, Python mount/cleanup, read-only and Live Preview, syntax error positions, safe compile checks, live form assignments, self-renaming buttons, two-tab broadcasts/targeting and navigation without replay. Console logs were clear. Production compilation passed with the existing large-chunk advisory. Source-boundary checks passed; no installer update is included.

The new [lifecycle/session workshop](LIFECYCLE_SESSION_WORKSHOP.md) passed import, explicit publication and re-export. The catalog contains **41 authored examples: 29 portable, 12 setup-required**. Loose packages and guides are maintained only in `artifacts/sparkproj`; versioned workshop bundles contain immutable ZIPs and manifests. Local evidence is under `.data/test-evidence/lifecycle-session-*`.

The reported Windows crash was identified in application logs: `GatewayBackups.Dispose` attempted to cancel a disposed token during host teardown. Disposal is now idempotent and active backup tasks retain a captured cancellation token. All eight backup-schedule groups passed, including actual singleton/hosted-service dual ownership and repeated concurrent cleanup. Development watch mode rebuilds/restarts the gateway instead of hot-reloading its service state; Vite retains browser updates. A real source-timestamp change stopped the old gateway and started a new process cleanly. Port 6090 returned ready with Python available after both initial startup and the automatic restart.

## Python component events and work-order workshop, 2026-09-30

D03 extends gateway Python beyond button actions to input change/commit, watched scalar property changes and named component-message receivers. Supported new handlers default to Python; existing JavaScript handlers retain their language. Staged editors keep separate language drafts and expose event/context help. These handlers use the scoped `self` and `system.ui` effects from the earlier button increment. Mount/unmount and password or template/repeater wrapper handlers remain JavaScript; ordinary children inside templates and repeated rows support Python. See [Python component events](PYTHON_COMPONENT_EVENTS.md).

Runtime selects code from the captured publication and hides Python handler source from operator projections. Saved-draft Preview uses its existing live-action capability. Selectors, event identities, inputs, property watchlists, message bounds and instance membership are validated. Incomplete numeric edits and unrelated unavailable inputs reach scripts for validation; password values do not enter automatic-event snapshots. Gateway execution has a two-second deadline, four concurrent events per project, sixteen per gateway and actor/project rate bounds. Browser response guards allow three seconds including transport. Input and lifecycle/message families retain separate bounded queues. Owner cancellation, stale publication checks, conflict detection and atomic UI-effect application remain in force; earlier gateway writes are not rolled back by failed UI responses.

Verification passed 440 gateway checks, including 84 new cases with actual CPython, negative authority checks, unavailable inputs, numeric display properties, cancellation and concurrency/rate limits. Fourteen focused browser-model groups cover transport, scope, queuing, stale effects, response timing and clearing old inline errors; nineteen authoring groups cover language defaults, separate drafts and restrictions. Eight authenticated acceptance groups passed import/publication/re-export, runtime source hiding, input/property/message execution, repeater membership, permission/CSRF checks, saved Preview and draft/publication isolation. Existing input, lifecycle, message and Python UI regressions passed. Production compilation passed with the existing large-chunk advisory.

The independently authored work-order workshop has two private form placements and repeated rows, order selection, quantity validation, local draft storage and instance messages. It creates no gateway data and requires no external database/device. Browser verification covered independent forms, repeated rows and tabs; empty numeric edits; literal text; message resets; separate language drafts and Cancel; read-only Preview and actual standalone Live Preview. The catalog now contains 40 authored examples, including 28 portable packages; all ten workshop-build groups passed. Evidence remains under ignored `.data/test-evidence/python-component-events-*`. The development server on 6090 uses the current build. Cross-tab messaging, Python lifecycle, shared transactional work-order persistence and a new installer remain separate work.

## Python UI actions and workshop, 2026-09-30

D03 now lets a button's gateway-side Python event change the calling browser's presentation through `self.text`, `self.props`, sibling/parent proxies and `system.ui`. Direct and `props` access share validation; unsupported or read-only assignments fail explicitly. Declared session, screen and private template/repeater state stays scoped to its live owner. Shared changes use existing gateway tags or database records and bindings; this increment does not add a continuously synchronized server-side component tree or cross-session UI broadcasts. See the [Python UI contract](PYTHON_UI.md).

The gateway resolves component identity against the same published action, validates bounded snapshots and stages a coalesced effect batch. Failed scripts discard UI effects; earlier tag/database writes retain their existing immediate behavior. Browser application validates the whole batch, detects conflicting edits and rejects responses from retired or replaced contexts. Bindings cannot be overwritten by property assignments. Designer Live Preview resolves saved screens and standalone templates and requires its existing live-action capability; read-only Preview blocks execution.

Verification passed 356 gateway checks, including actual CPython proxy calls, direct aliases, read-your-writes, invalid/bound properties, snapshot and scope validation, spoofed effects, failure cleanup and deadlines. Eighteen browser-model groups cover atomic application, conflicting edits, stale lifetimes, independent placements and literal button captions. Ten authenticated acceptance groups passed portable import, publication, re-export, real Python actions, two operator cookie jars and shared tags, engineering/operator separation and the actual capability-gated Preview endpoint. Existing state, instance-state, lifecycle and messaging regressions passed. Production browser compilation passed with the existing large-chunk advisory; source-boundary checks passed.

Browser verification confirmed isolated operator tabs, independent repeater rows, shared-tag updates in both tabs and failed-action UI rollback. Designer Live Preview verified `self.text = "hi"`, repeater property/private-state isolation and standalone template property/state updates; read-only Preview blocked Python. The authored Python UI workshop adds a self-renaming button and is included among 39 authored examples, including 27 portable packages; all ten workshop-build groups passed. Evidence remains under ignored `.data/test-evidence/python-ui-workshop-*`. The development server uses the updated worker; no installer or installed-service update is included.

## Browser component messaging and workshop, 2026-09-30

D03 now includes named JavaScript component message handlers, a staged property-sheet editor and native **Send message** button actions. `app.sendMessage(messageType, payload, {scope})` is available to browser, input, lifecycle and message scripts. Exact instance, screen and single-tab session scopes preserve independent template placements, repeated rows and popup lifetimes. Popup screens have separate screen scopes; session messages include the current screen and its popup. Gateway-to-browser transport and delivery across operator tabs remain future work. See [component messaging](COMPONENT_MESSAGING.md).

Handlers share the existing ordered 32-event component queue, two-second async deadline and application feedback breaker. Payloads are detached and frozen, bounded to 64 KiB, 4,096 nodes and 16 nested levels. Subscriptions retire on closure or replacement; expired callbacks cannot regain authority after a same-key remount. Disabled or hidden mounted components remain automatic listeners. Read-only Preview blocks authored delivery. A synchronous receipt reports queue admission, not successful completion or durable delivery.

Verification passed 237 gateway model checks (including 130 message validation/preservation checks), 17 message-bus groups, four sender-helper groups and eight staged-editor groups, alongside the existing input, browser, state and lifecycle regressions. Production browser compilation passed with the existing large-chunk advisory. Ten workshop-build groups cover all 26 portable examples; the catalog now has 38 authored examples. The messaging package passed authenticated import, invalid-save rejection, explicit publication and re-export on an isolated gateway.

The in-app browser verified native button and input senders, independent repeated rows, screen broadcasts, separate popup scopes, session broadcasts, separate browser tabs, zero receivers after navigation and fresh state on return. Designer Apply/Undo and Cancel behaved as specified; read-only Preview did not deliver messages. Browser warning/error logs were empty. Visual inspection found and corrected a low-contrast workshop button. Evidence stays under ignored `.data/test-evidence/component-messaging-workshop-*`; these tests use synthetic data and do not modify installed or development projects.

## Gateway event execution and workshop, 2026-09-29

G17 now implements seven gateway event families: startup, update, shutdown, timer, tag change, message and scheduled. Saved/published options are validated together; existing startup and fixed-delay definitions remain compatible. Timers add fixed-rate scheduling that skips overruns, calendar jobs use numeric five-field cron with explicit time zones and DST rules, and tag observers support exact paths or terminal folder wildcards with initial samples, qualified previous/current values and value/quality/timestamp filters. Project, script and query saves, asset additions and changed project publications notify the active Update handler with actor/resource metadata.

Each resource has a non-overlap lease, a 100–300,000 ms deadline and a dedicated or project-shared execution lane. Startup finishes before external event admission. Replacement cancels and drains the old generation, allows an aggregate ten-second shutdown window, then starts the new one. Message requests enforce audience, Operate/admin permission, CSRF and optional publication revision; Python supports same-gateway synchronous, asynchronous and one-way delivery. Recursive calls, shared-lane synchronous deadlocks and saturated queues fail explicitly. A request's deadline also expires while queued, preventing later execution of that expired request.

Administrator cancellation and the latest 100 bounded run records are available in Designer. Records include actor, trigger, revision and available message/tag correlation, survive restart, and distinguish interrupted runs. Unreadable history is preserved with a visible persistence warning while current diagnostics remain in memory. This history is separate from security audit and durable job delivery. Message/tag queues are volatile, missed cron occurrences are skipped, shutdown is best effort, and accepted cross-project sends belong to the destination. Atomic screen/query/script releases, cross-gateway messaging, durable replay and broader service/container/platform/load acceptance remain open. The independently authored CPython helpers do not establish Java/Jython compatibility.

The Windows source build passed without warnings/errors. Checks passed for 107 option/cron/store/journal cases, 13 live gateway-event groups and all 14 existing script-resource regressions. These covered an actual cron minute boundary, startup messaging, wildcard tags, permission/revision failures, queue saturation and queued deadlines, cross-project dispatch, manual/shared-lane deadlock prevention, worker deadlines, cancellation, replacement ordering and restart history. The portable workshop passed import, explicit screen/script publication, echo execution and re-export on a separate disposable gateway. All seven workshop scripts are disabled on import. The new package brings the catalog to 37 authored examples, including 25 portable workshops. See the [gateway events guide](GATEWAY_EVENTS.md).

The Designer browser showed all seven workshop resources, timer/tag/schedule settings and successful published-message results without console errors. TypeScript/production browser builds, all ten workshop-build groups and all 38 source-boundary fixtures passed. Automatic approval review blocked a disposable browser timeout edit/save check requiring explicit confirmation; that UI mutation remains unverified, although backend option persistence and validation passed.

Tests used owned fixtures on ports 5091/5092 under ignored `.data/test-evidence/`. The installed gateway, its projects and public preview.8 installer were not updated by this source increment.

## Installer-generated HTTPS certificates and preview.8 release, 2026-09-29

Network setup now offers **Generate a self-signed certificate (no files needed)** alongside existing PEM certificate/key import. Generation uses a fresh RSA-3072 key, SHA-256 signature, exact DNS or IPv4 subject alternative name, server-auth usage and non-CA constraints. The certificate lasts one year with a five-minute starting clock allowance. Preflight validates the requested identity without creating files; installation writes the private key with explicit restricted permissions, validates the persisted pair, and then stages the listener. Default **Keep existing listener settings** upgrades preserve certificate identity and expiry.

Setup exports `gateway-public.cer` and `gateway-trust.txt` in the protected deployment certificate directory. The public-only export includes no key; the guide records the operator URL, SHA-256 fingerprint, expiry, deliberate operator trust and manual renewal. No OS/browser trust or firewall rules are changed. Imported certificates also refresh the public export with CA-specific guidance. Deployment rollback restores earlier export bytes/permissions and removes newly generated files. The network workshop, installer guide and Gateway Settings text explain both certificate paths.

The helper compiled without warnings/errors and passed 24 ownership, 85 network/generation/trust/ACL/rollback, 18 readiness and six shutdown checks plus privilege-scope checks. Generated DNS and IP certificates each passed real local TLS, exact identity validation, private-key ACL inspection and Windows chain validation with only their public certificate as an explicit test trust anchor; normal OS trust still rejected them. Failed replacement restored the exact earlier deployment/export bytes and public-file permissions. TypeScript/production browser build, all 38 source-boundary fixtures and nine workshop-build groups passed. Fixtures did not modify the Windows certificate trust store or installed service.

Published [preview.8](https://github.com/SparkStudioX/releases/releases/tag/v0.2.0-preview.8) from clean source `a8c9106adbbee5c9501e203e988581a68eae2a66`. Source-boundary CI passed. The exact installer matched all 486 payload hashes, reran the helper checks above, and used its bundled .NET and CPython 3.14.7. Nineteen gateway/SSE, 12 asset/popup, three deployment, four connection and three query-cancellation checks passed; all 24 portable workshops passed import, explicit publication, operator reads and re-export. Windows integration and shared test credentials remained unchanged. The 11 release assets matched local sizes and SHA-256 digests; installer SHA-256 is `dfd70032746b442c20c3826f8887e2e5a2504c178b078bca53e426afa5ab3e3c` (86,235,178 bytes). The website's download links were updated to preview.8.

Actual elevated service installation, a second computer's browser trust and firewall traversal remain separate acceptance gates; existing preview.5/preview.7 evidence does not establish them. The installed gateway and data were not used for fixtures.

## HTTPS by IPv4 address and preview.7 release, 2026-09-29

Network HTTPS now accepts either a DNS hostname or a specific canonical IPv4 address while retaining the existing IPv4 wildcard listener and separate loopback management port. IP identities require an exact `iPAddress` subject alternative name; numeric DNS entries and Common Name fallback do not qualify. Wildcard/unspecified, multicast/reserved, abbreviated and IPv6 identities are rejected. Certificate validity, matching key, server-authentication usage and operator trust requirements remain unchanged. A fixed IP or DHCP reservation avoids certificate mismatch when the gateway address changes.

Nine deployment model/TLS groups passed, including a real TLS request with an IP URL routed only at the socket layer to a loopback fixture. Platform certificate-name validation accepts the matching IP SAN and rejects a different IP; host filtering also retains its explicit policy. The installer helper passed 24 ownership, 43 DNS/IP network, 18 readiness and six shutdown checks, plus privilege-scope checks. These fixtures pin their synthetic certificate without modifying the Windows trust store and do not establish remote browser trust or elevated service acceptance.

Preview.6 was built from clean source `d34d4f70041a12a8e9307ad2468b0e707b96e924` and held as an unpublished candidate after the installer IP-address restriction was reported. Its exact extracted package matched 486 hashes and passed bundled .NET/CPython execution, gateway regressions and all 24 portable workshop import/publish/re-export checks. A separate packaged-executable exercise created and downloaded a configuration archive, inspected/restored it through the packaged CLI, preserved the disposable administrator and enforced recovery blocking. Preview.7 package and installed-service acceptance are recorded separately after completion; none of these fixtures changed the installed service or data on port 5090.

Published [preview.7](https://github.com/SparkStudioX/releases/releases/tag/v0.2.0-preview.7) from clean source `8c86b9b5e7dc4416c843d2bdc970f67e2098a510`. Its exact installer matched all 486 payload hashes and passed bundled .NET/CPython execution, 19 gateway/SSE, 12 asset/popup, three deployment, four connection and three query-cancellation checks. All 24 workshops passed import, publication, operator reads and re-export. The final extracted executable separately passed all four backup API groups, created and downloaded an encrypted configuration archive, inspected/restored it through the packaged CLI, restored the disposable administrator and enforced recovery quarantine. Source CI passed; all 11 uploaded assets matched local SHA-256 and the public installer download returned HTTP 200. Installer SHA-256 is `b876d3862326663631e4da2afd65d3b913c23235483b6684131a24348d5fcdfc`. The user deferred elevated installation and destination setup; real service/network/remote-share acceptance remains pending. Scheduling stays disabled until configured.

## Scheduled configuration backup and preview.6 preparation, 2026-09-29

G03 now includes **Gateway Settings → Recovery** controls for encrypted configuration downloads and daily remote backup delivery. A running gateway captures saved projects, publications/scripts, assets, connections/tags, account settings and protected keys under a shared bounded configuration lock. It excludes live databases, historian/audit data and unrelated files; the authenticated archive and restore receipt identify that scope and its exclusions. Private staging has a durable quarantine marker before plaintext capture. Encryption and transfer run after releasing the configuration lock. The existing offline full-data backup remains available for a stopped gateway, and external databases still require separate backups. See [scheduled backups](SCHEDULED_BACKUPS.md) and [offline recovery](GATEWAY_RECOVERY.md).

Schedules are disabled by default, with **02:00 in the gateway time zone**, seven-day retention and a 300-second transfer deadline. Administrators can request a local download or an immediate destination copy before enabling the schedule. Backup credentials and the archive passphrase are protected on disk; settings responses exclude them. SMB supports an explicit network identity or the service identity. FTP is explicit and sends its credentials without TLS; FTPS retains strict server-certificate validation. A new encrypted archive uploads to a unique partial name, is read back for length/SHA-256 verification, and is renamed before retention. Cleanup considers only this gateway's exact generated archive names and dates. Failed transfers do not trigger retention; successful copies with incomplete retention report a warning. Native UNC calls can outlast cancellation, so their single worker retains ownership until Windows returns.

Four real-store configuration snapshot groups, seven schedule groups, four authenticated backup API groups, eight destination transport groups, ten offline recovery groups and four quarantine regressions passed. Transport checks use local files and an actual loopback FTP protocol fixture: upload/readback/rename order, same-size corruption, upload failure, bounded listing, cancellation, post-promotion retention warnings, malformed/nested/foreign filenames, credential/server-reply redaction and rejection of an untrusted FTPS certificate before credentials. Eight frontend groups passed. Browser checks on disposable port 5091 created a local archive and showed its ready/succeeded state; the authenticated download API returned the exact encrypted bytes, but the browser download-event listener timed out, so delivery of a browser-downloaded local file is not claimed.

The independently authored [Scheduled backup workshop](../../examples/scheduled-backups.json) has a read-only published A checkpoint and an editable B draft exercise. Its authenticated loader creates a separate project and publishes only with an explicit option; it does not configure schedules or credentials. The catalog now has **36 authored sources: 24 portable and 12 setup-required**. The new backup example is setup-required because gateway schedules, secrets and remote destinations are outside a project package. Its loader and explicit publication passed on disposable port 5091. Source policy passed 488 worktree entries and all 38 regression groups; all nine offline workshop-build groups passed across the unchanged 24 portable projects.

Preview.6 version defaults and installation guides are prepared. Package extraction, release publication and an elevated preview.6 upgrade are separate gates recorded when actually completed. Real domain SMB under LocalService or supplied credentials, a trusted external FTPS server, remote HTTPS browsers and the new elevated network wizard still need acceptance. Prior preview.5 service-upgrade evidence does not establish these new paths. Service switching, cross-version migrations, production-scale recovery and atomic project/script-library/job releases remain open. Installed port 5090 and its data were not changed by these fixtures.

## Previous offline recovery, tag engineering and installer network settings, 2026-09-29

This records the earlier increment. Its statement that online/scheduled backups remain open is superseded by the newer configuration-backup scope above; remaining full-recovery and deployment gates still apply.

G03 now has a passphrase-encrypted, offline whole-data-directory `.sparkbak` command set and Gateway Settings → Recovery. Authenticated manifests, bounded records, path/digest checks, private staging and a new-destination-only rename preserve the original data. Restored gateways force localhost, suppress OPC secret loading and all connector/Python work, and block operator APIs until an administrator reviews the receipt and explicitly restarts. The shared directory lease excludes cooperating gateway processes. Older binaries and other writers must be stopped separately. DPAPI keys retain their original machine/account binding; the matching application build is required. Online/scheduled backups, service switching, cross-version migrations and atomic project/script-library/job releases remain open. See [recovery](GATEWAY_RECOVERY.md).

Ten offline recovery test groups and four quarantine groups passed, including corrupt/truncated/wrong-passphrase archives, SQLite WAL, protected keyring recovery under the same identity, malformed manifests, links, bounded inventory, competing processes, interrupted extraction, promotion collision and inherited listener/Host restrictions. A disposable full-host exercise on 5091 preserved all 14 source files (31,595 bytes) by SHA-256, retained account grants and distinct draft/publication checkpoints, and restored a managed SQLite database. Its startup job did not run during quarantine or after approval in the same process; it ran after the deliberate restart. This tiny local fixture measured backup 506 ms, inspection 395 ms, restore 477 ms and restart-to-ready 1,744 ms. These are fixture observations, not production recovery targets. Its source directory remained unchanged.

G10 adds bounded scalar expression tags with named dependencies, cycle/depth limits, typed values, quality propagation and source timestamps. Administrator-only export and additive bulk import use a complete validation preview, content/revision checks and one atomic definition-file replacement. Designer provides expression input fields and a reviewed import dialog. Seven model groups, two authenticated API groups and 13 prior tag-definition regressions passed. Browser verification exercised 20 counts / 30 seconds → 40 per minute, a false limit condition, division-by-zero unavailability in both derived tags and recovery after valid input. Provider lifecycle, named scan groups and versioned UDT definitions/instances remain open. See [tag engineering](TAG_ENGINEERING.md).

The installer now offers Local only, Network HTTPS and Keep existing settings for upgrades. Installed mode retains local HTTP management/readiness and optionally adds HTTPS on all IPv4 interfaces with a separate port and certificate-matching DNS hostname. PEM key import uses restricted filesystem permissions; conflicting external listener overrides fail closed. Certificate trust/firewall changes are not performed implicitly. Eight deployment/TLS model groups, helper ownership/network/readiness/shutdown checks, TypeScript and inert-payload Inno compilation passed. This new wizard has **not** yet passed an elevated installed-service upgrade or a separate operator computer's certificate-trust test; no new release was published for this increment. Certificate renewal, proxy administration and container lifecycle acceptance remain open. See [network access](NETWORK_ACCESS.md).

All three increments have independently authored setup-required workshops in the example catalog. The recovery and tag examples passed project package round trips; the connectivity loader created and published its independent read-only screen. Browser checks also verified the expression property editor, tag-import preview followed by cancellation without adding a tag, and network hostname/certificate fields followed by discarding the unsaved draft. The final gateway build had zero warnings/errors, all 18 gateway smoke checks passed, and all 38 source-boundary fixtures passed. The installed 5090 gateway and its data were not modified.

## Windows upgrade shutdown barrier, 2026-09-29

An elevated preview.3 upgrade over a running preview.2 service reached file copying about 110 milliseconds after the service reported stopped, while its process still held `clrjit.dll`. The installer displayed Access denied; a later Retry succeeded. Preview.3 was held from public release. Service status alone was not a sufficient file-replacement barrier.

Preview.4 added a verified process handle before STOP and a wait for both the service to stop and that exact process to exit within one 40-second deadline. Its exact extracted package passed 486 payload hashes, bundled runtime/readiness checks, gateway regressions and all 24 workshop roundtrips. However, the actual elevated upgrade failed before STOP or file copying: opening the LocalService process with query/synchronize rights was denied. The installed preview.3 service remained running. Preview.4 was also held from public release; same-user process tests had not covered this service-account access case.

Preview.5 retains the process-exit barrier. Only if direct handle acquisition returns Access denied, it temporarily enables the elevated helper's existing `SeDebugPrivilege`, requests the same minimal query/synchronize rights, and restores the original privilege state immediately. Missing privileges and failed restoration abort preparation. No Windows policy or target-process permissions are changed. The helper rejects ambiguous pending service states before copying and never terminates a process to force an upgrade. An already-stopped service does not expose a valid former PID; the helper does not guess or kill a lingering process from an externally initiated stop.

Independent source review and the helper build passed. The helper passed 21 ownership checks, 18 readiness checks, six shutdown checks and an absent-privilege rejection/state-preservation check. The shutdown fixture maps a real Windows DLL that stays locked after a simulated stopped notification. An actual user-approved elevated, read-only diagnostic then confirmed direct access denial on the installed LocalService process, successful scoped privilege fallback, exact privilege-state restoration and unchanged running service. At that point the exact preview.5 package and running-service upgrade still required verification; the read-only check alone did not establish upgrade acceptance.

Those two preview.5 gates subsequently passed. The installer built from clean source `d3b931edd7af3a6edf87567685c3ca83554ce270` (SHA-256 `b4abdb3b4e6a4a3c815254eb0116a8024c00ee81177d2c8925983c080093cf3c`, 86,125,174 bytes) passed all 486 extracted payload hashes, bundled .NET/Python checks, authenticated API regressions and all 24 workshop import/publication/operator/re-export roundtrips. The isolated checks left Windows service/registration integration unchanged.

An actual user-approved elevated upgrade then replaced the running installed preview.3 on the same Windows host. Setup exited zero with no access-denied/file-copy error, no Retry and no Windows restart. The installed service resumed as LocalService/Automatic on 5090 with a new PID; readiness matched that PID and confirmed bundled Python. All 486 installed payload hashes, product/source version and served browser entry matched the tested package. The configured ProgramData path was retained and no account reset was performed. Full live-data integrity, credential portability, rollback, uninstall and other hosts remain outside this acceptance check. The embedded install notes reflect the earlier package freeze; the accompanying release guide records this later upgrade result.

A reversible account-reset procedure was verified using disposable extracted-gateway data only: moving `security/identities.json` to a protected backup returned setupRequired and generated a new local setup code. All 118 tracked project, asset, catalog, connection, tag and audit files were unchanged; the backup content and ACL were retained. The temporary gateway was stopped after the check. Installed accounts and ProgramData were not modified. See the [reset instructions](WINDOWS_INSTALLER.md#reset-accounts-with-a-reversible-local-backup).

## Setup guidance and Designer version display, 2026-09-29

The first-run engineering page now identifies the Windows installer's default setup-code file, shows the administrator PowerShell command to read it, and explains that the code rather than the path belongs in the form. Portable/development/container guidance remains separate. Initial setup no longer focuses a lower form field and scrolls past those instructions. No setup-code value is exposed or fetched by the browser.

The Designer gateway card separates connection status from a compact release version; full build metadata remains in its tooltip and diagnostics. A missing version is reported as unavailable. TypeScript and the production build passed. An isolated loopback browser test showed the setup instructions, full path and form; authenticated Designer showed the short version on its own line, retained its full build tooltip and had no card overflow or browser warnings/errors. This UI test used disposable data on 5091 and the preview.2 backend; the installed 5090 service was untouched. Screenshots remain in ignored `.data/test-evidence/setup-code-guidance.png` and `designer-short-version.png`.

## Windows installer readiness correction, 2026-09-29

The actual `0.2.0-preview.1` service installation failed its 45-second readiness check: the helper polled authenticated `/api/health` without a session. Windows recorded service creation without a corresponding startup crash; the helper removed the newly created service after the timeout and retained `%ProgramData%\SparkStudio`. The earlier extraction tests did not exercise this installation check.

The `0.2.0-preview.2` correction introduces a separate anonymous, raw-loopback-only `/api/ready` endpoint with four fields and no cached responses. One bounded startup check exercises the bundled Python worker with fixed empty inputs; polling cannot execute project code. The installer checks this endpoint against the running service PID, without redirects or a proxy. Health diagnostics and all other API permissions remain protected. The extraction verifier now invokes the actual helper probe before first-administrator setup and checks readiness and denied anonymous health access both before and after setup.

Six readiness model/Kestrel groups passed, including the real bundled interpreter, failed and hanging workers, cancellation, cached observations and raw-peer enforcement despite rewritten request addresses. The helper passed 21 ownership/path checks and 18 readiness protocol/PID/failure checks. Source-boundary tests passed 38 groups and workshop-build checks passed nine groups.

The exact `0.2.0-preview.2` installer packages clean source commit `05cc9bf65e79e21500e1a01c9468fe8c220dc0e2`. Its 86,111,769 bytes have SHA-256 `92b56316bf9dce17cd1510145814638793cc1304a66f60fadcbf183149873369`. Current-user extraction matched all 486 payload file hashes without creating or changing Windows services, registration, shortcuts or an uninstaller. The extracted helper's actual read-only readiness probe succeeded against the expected gateway process in 0.18 seconds, before any account setup or authentication.

The extracted gateway returned the exact four-field, process-bound readiness response before and after local administrator setup, denied anonymous health access, and rejected invalid readiness verbs and unknown APIs. Its reported version/source identity matched the package. With external runtime paths unavailable, loaded .NET modules came from the extracted package and bundled Python 3.14.7 executed successfully. The served browser entry `index-Bk39a3Cg.js` matched SHA-256 `ce4ee3bfdb97e47a311be2fbcbccbfe75b1f2efabf71619272fe0fa34e3759ec`.

Package regression checks passed 19 gateway/SSE checks, 12 asset/popup checks, three deployment-settings groups, four connection-operations groups and three query-cancellation groups. All 24 portable workshops passed import, explicit publication, operator snapshot/read checks and re-export against this exact extracted package. Shared test credentials were preserved, and the development server on 5090 remained stopped for the user's installer. Verification evidence remains under ignored `artifacts/installer/verification-result.json` and `.data/installer-verification-*`.

The automated package test did not install or modify a Windows service. A subsequent user-run installer retry with UAC produced a running, automatic-start `SparkStudio` service under `NT AUTHORITY\LocalService`, using the expected Program Files executable, retained `C:\ProgramData\SparkStudio` data-directory argument and loopback port 5090. Read-only inspection matched service PID 21072 to the HTTP 200, `no-store`, four-field readiness response with working bundled Python. The installed assembly reported file version `0.2.0.2` and product version `0.2.0-preview.2+05cc9bf65e79e21500e1a01c9468fe8c220dc0e2`.

The setup log recorded successful installation completion and no Windows restart requirement. Anonymous health access returned 401 on the installed service. This establishes the successful installation retry, service startup and corrected readiness handshake on this host; service upgrade/uninstall, comprehensive ACL checks, existing encrypted-credential access and broader recovery remain unverified. Evidence is retained under ignored `.data/release-0.2.0-preview.2/installed-service-verification.json`. The correction does not close the remaining G04–G06 deployment or provider acceptance gates.

## Previous Windows preview 0.2.0 release verification, 2026-09-29

The [v0.2.0-preview.1 release](https://github.com/SparkStudioX/releases/releases/tag/v0.2.0-preview.1) packages clean source commit `a32a9994d1416d31d16590337c1ffe5e5515d888`, including the G04–G06 increment below. The installer, standalone installation guide, 24-project workshop ZIP, payload manifest and checksums are public release assets. The website linked directly to this version at its publication; that historical release is superseded by the readiness correction recorded above. Source policy and its CI passed; no private reference material or saved gateway data entered the payload. Production browser source maps are excluded, and notices cover all 22 browser production dependencies.

The exact 86,095,259-byte installer has SHA-256 `c19a9223808cdeba1724f463d1634d70a5f488b0d99b375a0f799c98ab0c6f83`. Current-user extraction matched all 486 payload file hashes and left Windows service, registration, shortcut and uninstaller state unchanged. With external SDK/Python paths unavailable, the extracted gateway loaded bundled .NET modules, executed bundled Python 3.14.7, completed first-administrator setup, denied anonymous health access and reported its exact version/source identity. Its served browser entry `index-Bk39a3Cg.js` matched SHA-256 `ce4ee3bfdb97e47a311be2fbcbccbfe75b1f2efabf71619272fe0fa34e3759ec`.

Twenty helper guards, 19 gateway/SSE checks, 12 asset/popup checks, three deployment-settings groups, four connection-operations groups and three query-cancellation groups passed. All 24 portable workshops from the same clean source passed import, explicit publication, operator snapshot/read checks and re-export. The workshop ZIP hash is `d28cbddc1d90254b14e77ac6f08a14449b1399a4e09bbbf1bf067313a378c491`; eight setup-required examples remain separate. Verification tools were corrected to use a portable Node preload specifier and the catalog's actual default project identity. These test-only fixes do not change the packaged application.

The unsigned preview's accepted path remains loopback current-user extraction. Elevated service installation, LocalService execution, service upgrade/recovery/uninstall, remote transport, real SQL Server and Docker/macOS acceptance remain open. The release does not close every G04–G06 gate. Local verification used a fresh data directory on 5091; shared test credentials and the running 5090 application were preserved. Evidence stays under ignored `artifacts/installer/verification-result.json` and `.data/installer-verification-*`.

## G04–G06 operations increment: local verification, 2026-09-29

**G04:** Deployment now includes revisioned listener validation, save, disable and previous-intent restore. Saved intent, startup intent and actual listeners remain distinct; saving never restarts or rebinds the gateway. HTTP/HTTPS is limited to `127.0.0.1` or `::1`, with offline PEM references and key/date/SAN/server-auth checks. Explicit host overrides win. Invalid configuration or missing keys retain the fallback listener; failed recovery writes preserve the previous usable file. See [Deployment settings](DEPLOYMENT_SETTINGS.md).

**G05:** Connection saves and renames require the current revision. Disable cancels tag watches, invalidates their callbacks, marks bound values `Bad_Disabled`, and blocks new connection/query operations. Timestamped read tests persist only for the latest-started test against the same configuration revision. Diagnostics list tags and draft/published queries, including archived projects, plus bounded tag value/quality/source-time observations and subscription state. These are snapshots, not continuous SQL health checks or a safe deletion lock. See [Connection operations](CONNECTION_OPERATIONS.md).

**G06:** Designer read tests have 1/5/15/30-second deadlines and explicit cancellation. The gateway propagates cancellation into provider work and returns HTTP 504 when the selected deadline expires. Typed parameter preflight rejects invalid values before opening either database provider; errors exclude submitted values. Updates reject read deadlines, have no new cancel control and are never automatically retried. See [Read-query testing](QUERY_TESTING.md).

Seven deployment model groups passed, including an actual pinned-certificate Windows HTTPS handshake, missing-key HTTP fallback, unchanged active listener after save and a forced failed recovery write. Six connection model groups passed for legacy defaults, stale saves/tests, persistence, disabled subscription prevention and archived dependencies. Query testing passed 17 browser parameter cases and six real SQLite/provider groups, including native interruption, concurrent queued deadlines, worker recovery, denied update deadlines and unchanged database bytes. SQL Server preflight used an unopened provider; no live SQL Server was contacted.

The self-contained Windows package passed three deployment-settings, four connection and three query-cancellation API groups, plus four existing deployment, five gateway-console and twelve SQLite application regression groups. A stale SQLite regression fixture was corrected to explicitly select its replacement startup screen. TypeScript and the production browser build passed; Vite retains its existing chunk-size advisory. Source-boundary tests passed all 38 groups and workshop-build tests all nine groups across 24 portable projects.

Browser checks on isolated port 5091 covered invalid/valid listener validation, discard, recovery controls and a 480-pixel layout; persisted connection tests, disable/read denial/re-enable; typed query success and invalid input, a real one-second timeout, cancellation and subsequent recovery. Explicit publication of the new synthetic Read query workshop produced three operator rows and both draft/published dependency entries. Checked browser warning/error logs were empty. Evidence stays under ignored `.data/test-evidence/gateway-operations-*`.

The catalog now contains 32 authored sources: 24 portable projects and eight setup-required examples. Gateway operations adds validation without saving; SQLite data controls adds the connection lifecycle exercise; the separate Read query workshop has its own explicit isolated setup loader and database. None contains credentials or gateway backups.

All 24 portable packages passed import, explicit publication, operator snapshots/read queries and re-export against the committed self-contained Windows build; fixtures were archived with gateway tags/connections unchanged. The setup-required Read query workshop separately passed export/import, explicit publication, three-row operator execution and re-export without running its slow query. Source policy passed 448 staged entries; the implementation and workshop feature baseline are `4e58e436ef3817458427e23a81d14a65ff1d190a`.

Port 5090 serves that committed build and browser bundle `index-Bk39a3Cg.js`. A protected pre-upgrade backup covered all 50 existing gateway data files; all 50 remained byte-identical after restart, with all seven projects and accounts preserved. Deployment and browser evidence remain local under `.data/test-evidence/gateway-operations-*`.

These are bounded increments, not completion of G04–G06. Remote TLS/proxy and renewal, supported Windows service/container recovery, safe connection deletion and certificate administration, actual OPC outage/replacement recovery, live SQL Server acceptance, transaction/pool diagnostics and additional providers remain open. Next is **G07 finer operation permissions and consistent audit attribution**, followed by **G08 external identity/machine access** and **G09 secret lifecycle/durable audit**. Full gateway backup/restore under G03 remains a pilot requirement. Public installer and Docker/macOS acceptance have not been refreshed by this increment.

## Previous G04 deployment observations: local verification, 2026-09-29

Gateway Settings now has a read-only **Deployment** tab. Its engineering-administrator API separates observed server listeners from configuration captured at startup, including URL bindings, Kestrel endpoints, allowed hosts, environment and the gateway data directory with allowlisted provenance labels. The effective public operator address comes from saved operator settings or the current request origin. Snapshot refresh does not change configuration or restart the gateway. See [Gateway console](GATEWAY_CONSOLE.md#deployment-observations).

Missing or partially omitted listener inventories retain explicit unknown states. Request transport describes the processed gateway request; framework forwarding overrides and IIS hosting indicators qualify those observations without establishing trusted-proxy identity. Direct TLS certificate expiry is exposed only when the request supplies the server certificate; plain HTTP and unsupported observation paths show it as unavailable. Certificate chain/hostname validation, renewal, proxy certificates and remote reachability are not established by this page.

Eight offline deployment-model groups passed, covering startup snapshot stability, configured/observed address separation, saved public-address precedence, request-origin fallback, unsafe-address and configuration redaction, bounded and incomplete listener inventories, framework/IIS forwarding indicators and source labels. Four gateway API groups passed for engineering-administrator access, non-cached responses, loopback HTTP observations, unavailable certificates, forged forwarding headers, secret exclusion, stable startup values, public-address selection and cross-origin denial. TypeScript, the production browser build, gateway compilation and self-contained Windows publication passed. These checks do not exercise a real HTTPS handshake or certificate renewal.

Browser checks on the isolated self-contained Windows gateway at port 5091 verified actual HTTP loopback listeners, command-line URL provenance, `appsettings.json` allowed-host provenance, the data-directory environment source, unavailable certificate status, staleness after 30 seconds, refresh recovery, deployment deep-link reload, a 480-pixel layout and denied non-administrator access. The Projects header has one **Settings** link, no theme selector and accessible icon-only sign-out. Browser warning/error logs were empty; no configuration or account changes were submitted. Evidence remains under ignored `.data/test-evidence/deployment-*`.

All 38 source-boundary regression groups and nine offline workshop-build groups passed. The updated independently authored **Gateway operations** example includes the deployment exercise; the catalog still contains 24 portable projects and seven setup-required examples. This increment does not complete G04: trusted-proxy configuration, remote HTTPS/certificate renewal, Windows service lifecycle and rollback, container persistence/recovery and offline deployment acceptance remain open. The public installer has not been refreshed.

Port 5090 now serves the tested self-contained Windows build and browser bundle `index-B3Xc3Q-S.js`. A protected backup covered all 50 existing gateway data files; all 50 remained byte-identical after restart, with all seven projects and the existing account store preserved. The implementation is committed as `05fc17612e21b3d4323d55eabbbc23cb00f0c2db`, now the workshop catalog baseline. Live verification remains under ignored `.data/test-evidence/deployment-live-verification.json`.

## Previous Gateway Settings navigation: local verification, 2026-09-29

Designer and Projects now expose one **Gateway Settings** entry. The existing console contains Overview, Sessions, Diagnostics, Security and Audit; Security retains Users & access and Operator settings. Legacy `/security` links resolve to `/gateway#security` under the same administrator gate. Engineering headers use an accessible icon-only sign-out button. Account name and password field pairs align despite unequal helper text and stack on narrow screens.

TypeScript/production build, five gateway-console API groups and nine workshop-build groups passed. Browser checks on isolated port 5091 covered navigation from Designer and Projects, the legacy URL, Security/operator settings/Audit/Diagnostics, icon-only sign-out, denied non-administrator access, equal field top edges in light/dark appearance and 480-pixel field stacking/tab wrapping. No account changes were submitted; browser warning/error logs were empty. Port 5090 serves browser bundle `index-vyLsAnWP.js` over the unchanged gateway process/data. Evidence stays under ignored `.data/test-evidence/gateway-settings-*`. This is a navigation/layout increment; G04 transport and service acceptance remain open.

## Previous ten roadmap increments: local verification, 2026-09-29

The current source adds one bounded increment for each of D06–D12 and G01–G03. These are incremental baselines, not completion of ten entire roadmap phases. Focused model, gateway and browser checks establish the scope described below. Port 5090 serves the tested self-contained Windows build.

| Item | Implemented scope in this batch |
| --- | --- |
| D06 · [Canvas precision](CANVAS_PRECISION.md) | Whole-pixel 0–128 grid, selection by component type, same width/height/size commands, authored-coordinate readout and boundary guides. Groups remain atomic; impossible sizing rejects the whole edit and successful commands use one Undo step. Responsive containers and snapping to other objects remain open. |
| D07 · [Visual styles](VISUAL_STYLES.md) | Reusable six-property appearance resources, assignment/usage inspection, source precedence, local-override clearing and staged catalog edits. Bindings keep final precedence. Styles cannot carry visibility, enabled state, actions or authority; conditional style rules remain open. |
| D08 · [Preview communication](PREVIEW_COMMUNICATION.md) | Live read-only Preview by default, session/project-bound expiring capabilities, administrator-confirmed live actions, guarded query/Python routes and cancellation on mode changes. Authored browser events are blocked in read-only mode. Trusted scripts are not sandboxed; fixtures and broader context simulation remain open. |
| D09 · [Authoring defaults](AUTHORING_DEFAULTS.md) | Validated project defaults for new screen/template dimensions and initial grid, with Apply/Cancel and package projection. Existing documents keep their geometry; a toolbar grid override lasts for the current project session. Provider, connection and time-zone defaults remain open. |
| D10 · [Asset library](ASSET_LIBRARY.md) | Searchable local image inventory, owner-qualified screen/template usages and selected before/after replacement previews. Stale previews reject application; geometry, alt text and bindings stay intact. Old immutable files are retained. Reusable bundle manifests and broader asset organization remain open. |
| D11 · [Designer diagnostics](DESIGNER_DIAGNOSTICS.md) | Explicit bounded snapshots of current-root binding errors, structured missing references, tag quality and retained component-event messages, with filtering and resource navigation. Unsampled query properties are labeled unknown. The panel runs no query/script and does not simulate nested contexts. |
| D12 · [Caption localization](LOCALIZATION.md) | Packaged stable text keys, six supported left-to-right language families, staged editing, parameter-preserving captions, visible fallback and browser/project language selection, including application-only launch links. Input values and action parameters retain their identity; date/number/time-zone formatting and RTL remain open. |
| G01 · [Gateway console](GATEWAY_CONSOLE.md) | Engineering-administrator overview with resource search/entry points, observation timestamps, stale status and session inventory. Opaque administration handles support reviewed, audited revocation without exposing cookie or CSRF secrets. Per-project session activity attribution remains open. |
| G02 · [Gateway diagnostics](GATEWAY_CONSOLE.md) | Process CPU/memory, data-volume free space, active/lifetime API counters and the last 128 completed request route templates. A locally downloaded support JSON uses an explicit metric/count allowlist. Durable logs, worker profiling and controlled fault/load acceptance remain open. |
| G03 · [Publication history](PUBLICATION_HISTORY.md) | Current operator application and up to 20 checked history snapshots commit through one atomic file replacement. Reviewed restore uses the current publication token and preserves Designer drafts. Per-record/aggregate byte bounds, corruption rejection and explicit oversized-legacy migration notices are included. Script-library transactionality and full gateway backup/restore remain open. |

Focused automated verification passed 42 canvas-model groups; 12 authoring-default/asset-model groups; 15 visual-style model, seven renderer and seven gateway groups; 12 localization model, eight renderer and six gateway groups; 12 preview-request model and 12 preview gateway groups, plus direct capability-store expiry/revocation checks; and 14 diagnostics-model groups. Gateway administration passed five integration groups and publication history passed five API groups. TypeScript passed. These counts identify the named suites and are not a claim of full platform or regression coverage.

Seven additional real publication-store failure/recovery groups exercised blocked filesystem writes, failed first publication and restore, exact draft preservation, restart, rejection before oversized writes, aggregate-byte retention, nonrecursive history, checksum corruption and oversized legacy migration. Independent review identified and corrected pre-commit history exposure and missing size preflight: current application and retained history now share one atomic file. An oversized pre-feature snapshot can be replaced only by a valid new version, with a persistent retention notice; a failed replacement keeps the legacy application intact.

The authored workshop catalog now contains 31 sources: 24 portable projects and seven setup-required examples. Nine offline workshop-build groups passed with all 24 portable entries, including exact styles, translation catalogs and authoring defaults in packages. All 24 passed import, explicit publication, operator snapshot/query and re-export checks on the isolated gateway and self-contained Windows package. Disposable package fixtures were archived; gateway tags/connections were unchanged. The Asset library exercise is setup-required: its blank image components must be assigned uploaded local images before publication.

A related frontend sweep passed 402 checks across 25 suites. Authoring-default admission checks rejected 31 malformed save and 31 malformed import variants without modifying the draft. Source policy passed 428 entries and all 38 boundary regression groups. TypeScript, production browser build and self-contained Windows publication passed; Vite retains its existing large-chunk advisory.

Browser checks verified same-size selection and atomic Undo; shared style/local override precedence; translation token validation, parameter preservation, input continuity and visible fallback; new screen/template dimensions; selective asset replacement with unchanged geometry/alt text and Undo; read-only Preview query/input/popup behavior and rejection of Python/authored browser events; diagnostic filtering and owner navigation; gateway resource/session views, session revocation and stale status; and reviewed publication restore. The restored operator project matched the original version exactly while saved Designer draft C remained deeply equal as parsed JSON. Gateway support download returned HTTP 200, but the browser download-event listener timed out, so local browser file delivery was not verified. Its response format/redaction passed API checks.

After explicit approval, the optional message-only Live actions browser check passed on isolated port 5091: screen, nested-template and popup Python returned their distinct messages; cancelling retained read-only mode and the local value; entering and leaving Live actions reset the form; all three actions were denied after returning to read-only; reopening Preview started read-only. Browser warning/error logs were empty. The fixture draft, publication, query/script definitions, tag definitions and connections remained byte-identical (six files). The fixture was archived again and the test gateway stopped; port 5090 remained healthy on its original process. Evidence remains under ignored `.data/test-evidence/roadmap-ten-*` and `.data/test-evidence/preview-approved-*`.

Port 5090 was upgraded after a protected backup of all 50 existing gateway data files. All 50 remained byte-identical after restart; all seven projects and the account store were preserved. The committed implementation is `0cebc66028aa29eb243b25fed96f7967975ea73d`; its browser bundle is `index-sHuTVkEW.js`. Application-only operator language selection and translated navigation passed a final packaged-browser check, with no warning/error logs in the checked tabs. The workshop catalog baseline now identifies this feature commit. The public installer and Docker/macOS acceptance were not refreshed. Next is G04 deployment and web transport acceptance; the remaining gates within D06–D12/G01–G03 stay open.

## Previous bulk replacement: local verification, 2026-09-29

The third D05 increment adds **Search project → Replace…** and Ctrl+Shift+H / Cmd+Shift+H for literal replacements in supported display text or tag paths. It previews before/after values, occurrence counts and per-property validation, with screen/template scopes and selective application in one Undo step. Large result sets use 100-property pages; unseen pages are initially unselected, and selecting all pages is explicit. Changing options invalidates the preview. Applying rechecks the exact current project/revision snapshot before any history mutation. Save and Publish remain separate. See [BULK_REPLACEMENT.md](BULK_REPLACEMENT.md).

The explicit inventory excludes IDs, reference targets, code, SQL, expressions, input defaults/values, password captions and arbitrary metadata. Interpolated text and tag-path parameter tokens are preserved. Tag-path changes do not rename gateway tags or prove their availability. Resource names, choice/state labels, column labels/suffixes, process units and tag paths have field-specific bounds. Preview expansion has a separate memory bound; ordinary gateway admission limits still apply when saving.

Twenty-five offline model groups covered immutability, selective invalid-row exclusion, literal special characters, Unicode matching, owner/path identity, untouched resource data, field limits, protected tokens, expansion limits, stale snapshots and tampered plans. Twenty existing resource-change groups, twelve search groups, nine workshop-build groups and all 38 source-boundary regressions passed. TypeScript and the production browser build passed with the existing large-chunk advisory. Independent review found and corrected token-interpolation and option-whitespace validation gaps before verification.

Browser checks verified search-text transfer, the shortcut, selective Apply and one-step Undo, case matching, preview invalidation, template-only scope, the empty tag family, and opening a result without editing it. A full 16-property display batch preserved stable IDs, geometry, navigation/template references, input defaults and option values exactly. Applying and saving left operators on their prior publication; explicit publication updated both screens and shared-template placements. A 105-result fixture verified initial selection bounds, explicit all-pages selection and a single off-page change with Undo. Tag-token edits were disabled; two valid path edits saved while retaining their parameters and binding expressions. All three test tabs reported no console warnings/errors. No equipment or external database was used for these checks.

The independently authored Bulk replacement workshop brings the collection to 22 sources: 16 portable packages and six setup-required examples. All 16 portable packages passed import, explicit publication, operator snapshot/query and re-export checks on the isolated Windows gateway, with disposable fixtures archived and gateway tags/connections unchanged. Evidence stays under ignored `.data/test-evidence/bulk-*`. Broader query/script refactoring and cross-session transactions remain separate gates; next is D06 canvas/layout precision. The public installer has not been refreshed.

Port 5090 serves the verified bulk-replacement build. Its 50 existing data files were backed up with restricted permissions and remained byte-identical after restart; all seven projects and the account store were preserved. The final browser build passed a replacement-preview smoke check. Source policy passed 365 worktree entries.

## Previous resource change previews: local verification, 2026-09-29

The second D05 increment adds previewed screen/template display-name changes and screen/template/component deletion. Renames retain stable IDs. Surviving structured references block deletion and open their owning resource; grouped components delete together without treating references inside that group as external blockers. Screen deletion previews menu cleanup and startup fallback. Code/SQL matches require acknowledgment and are never rewritten. Apply adds one Undo step and rejects changed local project/query/script snapshots; Save and Publish remain explicit. This does not add a cross-session refactoring transaction. See [RESOURCE_CHANGES.md](RESOURCE_CHANGES.md).

Twenty offline resource-change groups and twelve search groups passed, including owner scoping, selection-field mappings, groups, internal/external references, stale snapshots, tampered plans and unchanged code. Six document-tab checks and 33 canvas-model checks also passed. TypeScript and the production browser build passed with the existing large-chunk advisory. Review also fixed script-inventory readiness and retry behavior: merely visiting the lazy Scripting view does not count as having loaded its resources. Source policy passed 359 worktree entries and all 38 boundary regressions.

Browser checks on the isolated Windows gateway verified screen/template renames, blocked screen/template/input deletion, reference navigation, component/group/template deletion and Undo, code-text acknowledgment, startup/menu cleanup and atomic Undo. After explicit save/publication, operator navigation, both shared-template placements, input bindings and the read-only Python action worked. A separate unsaved deletion left the refreshed operator application unchanged. Saved JSON differed from the original fixture only in the two intended display names and revision; IDs, bindings, code, defaults and navigation were unchanged. Designer and runtime reported no console warnings/errors.

The independently authored Resource changes workshop brings the collection to 21 sources: 15 portable packages and six setup-required examples. Nine offline workshop groups and all 15 gateway import/publication/operator snapshot/query/re-export checks passed. Disposable package fixtures were archived; gateway tags/connections were unchanged. Browser and gateway evidence stays under ignored `.data/test-evidence/resource-changes-*`.

Port 5090 serves the verified resource-change build. Its 50 existing data files were backed up with restricted permissions and remained byte-identical after restart; all seven projects and the account store were preserved. The public installer has not been refreshed. Next in D05 is atomic previewed bulk replacement, followed by D06 canvas/layout precision. Broader resource refactoring and dynamic script analysis remain separate gates.

## Previous project resource search: local verification, 2026-09-29

The first D05 increment adds **Search project** and Ctrl+Shift+F / Cmd+Shift+F across draft screens, templates, components, property values, geometry, expressions, named queries and script resources. Results open their owning resource and select the component; common property rows are highlighted. Grouped members can be inspected without ungrouping, while canvas commands retain group behavior. Filters, bounded rendering with exact totals, structured used-by views and missing known-resource diagnostics are included. SQL and script matches are explicitly text-only, not inferred dependencies. See [PROJECT_SEARCH.md](PROJECT_SEARCH.md).

Eleven offline search groups passed, covering owner-scoped identity, geometry, parameters/state, all current query-source locations, navigation, structured references, missing known targets, incomplete inventories, unsaved changes and literal search. Browser checks on the isolated Windows gateway verified template used-by navigation, query-binding property focus, text-only comments, query/script editor selection, unsaved caption/code/SQL search, grouped-member inspection, keyboard opening and closed-screen navigation. A dirty query remained intact when opening another query; invalid script parameter JSON blocked switching until corrected, and unsaved code survived later switches. Designer and runtime reported no browser warnings/errors during these checks.

The independent [project-search workshop](../../examples/project-search.json) adds two screens, a shared production card and a built-in sample read query. Its operator walkthrough verified counts of 13,640 and 15,280, detail-table navigation and a read-only Python message. The collection now contains 14 portable packages and six setup-required examples. All 14 portable packages passed gateway import, explicit publication, operator snapshot/query and re-export checks; nine offline package groups passed. Package verification archived its disposable fixtures and confirmed gateway tags/connections unchanged. Browser evidence stays under ignored `.data/test-evidence/project-search-*`.

Final grouped-member review found and fixed a deletion path that could leave an invalid singleton group. The inspector now explicitly deletes the selected group; browser deletion and Undo restored the original clean draft. Port 5090 serves the new search build. All 50 original data files were backed up with restricted permissions and remained byte-identical after restart; all seven projects and the existing account store were preserved.

This is the search/reference baseline of D05. Dependency-aware rename/delete previews, atomic undoable bulk replacement, stale-revision enforcement and dynamic script analysis remain separate gates. D06 canvas precision/responsive containers and reliable application releases remain later increments. The public installer has not been refreshed for this change.

## Workshop distribution: local verification, 2026-09-29

The [workshop catalog](../../examples/README.md) inventories 19 independently authored examples: 13 portable projects and six requiring explicit gateway setup. Major user-facing features now include a workshop, walkthrough, prerequisites and verification as part of completion. The offline builder creates individual draft-only `.sparkproj` files, user guides, compatibility/source metadata, SHA-256 checksums and a standalone ZIP under ignored `artifacts/workshops/`. These assets can accompany a compatible installer or ship as a separate workshop release. The original public preview installer predates the required feature baseline; no public release was uploaded for this change.

Nine offline build checks passed, including all catalog entries, exact authored defaults, deterministic archives, dependency restrictions, unsafe paths and checksums. All 13 generated projects passed real gateway import as unpublished drafts, explicit publication, operator snapshot checks, sample-query execution and re-export. Fixture projects were archived, and gateway tag definitions and connection configurations remained unchanged. No imported action or script-resource event was invoked by the package verifier; the existing feature walkthrough checks remain separate evidence. Source policy passed 347 worktree entries and the source-boundary regression suite. CI now includes the offline workshop checks.

Port 5090 continues to run the previously verified query-property package. This distribution workflow changes no application runtime behavior and does not advance D05; resource search and references remain the next application increment.

## Current named-query scalar properties: local verification, 2026-09-29

Scalar property **fx** now offers **Named query**, with exactly one result row and a selected scalar column, typed containing-form parameter mappings, optional `value` transformation, explicit preview and on-change or polling refresh. Supported targets include presentation, process values and geometry across all 35 component types. Save, publication and package validation reject invalid targets, conflicting modes, update queries and incompatible definitions. See [QUERY_PROPERTIES.md](QUERY_PROPERTIES.md).

Runtime reads share requests by project, audience, publication and typed parameters, with eight concurrent reads, 128 active request keys, completion-based polling and a 30-second client deadline. Changed contexts and disposed forms cancel obsolete consumers; late results cannot replace current values. Authorization/publication conflicts stop automatic retries. Query-driven component events share the existing feedback breaker across network waits. Queries add no write authority; the gateway retains SQL, credentials and access checks. Reusable panels report their own quality; the optional header discloses incomplete nested health coverage.

Frontend runtime/model verification passed 200 groups across ten suites, including 22 new query-property groups. Authoring passed 14 new groups and 90 existing groups, with some overlap in the runtime sweep. Gateway verification passed 12 new integration groups and 104 malformed save cases, plus 72 existing groups. The final self-contained Windows package passed the 12 new groups again. TypeScript, the production browser build and Windows publication passed; Vite retains its existing large-chunk advisory. Source policy passed 341 worktree entries and all 38 boundary regressions.

Browser checks verified scoped reusable panels, transformed widths/colors/visibility, popup context, empty/multiple-row errors and recovery, explicit refresh and Preview resets. A disposable SQLite fixture changed a row while the runtime stayed open: polling updated both the numeric readout and shared query-driven geometry without reloading. Designer checks verified explicit typed preview, draft invalidation, Cancel, Apply and one-step Undo. Browser testing caught and verified a fix for unrelated live tag ticks clearing query previews. Independent reviews also led to fixes for mixed expression/query ranges, legacy omitted parameter types, nested health disclosure and deferred React notifications. Primary runtime and Designer checks reported no console warnings or errors; packaged popup reads passed after reauthentication.

The independently authored [workshop](../../examples/query-properties.json) and local-only `artifacts/examples/query-properties.sparkproj` contain one template, a main screen and a popup. Export checks confirmed original definitions and one built-in sample query, with no external connection dependency. Evidence remains under ignored `.data/test-evidence/query-property-*` and `.data/test-evidence/query-properties-*`.

Port 5090 runs the detached `windows-x64-query-properties` package with the tested browser bundle. All 50 existing data files were backed up with restricted permissions and remained byte-identical after restart; seven projects and configured accounts are preserved. The public installer was not refreshed.

This completes the scalar-property and bounded refresh baseline of D04. Next is the first D05 resource search and references increment. Dataset-valued bindings, deeper query-backed repeater sources, direct tag parameter sources, broader events, server-enforced Preview isolation and atomic releases retain separate gates.

## Previous state sources for template parameters: local verification, 2026-09-29

Template/repeater parameter **fx** now reads typed session state, containing-screen state and the immediately containing template's private state. The editor provides typed previews, staged Apply/Cancel, Remove binding and Undo. Shared-template screen references can remain unresolved while authoring; publication checks every concrete placement. Declaration editors track these structured dependencies through nested placements and prevent renaming/removing/retyping a referenced key. See [TEMPLATE_PARAMETER_STATE.md](TEMPLATE_PARAMETER_STATE.md).

Changed referenced values reset the dependent form context, even when an expression or row override masks the result. Unrelated state and independent sibling/row private values retain their existing lifetime. Gateway requests carry only referenced state keys in bounded, typed snapshots aligned with the template path. The gateway validates their published declarations and reconstructs parameters; submitted values are untrusted form context, never authority. A popup keeps its opening snapshot separate from its current form state, while definition and query-row changes retain stale-context checks.

Runtime/model verification passed 18 new groups and 129 existing groups. Authoring passed 13 new groups and 46 existing groups. Gateway verification passed 13 new integration groups, including 14 malformed save variants and additional malformed request cases, plus 82 existing groups. The final self-contained Windows package passed the 13 new groups again. TypeScript, the production web build and Windows publication passed; Vite retains its existing large-chunk advisory. Independent backend and authoring reviews found no remaining blockers.

Browser checks verified shared session/screen updates, private sibling and saved-row isolation, dependent draft resets, typed read-only Python submissions, bound enablement, popup opening/current-state separation and fresh state on reopening. Designer checks covered all three source pickers, typed and deferred previews, Cancel, Apply, one-step Undo and dependency-aware state declarations. The packaged gateway passed a popup/action smoke test after reauthentication. Primary runtime and Designer checks reported no console warnings or errors.

The independently authored [workshop](../../examples/template-parameter-state.json) and generated local-only `artifacts/examples/template-parameter-state.sparkproj` contain three templates, one main screen and a popup. Export checks confirmed original defaults/scripts and no external connection dependencies. Test and browser evidence remains under ignored `.data/test-evidence/template-parameter-state-*` and `.data/test-evidence/parameter-state-*`.

Source policy passed 330 worktree entries and all 38 boundary regressions. Earlier parameter-binding, private-state and component-event work was committed and pushed in `59e01b0`, whose GitHub source-boundary workflow passed. No reference artifacts or local runtime data enter the source repository.

Port 5090 runs the detached `windows-x64-parameter-state` package with the tested browser bundle. At upgrade time, all 50 existing data files were backed up with restricted permissions and remained byte-identical after restart; seven projects and configured accounts are preserved. The public installer was not refreshed.

This completes the direct browser-state source increment of D01. Next is the D04 query-backed property/refresh baseline. Direct tag parameter sources, indirect tag-address extensions, parameter writeback, nested query sources, broader D03 event families and atomic releases remain separate gates.

## Previous component property and lifecycle events: local verification, 2026-09-29

Every component property sheet now provides **Component events → Edit lifecycle & property events**. Its Mounted, Property changed and Unmounted tabs stage JavaScript, a supported scalar watch list and payload/help before Apply records one undo step. Existing explicit user input events and gateway Python actions retain their separate contracts. See [COMPONENT_LIFECYCLE.md](COMPONENT_LIFECYCLE.md).

Each component establishes a silent initial baseline, suppresses equal samples and orders mount before property work. Hidden/disabled components and read-only operators retain automatic local behavior. Password snapshots and assignments are excluded. Per-component queues, asynchronous deadlines, a shared rate/cascade breaker and revoked helpers prevent stale or timed-out work from committing through the supplied APIs. Cleanup reads captured state and cannot write into a replacement context. Scripts remain trusted browser JavaScript: synchronous infinite loops and arbitrary external side effects are not sandboxed.

Runtime/model verification passed 19 new groups and 152 existing groups. Authoring passed 14 new and 55 regression groups; some regression coverage overlaps the runtime sweep. Coverage includes async feedback, quiet-period resets, successful mount timers, StrictMode effect replay, read-only automatic assignments, unavailable/equal values, passwords, stale contexts and cleanup diagnostics. The gateway passed 11 new integration groups with 625 malformed save variants, plus 32 existing input-event, property-binding and instance-state groups. The self-contained final package passed all 11 new groups and malformed variants again. TypeScript, the production web build and Windows publication passed; Vite retains its existing large-chunk advisory.

Browser checks verified silent initial values, separate user/property counters, programmatic and equal-value assignments, sibling isolation, changed template context, hidden-panel persistence, wrapper visibility events and popup mounts/cleanup. Deliberate tests verified a 2-second timeout with no late state write and a feedback loop stopped after 128 property handlers; dismissing an ordinary error retained the breaker, and navigation recovered. Designer checks covered invalid watch lists, syntax errors, Cancel, Apply, one-step Undo and unsaved template Preview. The final packaged runtime passed a mount/assignment smoke check after reauthentication. No browser console warnings or errors were recorded in the primary runtime flow; authored failure tests produce visible application diagnostics.

The independently authored [workshop](../../examples/component-events.json) and generated local-only `artifacts/examples/component-events.sparkproj` include a template, two screens and a popup with no tag, query or external dependencies. Export checks confirmed original defaults, scripts and empty connection dependencies. Browser evidence remains under ignored `.data/test-evidence/component-events-*`.

Source policy passed 325 worktree entries and all 38 boundary regressions; whitespace checks passed. Reference material and local runtime/test data remain outside the source boundary.

Port 5090 runs the detached `windows-x64-component-events` package with the tested browser bundle. All 47 existing data files were backed up with restricted permissions and remained byte-identical after restart; six projects and configured accounts are preserved. A local launcher syntax error initially prevented startup; it was corrected and the final process/HTTP/data verification passed. The public installer was not refreshed and this increment was not committed.

This completes the property/lifecycle portion of D03, not its broader focus/keyboard/pointer families or common action editor. Next extend D01 binding sources and D04 query-backed properties on the verified scope and cancellation contracts. Atomic releases and deployment/provider acceptance remain separate gates.

## Previous private template-instance state: local verification, 2026-09-29

Shared templates now declare typed `instanceState` defaults in **Private instance state** on their document property sheet. Each placement and repeater row owns separate current values, and nested templates replace the private scope while retaining access to shared session/screen state. Component fx and two-way input bindings expose the private source only within templates. Input handlers can use `app.state.get/set/reset('instance', ...)`. Public parameters and authored static custom properties retain their existing contracts. See [INSTANCE_STATE.md](INSTANCE_STATE.md).

Stable row identity preserves values during reordering; removal, changed effective form context, navigation, popup closure, publication replacement and Preview restart dispose the relevant scope. Resetting a parent does not reset a nested template. Disposed helpers cannot modify replacement instances or shared state. Scope ownership uses weak references so discarded React renders cannot retain an otherwise unreachable state handle. Only authored defaults enter saved projects, publications and packages; gateway actions continue to validate ordinary submitted form fields rather than accepting a browser state map as authority.

Frontend runtime/model checks passed 141 groups, including 13 new instance-state groups; authoring checks passed 11 new and 53 existing groups. Gateway verification passed 12 new integration groups, rejecting 81 malformed save variants, plus 37 existing application-state, input-state and parameter-fx groups. TypeScript and the production browser build passed with the existing large-chunk advisory. Source policy passed 315 worktree entries and all 38 boundary regressions; whitespace checks passed.

Browser checks verified independent machine panels and nested notes, mirrored private inputs, one explicit change event per user edit, invalid draft blocking, reset at an unchanged accepted default, context resets, popup reopening, navigation, read-only Python submissions and shared-template Preview restart. Authoring checks covered dependency-aware key edits, Apply/Cancel/Undo, private source pickers and typed previews. The independently authored [workshop](../../examples/instance-state.json) and generated local-only `artifacts/examples/instance-state.sparkproj` contain two templates, two screens and a popup with no external dependencies. Saved defaults remained unchanged after operator edits. Browser evidence remains under ignored `.data/test-evidence/instance-state-*`.

A separate disposable SQLite query fixture verified live row reordering without changing its publication: both drafts followed their row IDs. Removing A visibly unmounted it; reinserting the same ID restored A's defaults while B retained its draft. Browser diagnostics reported no warnings or errors. This exercise used only the isolated 5091 gateway and synthetic records.

The self-contained Windows package passed the 12 new API groups and 81 malformed variants again. Port 5090 now runs the detached `windows-x64-instance-state` package with the tested browser bundle. All 47 existing data files were backed up with restricted Windows permissions and remained byte-identical after restart; six projects and configured accounts are preserved. The public installer was not refreshed, and this increment was not committed. The temporary 5091 gateway and browser test tabs were closed after verification.

This completes the D02 private-state baseline. Static custom properties are still authored constants; property expressions provide derived presentation. D03 explicit property-change and mount/unmount events are next, with ordering, equal-value suppression, bounded reentrancy and stale-context cancellation defined before broader event families. Broader parameter sources, nested query contexts, atomic releases and deployment acceptance remain separate gates.

## Previous template-parameter fx bindings: local verification, 2026-09-29

Template and repeater instances now expose ƒx beside their declared parameters in the property sheet. The existing expression editor provides parent-form Parameter, Form input and Custom property references, typed live previews, Apply, Cancel and Remove binding. Password inputs are excluded. Removing a binding restores the saved literal override or default and discards unfinished literal drafts. Template replacement clears obsolete bindings; normal Designer history applies. See [TEMPLATE_PARAMETER_BINDINGS.md](TEMPLATE_PARAMETER_BINDINGS.md).

Expressions read the immediately containing form before child parameters shadow their names. Defaults and saved overrides resolve once, computed bindings supply literal scalar values, and saved/query row values retain final precedence. Invalid bindings or referenced parent inputs block dependent forms. Changes to bound context clear stale local drafts and invalidate pending action callbacks across nested templates, repeaters and popups. The gateway reconstructs published action and table-edit contexts from captured definitions and validated parent-input snapshots; browser-supplied computed parameters do not establish authority.

Frontend verification passed 16 parameter-binding model checks, 20 template-model checks, 33 canvas checks, 39 property-binding checks and 18 parameter-authoring checks. Runtime/popup regression coverage passed 81 checks. The isolated gateway passed 12 new parameter-binding integration groups and 110 existing integration groups. Designer and published-runtime browser verification also passed. The authored [parameter workshop](../../examples/template-parameter-bindings.json) and its generated local-only `.sparkproj` demonstrate nested forms, saved rows, invalid source values and contextual dialogs without database or equipment writes. Browser evidence remains under ignored `.data/test-evidence/`.

The final self-contained Windows package passed all 12 new API groups again. Port 5090 now runs the detached `windows-x64-parameter-bindings` package and serves the tested browser bundle. All 47 existing data files were backed up with restricted Windows permissions and remained byte-identical after restart; six projects and configured accounts are preserved. Source policy passed 310 worktree entries and all 38 boundary regression checks; whitespace checks passed. The generated `artifacts/examples/template-parameter-bindings.sparkproj` contains only the synthetic workshop, with no external connection dependencies.

This completes the parent-form template-parameter fx slice. Direct tag/state parameter sources, parameter writeback, nested query sources and atomic multi-resource releases remain outside it. The next narrow application phase is private instance state, followed by explicit property-change events with defined lifetime, ordering and cancellation. The public installer was not refreshed and no source commit was made for this increment.

## Previous Designer account settings: local verification, 2026-09-29

The Designer header now retains project context, save status, Preview, Save and Publish. Theme selection lives in **Account settings**, opened by clicking the sidebar username. An icon-only sign-out control sits beside it and remains visible in the collapsed rail. The sidebar retains the Operator application launcher; duplicate header runtime/link controls and the initials badge are removed. Compact layouts keep the operator and sign-out icons available, and the upper navigation can scroll without pushing the account controls out of view.

Account settings provides current/new/confirmation password fields, reuses the existing 12–256-character password policy and clears staged credentials after attempts or dismissal. Unsaved project/query/script changes block password submission while leaving theme selection available. The authenticated self-service endpoint requires current-password verification, CSRF and origin checks, rejects target-account fields, throttles failures, and revokes all sessions for the changed account. A different account signed into the other audience remains unaffected. See [SECURITY.md](SECURITY.md#your-account).

Seven password API integration groups passed with disposable accounts, including unsuccessful attempts, strict request shape, session/cookie scope, throttling and audit secret exclusion. Frontend verification passed 21 authentication/session checks, seven account-dialog checks and 15 existing authentication UI checks. TypeScript, the production web build and self-contained Windows publication passed. The in-app browser verified the cleaned header, username dialog, theme persistence, focus return, unsaved-draft gate, collapsed icon sign-out and operator/logout visibility at 1000px width; browser testing did not change any password. Credential changes were exercised through the isolated API suite.

Port 5090 runs the detached `windows-x64-account-settings` package. Its 47 original data files were backed up with restricted permissions; six projects and configured accounts are preserved. During verification, an authenticated publication updated the default project's publication and appended to the existing audit history; the other 45 original files matched the backup. Source policy passed 304 worktree entries. Screenshots and local verification evidence remain under ignored `.data/test-evidence/account-*`. No installer refresh or source commit was performed.

## Previous two-way input/state bindings and Designer refinements: local verification, 2026-09-29

Thirteen typed non-password input types now support direct two-way value bindings through **Data → Value → fx** in the property sheet. Each binding targets one declared session or screen state key of the matching Text, Number or Boolean type. Valid edits update mirrored inputs in root forms, nested templates, repeater rows and popups; browser script state updates refresh those inputs too. Invalid intermediate drafts remain local, do not overwrite shared state and block their own form submission until corrected. Synchronization does not synthesize input events on receiving controls. See [INPUT_STATE_BINDINGS.md](INPUT_STATE_BINDINGS.md).

Session state remains shared within one project run and browser tab, while each screen visit and popup opening has its own screen-state lifetime. Templates use their containing screen or popup scope. Gateway validation checks declarations, types, input constraints and every placed template context; published form actions still validate submitted values against the saved definitions. A browser state binding adds no implicit database/device write or permission. Password fields, named-query choice sources, initial tag values and selection-field mappings cannot share this value-binding mode.

Project-wide properties now live in **Project settings** above the project tree, with the right property sheet reserved for its selected screen, template or component. Both project and properties panes have horizontal resize handles with pointer capture, keyboard adjustment, width limits and browser-persisted preferences. Window resizing preserves usable canvas space without replacing the saved widths; very narrow layouts can scroll horizontally. In authoring mode, templates and repeaters behave as whole components so wheel input reaches the canvas. Preview/runtime repeaters scroll their rows and then chain to the surrounding screen at their boundary; nested template frames clip without adding scroll containers.

The isolated gateway passed 51 API groups, including rejection of 315 malformed binding variants. Focused frontend binding, authoring and regression suites passed, together with 20 pane-layout checks and six document-tab checks. The source-boundary regression passed 38 checks. TypeScript and the production web build passed, with the existing large-chunk advisory.

The in-app browser verified mirrored root/nested inputs, invalid drafts and explicit resets, screen versus popup scope, navigation, and read-only Python form submissions. Authoring checks covered rejected incompatible bindings, Remove/Undo/Apply, Project settings, pointer/keyboard pane resizing and saved widths. Wheel input over repeater content moved the authoring canvas; component selection and dragging remained functional. Preview scrolled a constrained repeater internally and continued into the canvas at the boundary. Browser console checks reported no errors. Evidence remains under ignored `.data/test-evidence/`.

Port 5090 now runs the tested `windows-x64-input-state` package. All 47 existing data files were backed up with restricted Windows permissions and remained byte-identical after restart; six projects and completed administrator setup are preserved. This is a packaged process, so source edits do not automatically appear there. The public installer, service/container acceptance and external SQL Server validation were not refreshed.

Optional `tools/dev.ps1 -Watch` serves Vite on 5090 and a watched gateway on 5092, with configurable ports and an isolated data directory. A separate 5093/5094 browser check verified same-origin login, explicit Python submission, a CSS change appearing without reload and a C# response change being hot-applied. Both temporary source changes were removed and all test ports closed afterward. The packaged 5090 process remains the current local server; switching it to watch mode is a separate lifecycle action. Watch-mode startup guards and configuration checks passed; an interactive Ctrl+C shutdown was not separately exercised.

The authored [input-state workshop](../../examples/input-state-bindings.json) and generated local-only `artifacts/examples/input-state-bindings.sparkproj` contain two screens, a popup and two nested templates. They demonstrate mirrored quantity/station/readiness controls, independent screen notes, invalid local drafts, explicit resets and read-only Python submissions without external data or equipment writes. Generated packages and browser evidence remain outside the source boundary.

Next is **template-parameter fx binding** with explicit dependency rules and gateway reconstruction/validation of published action contexts, followed by private instance state and property-change events. Parameter fx is not included in this increment. Atomic application releases, refreshed distribution acceptance and live SQL Server/network validation remain open.

## Previous nested forms: local verification, 2026-09-29

Templates can now contain templates and saved-row repeaters through four instance levels. Inputs, input events, action status and submissions use the full instance/row path, so identical child IDs in different machine cards remain independent. Typed parameters resolve at each boundary; descendants inherit their containing screen's browser state and ancestor enablement/visibility. Root query-fed rows may contain nested forms; changing or removing a query row invalidates its descendant drafts and action context. See [NESTED_FORMS.md](NESTED_FORMS.md).

The Designer includes both reusable component types while editing a shared template. Template choices reject cycles and excessive depth through existing ancestors; referenced definitions cannot be deleted. Gateway publication validates all definition graphs, including unplaced definitions and empty repeaters, and limits expanded components to 10,000 across the project. Named-query repeaters remain restricted to screen/popup roots; modal depth remains one. Instance-private state, parameter fx and two-way state bindings are still planned.

Sixteen nested renderer/model checks and seven nested popup checks passed, alongside existing template, query-repeater, binding, input-event, runtime-health, popup-source and drawing-authoring checks. The packaged gateway passed 13 new integration groups and 91 legacy API groups. New integration coverage includes inner-only input validation, sibling and row identity, typed contexts through four levels, forged paths, popup opener/target paths, guarded SQLite table edits, deleted query rows, publication isolation, graph limits and project-package round trips. The web build and self-contained Windows build passed; Vite retains its existing large-chunk advisory.

Chrome verified separate machine and saved-row drafts, Python submission of the correct inner form, ancestor disable/hide behavior, fresh nested popup inputs and retained parent drafts, shared screen counters, template palette/property sheets, cycle prevention, Undo, referenced-template deletion blocking and popup opening from shared-template Preview. Review also fixed ancestor-depth selection checks and descendant draft invalidation after template/context changes. The original [workshop](../../examples/nested-forms.json) and local-only `artifacts/examples/nested-forms.sparkproj` contain three screens and five templates with no external data or equipment writes. Browser evidence remains under ignored `.data/test-evidence/nested-forms-*`.

The local gateway on 5090 runs `windows-x64-nested-forms`. All 47 original data files were backed up with restricted Windows permissions and remained byte-identical after restart; six projects and completed administrator setup are preserved. Source policy passed 292 worktree entries and 38 boundary regressions. No staging or commit was performed. The public installer, service/container lifecycle and network/SQL Server acceptance were not refreshed. Next is deeper property behavior: parameter fx dependencies and two-way input/state bindings, followed by instance state and property-change events.

## Previous browser application state: local verification, 2026-09-28

Project settings now defines typed session defaults, and each screen/popup property sheet defines local state defaults. Both accept Text, Number and Boolean values with staged Apply/Cancel and one-step Undo. The property binding dialog adds Session state and Screen state sources. Browser startup/screen-open and input change/commit scripts receive `app.state.get/set/reset`; updates reevaluate supported captions, geometry, appearance, visibility and other scalar fx targets. See [APPLICATION_STATE.md](APPLICATION_STATE.md).

Session state belongs to one project run in one browser tab and survives screen navigation. Leaving a screen resets its local state; every popup opening has a separate fresh scope while its underlying screen retains its values. Templates and repeater rows inherit their containing screen's state; existing form inputs retain their independent scope and lifetime. Reload, publication replacement, user change and restarting Designer Preview reset the application state. Expired script helpers cannot mutate a replacement scope. Only authored defaults are saved, published or exported; live browser state is not an authorization source or an implicit gateway/Python/query input.

The frontend passed 20 state model/integration/lifetime checks and eight authoring groups. Selected regressions passed for bindings, runtime health, bound controls, input events, browser scripts, authentication UI, drawing authoring/rendering, templates and popup/query contexts. The packaged gateway passed 12 new API groups, rejecting 107 malformed save variants, plus existing property-binding, typed-template, query-popup and component-event suites. State checks cover exact bounds, scope declarations, each template placement, publication isolation, legacy projects, Python isolation and `.sparkproj` round trips. TypeScript, web build and self-contained Windows publication passed; Vite retains its existing large-chunk advisory.

Chrome verified authoring Apply/Cancel/Undo, invalid-default blocking, fx source selection, text/number/Boolean events, reactive template summaries, main-screen navigation, fresh popup state, parent preservation, explicit reset, Preview isolation/restart, separate tabs and reload. Both themes and application-only/optional-controls presentation were inspected; no browser console warnings/errors were recorded. The original [application-state workshop](../../examples/application-state.json) and local-only `artifacts/examples/application-state.sparkproj` contain two screens, a popup and a reusable summary template. Browser evidence remains under ignored `.data/test-evidence/application-state-*`.

The local gateway on 5090 runs `windows-x64-application-state`. All 47 original data files were backed up with restricted Windows permissions and remained byte-identical after restart; six projects and completed administrator setup are preserved. Source policy passed 287 worktree entries and its 38 boundary regressions; whitespace checks passed. No staging or commit was performed.

Remaining work includes nested reusable forms, template-instance mutable state, parameter fx dependencies, property-change events and two-way input/state bindings. This increment does not make project/script publication atomic or refresh the public installer, service/container lifecycle, real SQL Server or network acceptance.

## Previous operator presentation: local verification, 2026-09-28

Operator URLs now default to **Application only**. The authored canvas uses the browser viewport with aspect-preserving fitting and no SparkStudio header, screen/context toolbar, canvas card border or footer. Designer's **Operator link → Presentation** selector can generate **Show runtime controls** (`?view=controls`) to restore the surrounding interface. The choice is link-specific and requires no project edit or publication. Existing bare links adopt the new default; authored navigation and popups remain available. See [SECURITY.md](SECURITY.md#operator-data-and-links).

Sign-in, permissions and component interaction gates are unchanged. Read-only viewers still cannot edit inputs or execute actions. Operational notices, including connection loss, action outcomes and publication updates, remain available as overlays without resizing the clean canvas; there is no persistent runtime bar in the default presentation. Operators needing the configured screen menu, context selectors, theme or session controls use the controls link.

The frontend build passed with the existing Vite chunk-size advisory. Eighty-four focused checks passed: authentication UI (15), session/admin (15), project routing/packages (19), runtime navigation (14) and popups (21). Checks cover URL construction, strict default/opt-in handling, dialog selection, read-only gates and retained diagnostics. Chrome verified a bare URL showing only the application, working equipment popup open/close, the full controls URL, and both selector-generated URLs. Its clean viewport used the full 932-pixel browser height without vertical overflow in the observed 1707×932 viewport. This is selected desktop browser coverage, not a full device matrix.

The verified web bundle was copied into the running local gateway on 5090 without restarting it or changing its data. Existing sessions remain available; reload the operator page or Designer to receive the new presentation. The previous web entry point was backed up under ignored `.data/web-backups/`. Source policy passed 277 entries and whitespace checks passed. No staging, commit or public installer refresh was performed.

## Previous drawing and process graphics: local verification, 2026-09-28

The palette now has 35 component types. Line, Rectangle, Ellipse, Polyline, Pipe and Equipment symbol join the fixed canvas, property sheets, templates, repeaters and popup contexts. Seven new scalar fx targets bring the total to 30: stroke/fill colors, stroke width, rotation, flowing, reverse flow and active. Original pump, valve and motor graphics have explicit optional screen/popup navigation. Pipe flow is a visual indication, with static designer placement and reduced-motion support; none of these components write equipment values. See [DRAWING.md](DRAWING.md).

Routes store 2–64 normalized points (two for Line), with a numbered editor, insertion/reordering, exact fractional coordinates and Apply/Cancel as one undo step. The first set does not include direct point dragging, imported SVG libraries, curves, filled polygons or attached pipe networks. Invalid state/paint/geometry bindings show unavailable diagnostics and block interaction. Runtime health now tracks successfully visited simulated tag references in fx expressions, including instance/row scopes, without flagging unused lazy branches.

FUXA's [shape authoring](https://frangoteam.github.io/FUXA/HowTo-define-Shapes/), [pipe animation workflow](https://frangoteam.github.io/FUXA/HowTo-animate-Pipe/) and [widget parameters](https://frangoteam.github.io/FUXA/HowTo-Widgets/) informed the separation of geometry, appearance and bound state. SparkStudio's components and schematic geometry were independently authored; no FUXA code or symbol assets were imported.

The web build and self-contained Windows publication passed; the gateway build reported zero warnings/errors, and Vite retained its large-chunk advisory. Focused frontend verification passed 191 checks across drawing model/authoring/renderer (34), property binding model/authoring (46), runtime health (20), bound components (17), templates (20), popups (21) and canvas (33). The packaged gateway passed 49 API groups: drawing (10, including 438 malformed saved definitions), property bindings (8), dynamic popup actions (10), typed template parameters (11) and existing runtime actions (10). Drawing checks include save/publish isolation, package round trips/import rejection and published popup provenance for ordinary, template and repeater symbol openers. Source policy passed 277 worktree entries and 38 boundary regressions; no staging or commit was performed.

Chrome verified the six palette entries, pipe route Apply/Cancel/Undo, fx editing, active/stopped/reversed flow, lost-value diagnostics, equipment popup open/close, and both Light/Dark themes. The browser exposed and verified fixes for duplicate sibling editor keys, configured-symbol pointer interception during placement, and example caption contrast. Configured equipment now selects, drags and resizes directly; two Undo steps restored movement and size. Console checks recorded no warnings/errors. The synthetic example only changes browser form values; selected checks do not constitute a full browser/platform matrix.

The local gateway on 5090 runs `windows-x64-drawing`. All 47 original data files, including protected account storage, were backed up with restricted Windows permissions and remained byte-identical after restart. Six projects and completed administrator setup are preserved. The example is authored in `examples/process-graphics.json`; an importable `.sparkproj` is under local-only `artifacts/examples/`. Browser evidence and the isolated 5091 fixture stay under ignored `.data/`. The public installer, Windows service lifecycle, Docker, real SQL Server and network acceptance were not refreshed. Next application work remains typed screen/session state and nested forms; the next palette family is supplied-data charts, followed by deeper history/alarm integration.

## Previous inline table editing: local verification, 2026-09-28

Tables can now declare editable text, number and Boolean fields, typed constraints, a version column and a published gateway Python commit handler. The expanded property editor stages configuration and code until Apply; Cancel leaves the project unchanged. Operators with Operate access use explicit cell Edit/Save/Cancel controls. Designer Preview never executes cell writes. See [QUERY_CONTROLS.md](QUERY_CONTROLS.md#inline-table-editing) for schema, limits and the guarded SQL/Python recipe.

The gateway captures the handler, queries and screen/template/popup provenance from one publication, reconstructs the context, reruns the read query and validates the full row set, typed value and requested row version. It supplies the old value and source row itself, rejects forged extra request fields and omits Python source from runtime project responses. This preflight does not make arbitrary scripts transactional: authored writes must compare key and version atomically, advance the version and check that exactly one row changed. The first slice supports one cell draft per table, scalar values and explicit reload after failed/uncertain outcomes; batch edits, null/date editors and database-side paging remain planned.

The web build and self-contained Windows publication passed with zero .NET warnings/errors and the existing Vite large-chunk advisory. Focused frontend verification passed 139 checks: editing model/authoring/renderer/context (47), column model/authoring (27), paging (9), selection (13), bound components (17) and authentication UI/session (26). The packaged gateway passed 53 API groups: inline editing (13, including 81 malformed saved definitions), existing button actions (10), dynamic popup actions (10), typed templates (11) and display columns (9, including 119 malformed variants). Tests cover actual SQLite updates/constraints, concurrent guarded writes, stale/deleted rows, source limits, publication isolation during an in-flight action, permissions/CSRF/audience separation and package preservation. Source policy passed 265 worktree entries and its 38 regression checks; whitespace checks passed. No source staging or commit was performed.

Chrome verified the property dialog, CodeMirror context, invalid version metadata, Apply/Cancel and one-step Undo. The previously pending display-column checks passed for Apply/Cancel/Undo and formatted headings. An isolated operator account saved numeric, Boolean and text values through Python into synthetic SQLite rows. Invalid numbers blocked Save, Cancel discarded text changes, and a concurrent database update retained the operator's draft while disabling Save; explicit reload showed the newer value. Light and Dark layouts were inspected, including ordinary saving feedback and the final saved status; no browser console warnings/errors were recorded. These are selected acceptance flows, not a complete browser/platform matrix. Viewer and complex template/popup gates were covered by gateway/renderer tests.

The local gateway on 5090 runs `windows-x64-table-editing`. All 47 original data files, including the administrator identity store, were backed up with restricted Windows permissions and remained byte-identical after restart. All six projects and completed administrator setup are preserved. The synthetic browser workshop is confined to the isolated gateway on 5091. Evidence remains under ignored `.data/test-evidence/table-editing-*`. The public installer, real SQL Server, network/service and Docker acceptance were not refreshed. Drawing/symbol components are the next palette slice alongside typed screen/session state and nested forms.

## Previous configurable table columns: local verification, 2026-09-28

Tables now support an ordered list of exact query keys with authored headings, visibility, widths, alignment and Automatic/Text/Number/Boolean/UTC date-time formats. Numeric precision and literal suffixes are optional. The property-sheet editor stages Add/Remove/Reorder/Show and format changes until Apply creates one undo step; Cancel discards them. Absent or empty configuration retains automatic columns. Explicit configurations require unique keys and at least one visible column; missing query keys show a diagnostic and prevent table selection. See [QUERY_CONTROLS.md](QUERY_CONTROLS.md).

Configured tables filter only visible formatted cells, while sorting and row mappings retain raw values and hidden identities. Invalid typed values show a cell diagnostic; null remains missing. Configuration/page-size changes discard old filters, sort and paging, including a switch away and back, without changing other form inputs. This is presentation configuration, not data authorization or inline editing.

The web build and self-contained Windows publication passed with zero .NET warnings/errors and the existing Vite large-chunk advisory. Focused frontend verification passed 77 checks across column models/renderers (14), authoring (13), paging (9), selection (13), bound renderers (17) and authenticated UI permissions (11); the 29 input regressions and TypeScript checks also passed. The final packaged gateway passed 26 API groups: table columns (9, including 119 rejected malformed configurations), selection controls (10) and project packages (7). Scope includes templates, draft/publication isolation, raw rows, viewer permissions and package import/export. Independent review found and verified fixes for stale view-state resurrection and unsafe numeric values in Text format. Source policy passed 256 worktree entries, its 38 regression cases and whitespace checks. No source staging or commit was performed.

The local gateway on 5090 runs `windows-x64-table-columns`. All 47 original data files, including the administrator identity store, were backed up with restricted Windows permissions and remained byte-identical after restart. All six projects are preserved and administrator setup remains complete. The isolated browser fixture uses synthetic SQLite rows and actions that write no device/database values. Browser interaction acceptance remains pending because Chrome's extension panel blocked the test login. Evidence stays under ignored `.data/test-evidence/table-columns-*`. The public installer, network/service and Docker acceptance were not refreshed. The next table slice is validated inline editing; column wrapping, custom renderers and database-side paging remain planned.

## Previous local accounts and project access: local verification, 2026-09-28

The source now includes local gateway accounts, separate engineering/operator sessions, server-enforced project View/Operate/Design/Publish grants and gateway administrators. Setup requires a loopback connection and the local one-time code; no default credentials or unauthenticated developer bypass are provided. Sessions use HttpOnly cookies, mutation CSRF checks, expiry/revocation and login throttling. Operator tag reads/streams use explicit project scopes, runtime images are limited to published references, and local audit records authenticated actors without request bodies or secrets. The [security guide](SECURITY.md) defines scope and remaining boundaries.

The browser provides setup/sign-in, administrator account and grant management, password resets, operator URL/tag-scope settings and audit history. Session changes discard mounted form/query state. Sign-out blocks replacement login until its request settles, and a non-secret sign-out flag prevents a failed offline logout from silently restoring a cookie after reload. Old response bodies cannot apply data or begin package downloads after an identity change. Viewer interfaces retain navigation and inspection but suppress editing/events/actions; server authorization is independent of those controls.

The web build and self-contained Windows package passed with zero .NET warnings/errors and the existing Vite large-chunk advisory. The final package passed 63 API groups: security (14), input controls (13), runtime actions (10), project management (9), selection controls (10) and project packages (7). The five existing regression suites used real authenticated sessions and passed without expectation changes. Frontend checks passed for authentication/session/admin behavior (15), project routing/package transfer including empty catalogs (19), authenticated UI permissions (11), bound renderers (17), input/template/popup/canvas loaders (103), and twenty further regression suites. Source policy passed 249 worktree entries and whitespace checks passed. No source staging or commit was performed.

Chrome verified viewer sign-in with disabled inputs/actions, read queries and working navigation; Switch user; editable operator inputs and a successful published Python action using the entered quantity; the separate engineering login; a designer without Publish or gateway configuration access; and the publication's stable operator link with successful Copy feedback. The live first-administrator form was visually inspected in Dark. Repeated extension panels interrupted some browser work, so the complete account-administration UI was not exercised end to end; its API and renderer/session tests passed. These are selected acceptance flows, not a complete browser/platform matrix.

The local gateway on 5090 runs `windows-x64-security`. All 45 original data files were backed up before restart and remained byte-identical afterward; all six existing projects and publications are preserved. Anonymous catalog requests now return 401. No live account was created: first-administrator setup remains ready for the user with a local one-time setup code. Evidence and screenshots are retained under ignored `.data/test-evidence/security-*`. Network/TLS, elevated Windows service lifecycle, container acceptance and public installer refresh remain outstanding; previous deployment results below do not establish acceptance of this security boundary.

## Previous lists, trees and table paging: local verification, 2026-09-28

The source palette contains 29 component types and 14 inputs. List and Tree view support one string selection, saved choices or named read queries, same-form field mappings, change/commit scripts, and independent template/repeater scopes. The options editor validates parent links, duplicate identities, cycles and defaults before applying its draft. Query trees require explicit parent columns and complete bounded results. The gateway revalidates selected membership before Python actions. See [QUERY_CONTROLS.md](QUERY_CONTROLS.md) for the contract.

Tables now page the loaded query result with configurable 1–100 rows per page. Filtering and sorting apply before paging; those operations preserve form edits. Selection validates every mapped destination before changing any field and checks stable identities across all loaded rows. Context/publication changes and reconnects discard old query state, including when returning to an earlier context. This is browser paging over bounded results, not database-side paging or inline editing.

The complete web/.NET build and self-contained Windows package passed with zero .NET warnings/errors; Vite retains its existing large-chunk advisory. Frontend verification passed 300 checks across sixteen suites, including 14 list/tree model/render/keyboard, nine options-editor and nine table-paging checks. The final self-contained gateway passed 58 API groups: selection controls (10, including 42 malformed variants), query controls (13), input controls (13), typed templates (11) and process displays (11). Source policy passed 234 working-tree entries and whitespace checks passed. No source staging or commit was performed.

Chrome verified query-backed selection/mapping and Python submission, tree expansion and keyboard selection, independent template inputs, table paging/filtering/global sorting, retention of an unsaved quantity during paging, and selection from a later page. Designer checks covered cyclic-parent diagnostics, valid options Apply/Undo, page-size Save/Reload and draft/publication isolation. Both themes were inspected. Stopping and restarting the isolated gateway removed unavailable choices/table rows and automatically restored fresh data. These are selected acceptance flows, not a complete browser/platform or accessibility matrix.

The local gateway on 5090 runs `windows-x64-data-controls`. The separate **Data workshop** project uses a new synthetic SQLite database, three read queries, two screens and a shared station-selector template. Its preview actions write no equipment or database data. All 40 existing data files were backed up before restart. Only the project and connection catalogs changed to add the workshop; every original catalog/connection entry and all other existing resource/publication/database files remained unchanged. Python is available and the three existing OPC values have Good quality. The live Chrome form returned the selected record and quantity through Python without console warnings/errors. Local evidence and its screenshot remain under ignored `.data/test-evidence/data-controls-*`; the isolated test gateway was stopped.

Next table work is configurable columns and validated inline editing; multi-selection, tag browsing, drawing/symbols and the broader component families remain planned. Public installer and Docker acceptance were not refreshed in this increment.

## Previous process displays

The source palette now contains 27 types. This increment adds numeric LED display, progress bar, cylindrical tank, level indicator and thermometer. Each has type-specific fx property rows, strict numeric values/precision/units, supported range and orientation settings, and read-only rendering. Fill clamps to its scale while off-scale readings keep their actual number. Failed value or configuration bindings show unavailable data instead of zero or a previous reading. Static and constant-bound ranges validate on the server; dynamic ranges validate together at runtime. See [COMPONENTS.md](COMPONENTS.md#process-displays) for limits.

The full web/.NET build and self-contained Windows publication passed with zero .NET warnings/errors; Vite retains its existing large-chunk advisory. Focused frontend verification passed 208 checks: process model/renderers (18), process authoring (8), property bindings (39), bound renderers (15), input model (29), input events (15), runtime health (16), templates (20), query repeaters (23), state controls (10), state authoring (8) and property authoring (7). The isolated self-contained gateway passed 51 integration groups: process displays (11, including 264 malformed variants), property bindings (8), state controls (8), input controls (13) and typed templates (11). An independent review compared the new server constant evaluator with browser expression semantics. Source policy passed 219 working-tree entries; whitespace checks passed. No source staging or commit was performed.

Chrome verified light/dark graphics, normal/zero/off-scale values, missing-source diagnostics and one health issue per affected control. Designer checks covered the 27-entry palette, LED insertion/Undo, per-type fx rows, Maximum binding and precision Save/Reload, and vertical progress orientation/Undo. Browser inspection caught a thermometer CSS class collision that clipped the graphic; the corrected SVG-scoped rule and a regression check passed, and both themes displayed the complete graphic/readout. No browser console warnings/errors were recorded. This is selected Chrome acceptance, not a complete browser/platform or accessibility matrix.

The local gateway on 5090 now runs `windows-x64-process-displays`. A separate **Process workshop** project was published at revision 1 with local sample inputs; its controls write no equipment or database data. Before restart, all 36 existing data files were backed up. Hash comparison found only `projects.json` changed to add the new project; every original catalog entry and all existing resource/publication/database/connection files remained unchanged. Python was available and all three existing OPC subscriptions returned Good quality. Evidence and light/dark screenshots remain under ignored `.data/test-evidence/process-displays-*`. The temporary test gateway was stopped after verification.

The next palette slice is lists, trees and richer table behavior. Advanced LED formats, indeterminate progress, configurable scales/subranges and the broader families remain planned. Public installer and Docker acceptance were not refreshed in this increment.

## Previous bindable template instances

Template instances and saved/query repeaters now use the common 13-target property sheet: accessible label, enabled/visible, position/size, font, accent, background/text/border colors and border width. Bindings evaluate in the containing screen or popup context; child forms keep independent inputs and parameter scopes. Designer retains authored geometry while Preview/operator evaluate layout bindings. Disabled or failed wrappers lock child inputs, events and actions. Hidden wrappers retain unchanged row drafts while removing visibility, focus and hit targets. Explicit child appearance overrides inherited instance defaults, including when a child style is cleared before Save. Wrapper failures contribute to runtime quality diagnostics.

The complete web/.NET build and self-contained Windows package passed (zero .NET warnings/errors; existing Vite chunk-size advisory). Frontend verification passed 129 cases across property authoring (7), bindings (36), bound renderers (15), input events (15), runtime quality (12), query repeaters (17), popup model (20) and popup lifecycle (7). The self-contained executable passed 61 API groups on isolated loopback port 5091: wrapper properties/packages (8), ordinary properties (8), static templates (11), query repeaters (12), query popups (10) and assets/popups (12). The source-boundary worktree scan passed 199 entries and whitespace checks passed.

Chrome verified parent width/position/color changes, independent A/B/C inputs, a Python preview action using the selected row's quantity, disabled descendant controls, hidden form draft retention, the 13 fx controls, a Width expression with live preview, evaluated Preview geometry versus saved Design geometry, and Undo back to the saved draft. Light and dark appearance were inspected; spinner buttons now inherit explicit appearance without losing glyph contrast in Light. No browser warnings/errors were recorded. These are selected Chrome flows, not a full platform matrix.

The live gateway on 5090 was backed up and restarted from `windows-x64-template-properties`. An independent **Template workshop** project was published at revision 1, with one screen and one shared station-form template. Existing project resources, publications, databases, scripts and connection files matched the backup bytes; only the project catalog changed to add the workshop. Python and three Good-quality OPC subscriptions remained available. Screenshots are retained locally in `.data/test-evidence/template-properties-runtime.jpg` and `template-properties-light.jpg`. The public installer and container were not refreshed.

This completes common instance presentation/geometry bindings only. Parameter maps, row sources, template references and arrangement remain structural, parameters remain saved strings, and UI enablement is not authorization. Typed root/session state, parameter bindings, property-change events and nested templates remain next steps. See [TEMPLATES.md](TEMPLATES.md) and [PROPERTY_SHEET_EVENTS.md](PROPERTY_SHEET_EVENTS.md).

## Previous contextual dialogs from query rows

Buttons in query-backed repeaters can now open parameterized popups. The operator captures the chosen row, verifies it against the published read query and preserves independent popup inputs. Initial verification, query failures and changed or removed source records disable actions while Close remains available. Changed records invalidate the form until reopened. Successful actions refresh surrounding data and preserve their result message; dialogs are not automatically closed. The gateway independently re-queries the opener before deriving popup parameters and before resolving any target repeater inside the popup. Database updates still need their own revision guards.

The full web/.NET build and self-contained Windows package passed, with zero .NET warnings/errors and the existing Vite chunk-size advisory. Ten new popup API groups and twelve query-repeater groups passed, including literal values, rejected forged context, stale source and target rows, static origins, and an in-flight publication change that retained the old action's captured code/query/context. Twelve asset/popup and eleven static-template API regressions passed. Frontend checks passed twenty popup-model, seven popup-lifecycle and seventeen query-repeater cases. Source and whitespace checks passed; the worktree boundary scan covered 196 entries.

Chrome verified record-specific dialogs, successful submission and parent refresh, retained success feedback, and independent forms. A second session reserved an open dialog's record: the first dialog retained its unsaved note, disabled submission and remained closable. Read-only detail dialogs loaded the correct filtered records for two different locations. The live gateway was backed up and restarted from `windows-x64-contextual-popups`; the default project, databases, scripts and connection configuration were preserved, and Python plus three Good-quality OPC subscriptions remained available. No browser warnings/errors were recorded. The public installer and container were not refreshed.

One popup level and one template level remain supported. The source monitor compares the complete captured row context, so changes to display-only counts can also invalidate a read-only dialog. Nested templates, typed root/instance bindings and atomic script/project releases remain future work.

## Previous query-backed repeaters

Repeaters now accept a captured read named query, a stable string row key and column mappings into declared template parameters. Designer exposes this through the repeater property sheet. Each row owns its editable form state; unchanged rows retain edits during polling, while changed, removed or context-switched rows reset. Empty, loading, disconnected and failed sources have visible states. Published actions re-query the captured definition and reconstruct row parameters on the server. Versioned row keys support explicit stale-record rejection; the update query must also enforce optimistic concurrency. See [TEMPLATES.md](TEMPLATES.md) for limits.

The complete web/.NET build and self-contained Windows package passed, with zero .NET warnings/errors and the existing Vite chunk-size advisory. Seventeen new frontend checks and 47 template/query-option/binding/quality regressions passed. Twelve isolated query-repeater API groups covered schema, captured queries, literal row values, forged/stale identities, whole-result validation, limits, static regressions and package round trips. Eleven static-template, twelve asset/popup and ten navigation API groups also passed. Chrome exercised independent repeated inputs, edit retention through polling, a record action, changed-row input reset, a subsequent completion, row removal and refreshed count tiles. Both appearance themes rendered successfully.

This increment retains one template level, text parameters, at most 100 query rows, and no popup openers inside query-backed templates. Query-driven child tag-quality errors appear on components but are not counted in the runtime header's aggregate tag totals. Nested templates, typed root/instance bindings, and a single atomic publication of scripts and project resources remain future work. The public installer and container were not refreshed.

## Previous operator navigation correction

Runtime screen tabs are removed. Projects choose one startup screen and may explicitly author an ordered menu with custom labels in Designer **Project settings**. Projects without navigation settings start on their first regular screen with no generated menu. New screens never add themselves to the menu. Existing button, browser-script and popup navigation remain supported; an unlisted screen is still reachable through authored actions. Deleting or converting a regular screen repairs startup/menu references in the same undo transaction. The [project guide](PROJECTS.md#operator-navigation) defines persistence and publication behavior.

The full web/.NET build and self-contained Windows package completed; .NET reported zero warnings/errors, and Vite retained its existing chunk-size advisory. Fourteen navigation-model, six document-tab and twelve pane-model checks passed. On isolated port 5091, ten navigation API groups covered validation, draft/publication isolation, duplication and package round trips; ten publication, ten runtime-action and twelve asset/popup regression groups also passed. The source worktree boundary check passed 189 entries, and the whitespace check passed.

Chrome verified a non-first startup screen without a menu, button navigation to an unlisted screen, retained form edits after navigation, popup open/close, custom menu labels and ordering, Save/Publish, and menu switching with popup locking. The settings dialog isolated Ctrl+Z from canvas history. The live 5090 gateway was backed up and restarted from `windows-x64-navigation`, then revision 14 was published with Overview as startup and four deliberate menu entries: Overview, Workcenters, Work orders and Equipment workbench. Its 14 screens, four templates and other project content were unchanged; twenty other existing files, including scripts, queries, connections and the SQLite database, matched the backup bytes. Python remained available and all three live OPC values had Good quality.

The live browser opened Work orders through the menu, opened the unlisted New work order through its authored button, and returned without modifying the three existing records. No browser warnings/errors were recorded. Runtime and settings screenshots remain in ignored `.data/test-evidence/runtime-authored-navigation.jpg` and `project-navigation-settings.jpg`. Shared docked views, nested menu components, parameterized page routes and browser history/deep links remain future work. The public installer and container were not refreshed.

## Previous Designer pane refinement

The collapsed Projects link now has one centered icon, including the automatic compact navigation breakpoint. Screens, Templates and Layers have two draggable dividers, independent scroll areas and per-project browser preferences. Keyboard arrows adjust pane height (Shift uses a larger step), Home/End reach the usable limits, and double-click restores the default split. Resizing is workspace state and never changes project content or Undo/Redo. Narrow layouts retain all three Project/Components/Tags labels.

The complete web/.NET build passed; .NET reported zero warnings/errors and Vite retained its existing chunk-size advisory. Twelve pane-model and six document-tab checks passed. Chrome verified live pointer dragging, keyboard adjustment, double-click reset, reload persistence, switching to Tags and back, and proportional fitting at 1000×700. The Save button remained disabled throughout, and the final live tab had no console warnings or errors. The final worktree source guard passed 185 entries.

The live gateway on 5090 received the built frontend after backing up its existing web assets, without restarting the gateway. Project, publication, connection and SQLite database hashes were unchanged. The screenshot is retained locally in `.data/test-evidence/designer-resizable-panes.png`. Root and template-instance bindings below remain planned. The public installer and container have not been refreshed for this UI change.

## Previous Designer workspace and query-control increment

Designer document tabs are closable and reopen from the Project screen/template lists. Closing preserves project content, including unsaved edits; a per-project browser preference remembers open tabs, including an empty workspace. Project, Components and Tags have separate tabs. Screens, Templates and Layers scroll independently. Screen/template and project metadata use name/value property sheets with parameter rows. These static document definitions do not add runtime bindings to arbitrary fields.

Named-query dropdowns provide explicit value/label columns, validated same-form row mappings, bounded complete choice sets and an explicit Reload selected record action. Automatic polling preserves edits. Published Python actions revalidate choice membership against their captured queries. Runtime query metadata and execution carry the loaded publication token, including tables and popup/template controls; stale reads fail explicitly. Numeric displays and gauges also expose a Tag path binding, bringing supported property targets to 14. [QUERY_CONTROLS.md](QUERY_CONTROLS.md) defines the contract and the additive, synthetic Equipment workbench example.

The initial complete web/.NET build and self-contained Windows `windows-x64-workbench` package passed. Against that self-contained executable on isolated 5091, 13 query-control API groups, eight equipment-application groups and eight property-binding groups passed. Earlier in this increment, ten existing action, 13 input-control and seven package groups passed on the isolated Debug gateway. The oversized-package check now accepts Kestrel's early connection reset only for an upload above 32 MiB, then verifies that the gateway remains available and the catalog is unchanged. Frontend checks passed 16 query-option, 36 binding, 15 input-event, nine bound-renderer, 29 input, 12 template, 13 popup, 33 canvas and six Designer-document cases. Equipment fixture checks passed 25 cases, and source-boundary checks passed their 38 synthetic cases.

Chrome verified closing all documents, reopening a renamed unsaved screen and template, restoration of the closed-all preference after reload, screen width/parameter edits and Undo back to saved content, and the full-height Tags pane. The published equipment workflow selected Press02, displayed its synthetic 64% gauge, changed quantity 45 to 46 through Python/SQLite, explicitly reloaded revision 2, and restored quantity 45. These are selected Chrome flows, not a complete browser/platform matrix. Browser testing also identified the header's static tag-path quality calculation; the follow-up corrects it to use current resolved form bindings.

The final quality follow-up passed ten new quality-model checks and twelve template regressions. The final complete build and self-contained republish succeeded; the refreshed isolated operator showed Live data healthy for the selected Press02 gauge, with no browser console errors. The live 5090 gateway was stopped, backed up, and restarted under its existing Windows identity from `windows-x64-workbench`. Adding Equipment workbench published revision 13. Deep comparisons preserved the original 13 screens, four templates, parameters and original queries; both script documents, connection configuration and SQLite database matched their backup bytes. Three live OPC subscriptions returned Good quality and Python was available.

The live dark-theme Designer showed independently scrolling Screens (210 px), Templates (144 px) and Layers (218 px) with all 14 screens retained. Tags had a 617 px scroll area. Screen/template property sheets, multiple closable tabs and the selected template were visible with no console errors. The live operator selected the existing Press02 record (quantity 45, revision 1) and showed healthy resolved data without changing the database. Screenshots remain in ignored `.data/test-evidence/`; the temporary 5091 gateway was stopped. The final source worktree guard passed 182 entries and the whitespace check passed.

Mutable custom/session properties, generic property-change events, query-fed repeaters, nested templates, richer tables and atomic script/project releases remain future work. The public installer and container have not been refreshed for this increment.

## Previous project-management increment

Projects home and the Designer's Projects link support create/open, revision-checked rename, draft-only duplication, archive/restore and `.sparkproj` import/export. Each project has its own on-disk resources, Python namespace, event scheduler, publication and operator URL. Gateway connections, tags and database files remain shared. The [project guide](PROJECTS.md) defines the package format, migration, ownership and archive lifecycle.

The full web/.NET build and self-contained Windows `windows-x64-projects` package completed. Sixteen frontend routing/package checks, nine project-management API groups and seven package API groups passed; the API groups also passed against the final self-contained executable. Malformed package coverage includes unsafe paths, duplicate entries/JSON keys, symlinks/reparse entries, unknown files, unsupported versions, invalid queries/scripts, image integrity, ZIP CRC and compressed/expanded size limits. Existing Debug API suites passed nine publication, ten runtime-action, twelve asset/popup and fourteen scripting groups after supplying their required sample query/table fixture. Frontend regression checks passed 34 binding, 14 input-event and nine bound-renderer cases. The source boundary's 38 synthetic cases passed.

Chrome exercised project creation, a separate Designer, explicit unsaved-switch protection with Stay, Save/Publish, duplication, archive/restore and an actual `.sparkproj` browser download. Import and image round-trips passed through the HTTP API; Chrome automation could not select the local upload file because the extension's file-URL access is disabled. That automation limitation does not affect the normal user file chooser. Project runtime archive clearing was checked separately after the publication poll.

Migration was checked on a legacy fixture and through multiple restarts, including a deliberately malformed legacy backup after the catalog existed. The live gateway on 5090 was then stopped, backed up and restarted from the final self-contained package. Factory overview retained its 13 screens, four templates, draft/publication revision 12, publication timestamp, queries and both script documents; image files matched byte for byte. Only the canonical project ID changed to `default`. The existing OPC connection resumed with three Good values, the script scheduler resumed revision 1, and the operator Work orders screen read its three existing SQLite records. The live Projects page had no browser console errors. Its screenshot and a current exported package remain in ignored `.data` directories.

The public installer and container were not rebuilt for this increment. Project/script publications remain separate, packages contain saved drafts rather than gateway backups, and authentication/RBAC/audit remain outstanding.

## Previous property-sheet, input-event and group increment

| Area | Implemented scope | Recorded checks so far | Remaining boundary |
| --- | --- | --- | --- |
| Property sheet | Common name/value rows with direct fx controls for 13 targets: existing caption/state/accent plus position, size, font, background/text/border colors and border width; existing type-specific/complex settings retained | 34 binding-model and nine bound-renderer cases; seven binding API groups; Chrome authored/saved a direct Width binding and verified its evaluated size and color in Preview | Not every JSON field is bindable; template/repeater containers excluded; layout bindings change Preview/operator geometry while authoring handles use stored geometry |
| Input events | Opt-in trusted browser JavaScript change/commit scripts saved with project publication; input/parameter snapshots, event payload, validated same-form assignments and notifications; serial bounded per-control queue | 14 input-event model/renderer cases and 12 combined component-event/group/style API groups; Chrome verified derived fields, text commit normalization, notifications and editor Apply/Cancel | No generic property-change events, gateway input handlers, durable event queue or script sandbox |
| Persistent groups | Flat per-document groups; atomic selection/move/copy/delete; merging/ungrouping; proportional per-axis box resize; groups treated as arrangement units | 33 canvas model cases, combined API coverage above and Chrome member selection, bounding-box resize, one-step Undo, duplicate/ungroup/regroup, Save/Reload and deletion | No nested groups, font scaling or new form scope; active layout bindings may override stored group geometry |

The [property sheet/events guide](PROPERTY_SHEET_EVENTS.md) defines these additions. The .NET/web build completed without errors; .NET reported zero warnings, and Vite emitted its chunk-size advisory. Current source checks passed 34 binding-model, 33 canvas, 14 input-event model/renderer, nine bound-renderer, 29 input, 12 template and 13 popup cases. An isolated Debug gateway on loopback port 5091 passed 12 component-event/group/style, seven binding, 13 input (including 131 invalid-definition variants), ten runtime-action and 11 template API groups. The final self-contained `windows-x64-properties` package then passed 12 component-event/group/style and nine publication API groups from its own executable on port 5091. The source guard passed 157 allowed entries and all 38 synthetic boundary cases.

In Chrome, the Width row's fx editor accepted and saved `220 + quantity * 8`. Preview quantity 12 produced total 30, rendered width 316 px and background `rgb(154, 52, 18)`. Enter committed an order code from ` wo-22 ` to `WO-22` and displayed its commit message. Cancel in the input-event editor discarded its draft; Apply retained a new change notification, which executed in Preview. The browser console had no errors.

Clicking one group member selected both controls. Bounding-box resize changed both 220×110 boxes to approximately 249.27×150 and moved the second control's X from 278 to approximately 310.73. One Undo restored both original sizes and X, with the project returning to its saved state. Duplication created a separate group; Ungroup/Group followed by Save and Reload retained selection of both copied members. The copied controls were then deleted. This covers the observed Chrome flows, not every browser, accessibility input or unusual geometry.

The live development gateway on port 5090 was updated from the final package with its data preserved. Loading Component workshop added one screen and no tags, and project revision 12 was published. Health and Python availability checks passed; the existing OPC connection reported Connected with all three subscriptions at Good quality. In the actual operator browser, quantity 12 produced total 30, the example's original width expression `200 + quantity * 8` rendered 296 px, and the background was `rgb(154, 52, 18)`. Enter normalized ` wo-live ` to `WO-LIVE` with its commit notification, and the console had no errors. The live designer displayed all 13 common property rows and their fx controls. Its screenshot is retained only in the ignored local data directory at `.data/test-evidence/property-sheet.png`.

The earlier increments below retain their original acceptance results and do not establish acceptance of the expanded surface. The public installer and Linux image remain their previously recorded baseline.

## Previous component-binding and canvas increment

| Area | Implemented scope | Verification | Remaining boundary |
| --- | --- | --- | --- |
| Component properties | Typed Number/Text/Boolean custom properties; safe expressions for Text, Enabled, Visible and hex Color; named form, parameter, tag and same-scope custom references; binding dialog with result/error preview | 24 expression-model and nine renderer checks; seven isolated binding API groups; Chrome exercised form-driven captions/color/visibility, a custom minimum change and invalid-binding rejection | Custom properties are saved static definitions; no mutable session properties, property-change events, query bindings or arbitrary property targets |
| Button event authoring | Expanded gateway Python onClick editor with syntax highlighting, line numbers, find, completion, saved-library names and form/parameter context | Chrome exercised Apply, Cancel and execution returning an actual Python result | Existing Python button event contract only; broader component events, debugger and language server remain future work |
| Canvas/history | Marquee selection, additive selection, revision-safe Undo/Redo and remapping of explicit custom-property references between duplicated controls | 23 canvas checks; Chrome selected two controls by marquee, nudged the selection, undid/redid it and completed Save → Undo → Redo → Save without a revision conflict | Persistent groups and proportional group resizing were added in the current increment |

The [binding guide](PROPERTY_BINDINGS.md) defines expression syntax, limits, publication and error behavior. Templates and saved repeater rows evaluate their leaves using their own form/parameter context; popup leaves use the popup context. Hidden controls remain reachable while authoring. Runtime hidden controls leave both rendering and hit testing, and binding errors block interaction with a diagnostic. UI Enabled/Visible behavior is not authorization.

The final .NET/web build and self-contained Windows package completed. Frontend checks passed 24 expression, nine binding-renderer, 23 canvas, 29 input, 12 template and 13 popup cases. The final self-contained executable on isolated loopback port 5091 passed seven binding, 11 template, ten runtime-action and nine publication API groups. The 13 input API groups, including 131 malformed variants, passed earlier in this increment, before the last validator changes for expression whitespace, blank reference keys and template-wrapper properties; they were not rerun against that final binary. The source guard checked 149 allowed source entries, and its 38 synthetic boundary cases passed.

Selected Chrome checks covered the actual binding and event dialogs, live form-driven changes, custom-property editing, Python execution, marquee movement and history/save behavior described above. These checks do not establish a full browser, accessibility or platform matrix. The live development gateway on port 5090 was updated from the rebuilt package and project revision 11 was published with the independently authored Binding workshop. In the operator browser, changing quantity from 0 to 5 changed the caption and enabled Apply; the Python action returned `Applied quantity: 5`, and Show details toggled the bound body. The final browser console contained no errors. Three existing live OPC subscriptions reconnected with Good quality, alongside 25 memory and eight simulated tags with Good quality. This is a local reconnect observation, not broader connector acceptance.

The isolated test gateway on port 5091 was stopped after verification; the development gateway remains running on port 5090. Local screenshots are retained under the ignored data directory. The public installer and Linux image still describe their earlier baseline; no installer refresh or elevated Windows service lifecycle acceptance is claimed.

## Previous application and scripting increment

| Round | Implemented scope | Verification so far | Remaining boundary |
| --- | --- | --- | --- |
| Database-backed screens | Managed local SQLite creation/schema browsing, typed read/update named queries, table sort/filter/selection/refresh, selected-row form fields and a work-order create/edit example with row-version checks | 157 connector executable checks, 12 SQLite API groups, 20 example/preflight checks and 13 table-selection model checks pass; Chrome create/edit/reload/conflict/sort workflows pass | Real SQL Server validation, multi-statement transactions, database permissions and broader concurrency/load coverage |
| Persistent scripting workspace | Library/Gateway/Browser resource tree, saved revisions, explicit script publication, saved draft/published Python runs and a bundled Python/JavaScript editor | 14 scripting API groups, editor typecheck and complete web build pass; Chrome author/save/run/publish/import and draft-retention checks pass | Nested packages, debugger/language server, manual cancellation and third-party dependency environments |
| Gateway/browser events | Published CPython startup/fixed-delay timers with bounded status/logs; JavaScript browser startup/screen-open events with tab session memory and UI helpers | API startup/timer/cancellation groups, a daemon restart audit and eight browser lifecycle model checks pass; Chrome displays scheduler/logs and executes an authored screen-open notification | Tag-change/message/shutdown/calendar events, durable history, scheduling guarantees and complete lifecycle parity |

The [scripting guide](SCRIPTING.md) defines execution scopes, resource limits and publication behavior. Published operator Python actions now use captured project query definitions. Manual/console/preview/gateway executions use current shared queries, while libraries have their own script publication. Project and script publications are not one atomic application release. Browser events are trusted same-origin code; Python workers are not a security sandbox.

These rounds extend the application builder with database workflows and persistent logic. They do not change the trusted-loopback deployment boundary. Authentication, RBAC and audit remain a gate before shared-network operation. Packaging and published release claims below describe their recorded baseline unless a current-round result explicitly replaces them.

The 157-check connector run combines existing SQL/OPC checks with disposable real SQLite files: creation/schema/persistence, typed reads and INSERT/UPDATE/DELETE, optimistic conflicts, constraints, cancellation rollback, active-query cancellation, lock waits, bounded results and managed-path guards. The 12 SQLite API groups exercise the gateway, Python dataset/update results and captured-query publication behavior. The 20 example checks cover collision preflight and validation before database calls; they are not browser tests.

The 14 scripting groups cover revision conflicts, library imports, client-only code projection, stored-resource execution, typed parameters, draft isolation, startup idempotence, fixed-delay/no-overlap timers, cancellation before a delayed write, bounded logs, timeout and dataset results. A separate restart audit retained the publication/library/client projection and ran startup exactly once after restart. These checks used an isolated gateway.

Actual Chrome checks populated form fields from a selected row, saved quantity/status changes with immediate table refresh, rejected a stale resave, and found a newly created record after reload/filtering. Numeric sorting retained the selected record ID. In Scripting, authored library code survived navigation away and back, returned the expected manual result, and imported correctly from the console after publication. Invalid parameter JSON blocked switching and retained its text. Scheduler/log entries were visible, and an authored JavaScript screen-open event displayed its notification.

The rebuilt self-contained Windows executable passed the 12 SQLite and 14 scripting API groups again. The development gateway restarted from that package, and the example loader added two screens, one local database, four queries, one Python library, two gateway events and one browser event while preserving existing project resources. The public installer and Linux image remain earlier baselines; this increment does not claim refreshed installer/Linux acceptance. Real SQL Server execution and actual Windows service lifecycle remain unverified.

## Previous input and canvas rounds

| Round | Implemented scope | Verification | Remaining coverage |
| --- | --- | --- | --- |
| Everyday inputs | Multiline text, spinner, slider, radio group, local date/time and toggle; 19 palette types and ten inputs total | 29 input/React-renderer checks; 13 API groups including 131 malformed-definition variants; the 13 groups also passed from the rebuilt self-contained Windows package. Chrome submitted all six types through a published Python action, verified memory-tag readback and retained values after reload. | Broader browser/platform matrix, field change/commit events and external device writes |
| Canvas arrangement | Multiple selection, shared constrained movement, grid snapping, alignment, equal-gap distribution, duplicate/delete and Undo | 19 geometry model groups; Chrome verified Shift-click selection, constrained group drag/grid, 1/10 px keyboard nudging, alignment, distribution, duplication/deletion and Undo. Save → Undo → Save retained the latest gateway revision. | Marquee/Redo and persistent groups/group resize were added in later increments above |

The geometry suite covers shared bounds and offsets, all six alignments, fractional/zero/negative distribution gaps, imported geometry, minimum sizes, ID/field collisions, deep-copy isolation and all ten input types. Browser coverage is bounded to the interactions listed above; it is not a full accessibility or platform matrix.

The Windows source build completed with zero warnings or errors. Regression reruns passed 10 action, nine publication, 11 template and 12 asset/popup groups; 25 existing frontend model checks; 18 gateway checks (SSE not requested); and 13 tag-definition checks (capacity boundary not requested). The source guard passed its 38 synthetic cases. Tests used isolated loopback port 5091 and separate data. The updated self-contained package runs on local port 5090 with the prior project preserved, the Input workshop example published, and the existing three-node OPC subscription connected. The public installer release and Linux image remain the earlier baseline.

The [operator inputs example](../../examples/operator-inputs.json) is available through `node tools/load-example.mjs operator-inputs`. Its submit script writes configured memory tags only. Date/time input is an optional local wall-clock string without timezone conversion. Numeric step is a UI convenience, and toggles change form state until submitted. Later increments above add marquee selection, Redo, persistent groups and group resizing.

## Earlier baseline evidence

These results predate the source rounds above unless a row says otherwise. They are retained as baseline evidence, not as claims that every later change completed the same verification.

| Area | Passed checks | Boundary |
| --- | --- | --- |
| Gateway | 19 smoke checks: health, project revisions/validation, tags, sample queries, Python execution/errors/timeout recovery, origin rejection and SSE. | Sample values and sample queries do not validate external connectors. |
| Forms and publication | 10 action groups and nine publication groups on an already-published fixture. Typed inputs, rejected fields, hidden source, draft isolation and stale tokens were exercised. | The existing publication fixture skipped the initial unpublished-state case. No authorization claim. |
| Templates | 11 integration groups, including independent instance/row writes, one-pass parameters, forged targets, invalid graphs/limits and source stripping. | Single-level templates and saved rows only. |
| Assets/popups | 12 groups covering PNG/JPEG/WebP, deduplication, bounds/MIME/container rejection, invalid IDs, 18 forged-action cases and 17 invalid-publication cases. | Header/container validation does not decode raster pixels. |
| Frontend model | 25 checks: 13 popup and 12 template cases. | Model tests complement, rather than replace, browser interaction. |
| Tags/connectors | 14 typed-tag checks and 81 connector checks, including isolated subscription/reconnect behavior. | Does not cover every device, outage or workload. |
| Live OPC UA | Secured Windows browse/read and three-node monitored-item operation with Good quality and fresh timestamps. | Local Windows test environment; live Linux OPC UA remains unverified. |
| Windows browser | Fixed-canvas editing, saved/published isolation, independent forms/rows, popup context, parent-edit retention, fresh reopen, focus trapping/return and busy dismissal locks. | Selected Chrome workflows; not a full browser/accessibility matrix. |
| Appearance/navigation | Light/Dark switching, preference persistence/tab synchronization, System resolving the current OS preference, and collapsed-sidebar persistence/navigation. | Changing the OS theme itself and macOS browsers were not tested. |
| Windows packaged runtime | Self-contained execution and bundled Python with .NET runtime paths set to nonexistent directories. Asset bytes/metadata survived an isolated restart. | Real Windows service lifecycle remains unverified. |
| Linux packaged runtime | Non-root Linux/amd64 with networking disabled passed 19 gateway and 12 asset/popup groups; four image fixtures survived restart. | No live Linux SQL/OPC or full volume/upgrade-recovery claim. |
| Sidebar image refresh | Subsequent frontend-only Linux refresh passed offline health, Python execution and exact served-asset checks. | Backend was unchanged; full backend suites were not repeated. |
| Installer extraction | All 556 extracted payload hashes matched; 20 helper guards and 19 gateway plus 12 asset/popup groups passed from the extracted application. No service, installer registration, Start-menu shortcuts or uninstaller was created. | Current-user extraction only; elevated installation, LocalService execution, service upgrade/uninstall and ACL/credential lifecycle remain unverified. |

The unsigned installer and checksum are published with the [Windows preview release](https://github.com/SparkStudioX/releases/releases/tag/v0.1.0-preview.1). Release checksums identify that artifact; rebuilding source can produce a different package.

Browser file-chooser upload automation was blocked by a browser-extension permission. API upload and browser image rendering passed, but file selection itself is not claimed as verified. Real SQL Server execution remains unverified.

## Capability status

The September 28 record below is retained as historical evidence. The current summary table following it reflects the September 30 source tree; development features do not imply installer inclusion.

### Typed templates and state controls: local verification, 2026-09-28

The self-contained Windows development build now includes typed public template parameters and Password input, Multi-state button and Multi-state indicator. Focused frontend model/renderer/authoring suites passed 232 checks across parameters, query rows, popup provenance, runtime health, inputs/events, property bindings and editors. The isolated gateway passed 70 distinct integration groups/checks across seven suites: typed parameters (11), state controls (8), query repeaters (12), query popups (10), input controls (13), template wrapper properties (8) and property bindings (8). State-control coverage includes exact whitespace behavior, invalid definitions, publication isolation and portable package round trips.

Release publication and the production web build passed. The web bundler retains its existing large-chunk advisory. The source policy passed all 211 working-tree entries and 38 guard regression checks. No commit or source staging was performed.

Chrome verified segmented pointer/keyboard selection, the bound indicator, masked input and Python submission, blank values after reload, explicit unknown-state health, state-row validation/Apply/Undo, and invalid typed conversions leaving saved data intact. Template instances displayed independent numeric limits and Boolean permissions; a repeated instance's Python action received native Number/Boolean values. The local development gateway serves the new build. Template workshop was upgraded and Controls workshop added; the default and existing workflow projects were preserved. Backup/hash comparison found only the project catalog and the deliberately updated workshop draft/publication changed among existing files. Three existing OPC UA tags remained Good.

These results apply to the current local Windows build. The public installer and Docker acceptance remain their earlier baseline. The new multi-state button is a local form selector with authored actions, not an automatically acknowledged equipment command. Private template state, dynamic parameter bindings and the remaining component families are still planned.

### Current source summary: 2026-09-30

| Capability | Current state | Next work |
| --- | --- | --- |
| Designer/operator | Partial: fixed canvas, 41 component types with consistent property grids, sixteen inputs, arrangement/history tools, scalar and dataset bindings, typed screen/session/private-instance state, nested forms and query rows through four levels, typed parameter fx, automatic events, images, popups and editable tables | Flex/breakpoint layouts, broader declarative actions and the remaining component families |
| Projects | Catalog, portable drafts, document tabs, optimistic saves and atomic application publication/restore including screens, queries, libraries and jobs; offline full-data and online configuration recovery have separate scopes | Cross-version migrations and broader recovery/service acceptance |
| Tags | Memory/OPC definitions, expressions, folders, reviewed bulk import/export, immutable UDT versions, pinned instances, overrides, named scan groups and default-provider lifecycle | Additional providers, broader type models and device/load acceptance |
| OPC UA | Partial client, subscriptions, reconnect and explicit permissioned typed commands with confirmation/readback | Certificate administration, real-device recovery/load coverage and additional drivers |
| SQL | Managed local SQLite, parameterized read/update query resources and atomic optimistic table batches; real SQL Server validation open | SQL Server acceptance, broader schema tooling and transaction behavior |
| Scripting | CPython libraries, seven gateway event families, persistent run diagnostics, browser resources, scoped Python UI actions/events including focus/keyboard/pointer handlers, unified Actions & Events editor, and transient gateway-to-session messaging | Broader declarative actions, package environments, deeper debugging and durable delivery/replay; each increment retains its own verification boundary |
| Identity/audit | Partial: local accounts, separate engineering/operator sessions, project grants including Commands, delegated gateway capabilities, CSRF/revocation, operator tag scopes and bounded local audit | Network/TLS and lifecycle acceptance, external identity/MFA and durable tamper-evident audit |
| Historian/alarms | Planned | Durable quality-aware history, alarm lifecycle, journals and notifications |
| Reporting/transactions | Planned | Report data/layout/rendering; transactional triggers and outage behavior |
| Enterprise/migration | Assessment/planned | Fleet operations, redundancy, broader integrations and narrow import contracts |

## Next application-building sequence

1. **Reusable application forms — bounded baseline implemented.** Nested templates and saved/query-row repeaters preserve independent form scopes through four levels, including contextual dialogs. Lists, trees, configurable table columns, validated single-cell editing, multiple row selection, atomic database batches and loaded-result paging are implemented. Formatted/barcode inputs and embedded/tab/split/dock containers extend the application workflow. Remaining work includes flex/breakpoint layouts, broader input families, nullable/date table edits and server-side paging.
2. **Deeper property behavior.** Typed screen/session/private-instance state, two-way input/state bindings and parent-form template-parameter fx with state/tag sources and gateway reconstruction are implemented, along with bounded property-change and mount/unmount events. Scalar/dataset query properties, nested query sources and bounded refresh are verified. Screens still need runtime title/background properties. Common instance presentation/geometry bindings and Text/Number/Boolean template parameters are implemented. Keep resource IDs, resource names, screen kind and template references structural, and preserve authored canvas dimensions separately from evaluated runtime geometry.
3. **Reliable application releases.** Atomic application publication and reviewed rollback now include screens, queries, script libraries and gateway jobs. Extend cross-version migrations and refresh installer/container and broader recovery acceptance before calling the delivery gate complete.
4. **Connected pilot readiness.** Extend the current gateway console/metric and backup/restore foundations with broader deployment acceptance, and harden connections, certificates and identity using G01–G09 below. Validate real SQL Server operation and exercise HTTPS/network configuration, service installation, offline deployment and recovery.
5. **SCADA subsystems.** Build on the versioned UDT and explicit typed-command baseline with real-device acceptance, durable buffering, then historian/alarm engines and their dependent components. G10–G18 separate the tag, history, notification, reporting and execution contracts; fleet and redundancy follow in G19.

Template parameter declarations retain authored text while resolved Number and Boolean values remain native scalars in each instance. Parameter fx reads the immediately containing form's declared parameters, non-password inputs, custom properties and typed state, without cross-parameter dependencies or re-interpolating computed strings. Query rows use literal mapped data and strict whole-result validation. Runtime actions reconstruct context from saved published definitions, validated parent inputs and sparse typed source-state snapshots. Root, screen and popup parameter declarations remain text. Typed browser state is reactive and scoped as described above; supported input values can bind directly to it in both directions. Type/context changes invalidate stale form edits, events and query results. Open popups retain frozen source values separately from their current state; source definition and query-row changes still invalidate stale dialogs. Automatic property/lifecycle events define ordering, silent initial/equal values, bounded queues and shared loop protection; broader dependency graphs remain planned. A template definition is a reusable schema, not shared mutable runtime state.

## Designer implementation track: 2026-09-29

The next Designer increments should make complete application workflows easier to build and diagnose. Keep SparkStudio's browser editing, typed data model and .NET/CPython execution boundaries. Native desktop shortcuts, Java APIs, file formats and visual appearance are not compatibility targets. Requirements below are independently authored product decisions; detailed external-product observations remain outside this repository.

### Baseline and delivery order

The verified baseline includes the fixed canvas, consistent component/property panels, arrangement and undo tools, document tabs, project settings, scalar/dataset bindings, screen/session state, two-way input/state bindings, typed template-parameter fx and bounded nested forms/query rows. Model, authoring, runtime, gateway and browser verification is recorded above. Private instance state, property/lifecycle events and unified Actions & Events authoring are also verified. Broader event families and dependency graphs remain separate increments; live-package and public-distribution acceptance are recorded independently.

P0 identifies the next application-building gates, not a release date. It does not supersede the gateway track's deployment and security gates. P1 work follows the relevant data/runtime contracts; P2 adds breadth after core workflows are dependable.

1. The **D01 parameter-binding**, **D02 private instance-state** and **D03 property/lifecycle and interaction event** baselines and unified Actions & Events editor are verified. Broader declarative actions remain separate work.
2. **D01 live tag and bounded indirect sources**, **D04 scalar/dataset query bindings** and nested query repeaters are verified. Broader dependency graphs and refresh schedules remain separate increments. **D08** has guarded read-only/live-action capabilities; fixtures, deeper context controls and complete draft-resource snapshots remain separate gates.
3. **D05** has verified search, resource-change and bulk-replacement baselines. **D06** includes canvas precision and embedded/tab/split/dock containers; **D07** includes reusable appearance resources. Flex/breakpoint layouts, object snapping and conditional style rules remain open. Extend supplied-data charts and other independent palette families alongside these increments.
4. The current **D09 authoring defaults**, **D10 image replacement**, **D11 diagnostic snapshots** and **D12 caption localization** increments have bounded scopes recorded above. Complete their outstanding browser/package verification, then extend them through the remaining gates in the table rather than treating whole phases as finished.

### Application behavior and data

| ID / priority | Deliverable and current boundary | Completion gate |
| --- | --- | --- |
| D01 / P0 | **Typed parameter and indirect data bindings — tag and bounded indirect sources implemented.** Template/repeater parameters use the common fx dialog for containing-form parameters, non-password inputs, custom properties and typed session/screen/parent-instance state, with typed previews and gateway reconstruction. Live tag parameter sources and declared, typed reference substitutions in tag addresses are implemented, with quality rejection and authoritative gateway reconstruction. Resource identity and template references remain structural. | Preserve verified nested/repeated/popup scopes, invalid-source blocking, draft reset, Undo, save/publication isolation, frozen popup source snapshots and stale-result rejection as sources expand. Define quality/source diagnostics and dependency rules for each added source; browser-supplied resolved values never establish authority. Indirect tag writes require G11 independently. |
| D02 / P1 | **Private instance-state baseline verified.** Templates declare typed internal defaults with explicit reset and disposal, private fx/value sources and browser script helpers. Each placement, nested template and repeat row owns its values. Public parameters, private mutable state and derived presentation remain distinct; custom properties are still static definitions. | Preserve isolation, stable-row sorting, removal/reset and stale-helper rejection across parameter changes, navigation, popup closure and publication replacement. Validate declarations and packages without persisting transient operator state. Broader derived-property graphs remain separate work. |
| D03 / P1 | **Component events and common action authoring — existing event families verified.** One staged Actions & Events editor covers button/native actions, input events, Python/JavaScript mount, property-change, unmount and named messages, with one Apply/Cancel and Undo. Python supports wrapper and redacted password non-input events; password change/commit remains JavaScript. `self.value` stages validated form changes alongside presentation/state effects. All shared script editors offer compile-only checking and consistent system API help. `system.ui.sendMessage` broadcasts or targets authenticated same-project operator tabs; `getSessionInfo` discovers recipients. Local `app.sendMessage` keeps instance/screen/single-tab scopes. See [workshop](LIFECYCLE_SESSION_WORKSHOP.md). Shared durable changes use tags/database bindings. Focus/blur, key down/up, double-click and pointer down/up are implemented for Python and JavaScript in the same editor; password payloads are redacted and inactive panes suppress authored handlers. Broader declarative actions remain planned. | Preserve verified ordering, equal-value suppression, bounded queues/rates, cancellation, stale-edit rejection and permission/publication checks. Unmount has captured reads and no UI writes; delivery is best effort. Transient tab messages are not durable queues or acknowledgements of handler success. Device commands remain gated by G11. |
| D04 / P1 | **Query-backed properties and data refresh — scalar, dataset and nested-query baseline implemented.** Scalar fx supports saved read queries, typed form/state mappings, result transforms, explicit preview and bounded shared on-change/polling refresh, including nested forms and popups. Rectangular datasets support static or named-query sources; nested query repeaters share bounded coordination through four template levels. Strict row/column and per-repeater limits reject oversized results instead of truncating them. Broader refresh scheduling remains planned. SQL and credentials stay on the gateway. | Preserve exact result shape and parameter checks, cancellation, concurrency limits, stale-result rejection, denied/timeout/offline handling, publication isolation and event feedback protection. Updates require deliberate submission, validation and conflict handling; a refresh never implies a database write. Depend on G06 for provider acceptance. |

### Authoring workflow and presentation

| ID / priority | Deliverable and current boundary | Completion gate |
| --- | --- | --- |
| D05 / P1 | **Project search, dependencies and safe refactoring — scoped baseline verified.** Draft resources have scoped search, direct navigation, used-by views and missing known-target diagnostics. Canvas-resource rename/deletion previews preserve IDs, block surviving uses and distinguish code/SQL text. Supported display-text/tag-path replacements provide selective before/after previews, one Undo step and exact local snapshot checks. Broader query/script/resource refactoring and cross-session transactions remain open. | Renaming a resource preserves stable identity; referenced deletion identifies affected locations before committing. Bulk changes are atomic and undoable, retain unrelated edits and reject stale revisions. Search results distinguish structured references from text matches. No claim that dynamic script references can be exhaustively inferred. |
| D06 / P1 | **Canvas precision and optional view containers implemented.** Custom bounded grid, coordinate/boundary feedback, selection by type and matching width/height/size extend existing alignment/distribution. Saved groups remain atomic and authored bindings stay intact. Embedded, tab, split and dock containers reuse independently scoped template panes, with retained drafts, inactive event suppression and pointer/keyboard split sizing. Object snapping, anchors/relative resize rules, configurable min/max constraints and flex/breakpoint containers remain planned. | Check keyboard and pointer editing, zoom, nesting, aspect ratio, clipping/overflow and minimum viewport behavior. Multi-selection changes form one undo transaction. Preserve authored geometry separately from evaluated bindings and runtime layout; container conversions cannot silently change state or reference scope. |
| D07 / P1 | **Reusable appearance-resource baseline implemented; conditional rules remain open.** Six typed visual properties have stable style IDs, assignments, staged edits, usage blockers, source inspection and deliberate theme/template/style/local/binding precedence. Styles cannot carry visibility, enabled state or authority. Quality-aware state-to-style rules and broader effective-state inspection remain planned. | Verify default/unknown/bad-quality states, conflicting rules, theme changes, instance overrides and removal of a referenced style. Style changes cannot grant permissions or hide actionable failure indicators. Package referenced styles with the application and validate keyboard focus, contrast and reduced-motion behavior. |
| D08 / P0 | **Guarded communication baseline implemented; simulation remains open.** Preview starts live read-only; an administrator explicitly enables trusted live actions through a session/project-bound expiring capability. Server endpoints reject unauthorized writes/Python and mode changes cancel supplied pending work. Authored browser events are blocked in read-only mode. Fixtures, viewport/quality simulation and complete draft query/library snapshots remain planned. | Enforce the chosen mode at the server action boundary as well as in the UI. Read-only preview cannot write through a script/query/navigation side effect. Mode changes clear incompatible pending work; preview sessions do not mutate published runtime state. Exercise disconnected, denied, stale and invalid-data scenarios alongside normal rendering; trusted JavaScript and Python are not sandboxed. |
| D09 / P1 | **Canvas authoring-default baseline implemented.** Project settings stages validated initial screen/template dimensions and grid; creation and project reopening apply them without resizing existing resources or replacing a current toolbar override. They remain distinct from per-user pane/theme preferences. Provider/connection, time-zone and broader preview defaults remain planned alongside existing navigation/runtime settings. | Show effective values and their source; reject unavailable references and incompatible defaults. Verify portable package round trips, preview/runtime consistency and preservation of unsaved resources. Identity and audit settings remain gateway-authorized operations under G07/G09. |
| D10 / P1 | **Image inventory/replacement baseline implemented; reusable bundles remain open.** Searchable local assets show structured screen/template uses and preview selected reference replacements with snapshot validation and one Undo step. Immutable old files remain available to existing publications. Versioned template-bundle manifests, asset folders/metadata and broader drawing operations remain planned. | Bundle all dependencies for offline operation, reject unsafe/unsupported assets and surface missing references. Replacements preserve intended sizing and do not orphan published revisions. Validate install/update conflicts, rollback and accessibility. External catalogs are optional; import compatibility is separately scoped. |
| D11 / P1 | **Bounded diagnostic-snapshot baseline implemented.** Current-root property errors, known missing references, tag quality and timestamped retained component-event messages have composable filters and owner navigation. Unsampled query properties are disclosed; inspection executes no code or network request. Deeper instance scopes, Python/SQL history, input-event traces, watches and controlled scratch evaluation remain open. | Distinguish browser JavaScript, gateway CPython, binding evaluation and database failures. Bound trace retention and execution, redact secrets and enforce permissions. Diagnostics correlate with G02/G17 without becoming an unrestricted server console. Test failures and cancellation as well as success. |
| D12 / P2 | **Offline caption-translation baseline implemented.** Stable message keys, six left-to-right language families, parameter-preserving text, staged catalog edits, locale selection and visible fallback travel with the project. Input values, IDs and action parameters remain unchanged. Number/date/time-zone formats, menu/option translation, pluralization, RTL and deployment-specific input aids remain planned. | Missing translations fall back visibly and predictably. Changing language cannot change resource identity, numeric storage or action parameters. Test long text, supported writing directions, focus order, touch targets and DST boundaries; package fonts and translations for offline deployment. |

### Designer acceptance scenarios

- Build two equipment panels from one template, bind each to different context, change a public parameter and observe independent internal state, derived presentation and diagnostic paths. Repeat the scenario inside rows and popups.
- Bind a query-backed form, edit local values and submit one authorized action. Test validation failure, denied access, timeout, late results and navigation away; verify that neither refresh nor read-only preview performs a write.
- Find every structured use of a shared resource, preview a rename/replacement, apply it once and Undo it. Save, reopen and publish; confirm complete dependency packaging and draft isolation.
- Resize an authored screen across supported viewports, simulate bad-quality data and switch locale/theme. Verify usable controls, clear failure states and consistent behavior in Preview and the published operator.

Record automated checks, interactive browser verification and deployment evidence separately for each increment. Menu/dialog inspection identifies possible requirements; it does not verify execution semantics, performance, compatibility or completed SparkStudio behavior.

## Gateway implementation track: 2026-09-29

This track makes the gateway a manageable application platform. Implementation remains native to the .NET gateway, browser UI and CPython workers. Administration pages must be backed by persisted configuration, authorization, meaningful runtime status and recovery behavior before they are marked implemented. A menu, empty table or successful build is not a completed service.

### Current foundation

Source inspection confirms project management and separate publications; local accounts, project grants, operator settings and recent audit history; OPC UA endpoint discovery, connection tests, browse-to-tag mapping and subscription status; SQL Server configuration and managed SQLite creation/schema browsing; memory/OPC tag definitions; and startup/timer script status and execution logs. Recent increments add administrator overview/session inventory, bounded process/API observations, checked publication history and read-only deployment observations. These are partial foundations; the top section records current verification separately from earlier evidence.

Connections and tags are gateway-wide resources currently reached from the Designer. The new gateway overview provides administration entry points and resource inventory; deeper managed-resource configuration, durable diagnostic history and operational fault acceptance remain open. Project packages omit gateway configuration and data, so they cannot serve as gateway backups. Operator publication history likewise does not recover an entire gateway.

### Pilot delivery priorities

P0 is required for a recoverable connected pilot; P1 broadens that baseline. Designer and gateway increments can proceed together, but their acceptance gates remain separate. G01/G02 now have an administration/metric baseline and G03 has operator publication history. Full recovery and deployment under G03/G04 remain priorities before G05–G09 complete connection and identity acceptance.

| ID / priority | Deliverable and current status | Completion gate |
| --- | --- | --- |
| G01 / P0 | **Gateway administration baseline implemented.** Administrator-only overview includes identity/version/uptime, searchable projects/connections, counts and application entry points. Timestamped snapshots become explicitly stale. Session inventory separates engineering/operator audiences and exposes opaque management handles for reviewed audited revocation. Per-project session attribution and deeper managed-resource configuration remain open. | Reload and deep links preserve context; permissions hold at API and UI; changes use revisions and staged Save/Cancel; session disconnect/revocation is explicit and audited; stale status never appears healthy. |
| G02 / P0 | **Process/API diagnostic baseline implemented.** CPU, process/managed memory, data-volume free space, active/lifetime counters and 128 completed route-template observations accompany a redacted local support JSON. Identities, request values, configuration and authored bodies are excluded from that export. Structured durable logs, script/subscription correlation, queue/worker metrics and saved dashboards remain open. | A controlled connection failure, slow query, script timeout and low-disk condition each produce attributable status/logs. Retention is bounded; collection overhead is measured; bundles exclude credentials, tokens and private keys; diagnostics remain usable during service faults. |
| G03 / P0 | **Publication history, offline full-data recovery and online scheduled configuration backups implemented.** Encrypted new-location restore starts in enforced recovery mode and requires reviewed restart. Running-host snapshots exclude live databases/history/audit; multiple daily/weekday schedules deliver to named SMB/FTP/FTPS/S3 targets and verify bytes before schedule-specific age retention. Same-identity DPAPI policy and separate database backups are explicit. Atomic whole-application publish/rollback now captures screens, queries, Python libraries and gateway/browser events together. Service switching and cross-version migration remain open. | Extend the measured isolated recovery and retention tests to intended service identities, real domain SMB/trusted remote FTPS, intended AWS/S3-compatible policies, production-scale data and supported application-version migration. Cover accounts/grants, connections, tags, projects, assets, publications and managed data; test corrupt/incompatible archives, interruption and rollback. |
| G04 / P0 | **Deployment observations, installer Local/Network HTTPS and a published Docker restart baseline implemented; broader hosting acceptance remains open.** Local management plus optional all-interface TLS uses protected PEM references, strict certificate checks and fail-closed override rules. Docker x86-64/emulated ARM64 verifies guarded setup, persistent configuration/databases/keys/TLS, native dependencies and offline notice/source inventories on 8090/8443. Elevated Windows service acceptance, remote client trust, renewal, trusted proxies, physical ARM and cross-version container upgrade/recovery remain open. | Test remote HTTPS and proxy behavior without weakening loopback restrictions; renew an expiring certificate; install/upgrade/uninstall as the intended service account; recover failed upgrades and container volumes. Define restart requirements and preserve a recovery route after invalid configuration. |
| G05 / P0 | **Connection lifecycle and OPC UA client security — partial.** Revisioned rename/enable/disable and deletion, durable timestamped tests with stale-result rejection, saved tag/UDT/draft/published dependencies and bounded tag quick watch are implemented. Deletion checks references under the shared configuration lock, preserves database/certificate files and releases idle sessions after persistence. Manual endpoint entry retains strict security with actionable authentication/certificate advice; discovery explicitly fills mode and pin. Continuous reconnect fault acceptance, certificate lifecycle and credential-reference administration remain open. | Exercise endpoint downtime, server restart, certificate replacement/rejection, bad credentials, disabled connections and stale samples. Verify subscriptions recover without duplicate monitored items or cached configuration leakage. Deletion reports affected tags/queries. |
| G06 / P0 then P1 | **Database operations — partial.** Designer read cancellation/deadlines and typed preflight are implemented and exercised against SQLite; connection diagnostics expose named-query dependencies. Atomic optimistic table batches are implemented with one transaction, version-per-row updates and real SQLite rollback/concurrency verification. Complete live SQL Server acceptance and pool health. Add a supported .NET provider catalog and dialect/capability contracts; evaluate PostgreSQL and MariaDB/MySQL after the existing providers pass. | Run reads and guarded writes against actual supported servers, including TLS failure, restart, pool exhaustion, concurrent conflicts and uncertain write outcomes. Prove transaction behavior per provider; do not retry an ambiguous write automatically. Driver availability must be distinct from connection health. |
| G07 / P0 | **Operation permissions implemented.** Local accounts retain separate engineering/operator sessions and project View/Operate/Design/Publish grants. Explicit Commands permission does not follow from Operate. Five delegated gateway capabilities cover diagnostics, configuration, backups, audit and session administration; account administration and recovery approval remain administrator-only. See [access boundaries](FINE_GRAINED_ACCESS.md). | Negative API tests cover each privilege and audience; revoked/disabled accounts lose access; concurrent changes reject stale revisions; last-administrator recovery works; history identifies actor, target and outcome without secret values. |
| G08 / P1 | **External identity and machine access — planned.** OIDC first, with SAML/LDAP/AD and database-backed identity evaluated by deployment need. Define claim-to-role mapping, MFA integration, identity-provider outage behavior, security policy scope and service accounts/API credentials. Distinguish inbound API credentials from outbound OAuth clients. | Validate sign-in/out, expiry, issuer/audience checks, mapping changes, denied users and identity-provider outages. Machine credentials need least privilege, rotation, revocation and safe one-time presentation. Context/network policy supplements authentication rather than granting implicit trust. |
| G09 / P0 core, P1 extensions | **Secrets and durable audit — partial local baseline.** Review storage/redaction for existing connection credentials, then introduce secret references, rotation and deployment portability. Extend the bounded local audit to configured retention, filtering/export and durable append-only or tamper-evident storage. External secret providers follow the local lifecycle. | Rotate a credential without leaking it through APIs/logs/backups; verify service-account access and restore behavior. Audit survives restart and reports storage/retention failures; access to exports and secret administration is separately authorized. |

### Industrial services and broader operations

P2 items follow their dependencies and an identified deployment need. Protocol names are candidates, not support promises. Direct device drivers and an OPC UA server are separate from the implemented OPC UA client.

| ID / priority | Deliverable and dependencies | Completion gate |
| --- | --- | --- |
| G10 / P1 | **Expression tags and reviewed bulk import/export implemented.** Bounded named-input expressions reject cycles, preserve derived quality/source time and enforce result types. Full-graph preview and revision/content checks precede atomic additive import; tag model v2 includes versioned UDT definitions, pinned instances, typed member overrides, named scan groups and the default provider enable/disable lifecycle. Reviewed full-graph edits preserve quality and expose expanded runtime definitions. Arbitrary provider creation and provider plugins remain open. See [tag models](TAG_MODELS.md). Depend on G05/G07 for connection and access semantics. | Preserve type, quality and timestamps through edits, disabled sources and reconnect. Bound evaluation work; reject cycles; version UDT changes; preview bulk changes and diagnose unsupported definitions. |
| G11 / P1 | **Equipment command baseline implemented.** Explicit published resources authorize typed/range-bounded memory and OPC UA scalar writes. Fresh single-use confirmation, current-value/configuration/publication checks, per-target serialization, bounded readback and correlated audit distinguish confirmed, rejected, unconfirmed and uncertain outcomes. No automatic write retry. See [equipment commands](EQUIPMENT_COMMANDS.md). | Test denied/stale commands, disconnect during a write, uncertain outcomes and conflicting operators on a simulator and an identified test device. A UI value change never implies a successful equipment command. |
| G12 / P1 first driver, P2 expansion | **Native device adapters.** Design a driver contract and configuration wizard; begin with a programmable simulator and Modbus TCP. Later evaluate serial Modbus, Allen-Bradley/Logix, Siemens, BACnet, Omron, Mitsubishi, DNP3, IEC 61850 and TCP/UDP integrations against actual requirements. Include addressing, byte/word/string encoding, request limits, retry/concurrency and per-device health. | Each adapter needs documented protocol scope, simulator and real-device evidence, malformed/partial response handling, overload/reconnect checks and load limits. Read support and write support are approved separately. BACnet needs discovery/local-device semantics in addition to generic connection fields. |
| G13 / P2 | **OPC UA server — planned.** Separately scoped endpoint hosting, namespace publication, server certificates, limits and browse/read/write/call permissions; depend on tag/provider and command contracts. | Interoperate with independent clients, enforce permissions per operation, validate certificate/session lifecycle and prove behavior on restart. Client capability does not satisfy this gate. |
| G14 / P1 | **Local history baseline implemented in the review follow-up.** SQLite raw samples preserve quality/timestamps; per-path deadband, maximum sample intervals and retention accompany scoped bounded queries and historical trends. Truncation and storage failures are explicit. Persistent ingestion queues, disk backpressure, retry/quarantine/replay, aggregation and additional providers remain open. | Extend local restart/retention tests to crash/outage recovery, queue saturation, poison records, late/out-of-order ingestion and duplicate handling. History queries must expose gaps/bad quality. |
| G15 / P1 | **Local alarm baseline implemented in the review follow-up.** Numeric high/low/equal evaluation, hysteresis, priorities, quality-aware state, occurrence-bound acknowledgement and SQLite journal/query services back the status/journal controls. Shelving, suppression and notifications remain open. | Activation/clear/ack, stale acknowledgements, bad quality, restart and configuration/storage failure checks cover the baseline. Extend to production-scale outage handling and external notification delivery. |
| G16 / P1 | **Notification and scheduling.** Configured email transports, notification routing/escalation, on-call rosters, schedules/holidays and delivery history; localized message templates and later SMS/voice adapters. Depend on G08/G09 where applicable and G14/G15 for durable delivery. | Use controlled recipients and provider fixtures to test retries, duplicate suppression, escalation cancellation, secret redaction, time zones/DST and holidays. Preview/test delivery is an explicit action; configuration browsing does not send messages. |
| G17 / P1 | **Seven gateway event families implemented.** Startup/update/shutdown, fixed-delay/fixed-rate timers, tag-change, message and time-zone-aware cron jobs use bounded shared/dedicated execution, administrator cancellation, configurable deadlines and persistent diagnostic history. Designer editors and a portable disabled-by-default workshop accompany the APIs. See [gateway events](GATEWAY_EVENTS.md). Atomic application/script publication and rollback are implemented with captured query/library snapshots and old-generation shutdown before new startup. Durable delivery/replay and cross-gateway messaging remain open. | Preserve ordering, non-overlap, old-generation drain and shutdown-before-startup; enforce message audience/permission/revision checks and queue deadlines. Extend acceptance to real service/container stop and platform/load/storage-failure matrices. CPython APIs are independently defined; diagnostic history is not a durable job queue. |
| G18 / P2 | **Reports, data-transfer jobs, event processing and sequences — planned as separate services.** Reports need dataset/layout/rendering and scheduled distribution. Transaction jobs need trigger, handshake and database/device consistency rules. Event streams need routing, backpressure and replay. Sequence execution needs persisted state, pause/resume, abort and execution history. Depend on G06/G11/G14/G16/G17 as applicable. | Each service proves its own restart, duplicate, failure and authorization behavior. A scheduled Python script is not evidence of a report engine, transactional bridge, durable stream or resumable sequence. |
| G19 / P2 | **Fleet and redundancy.** Authenticated gateway links, peer/service inventory, transport queues, routing policies, central backup/update tasks and compatibility negotiation; then active/standby replication, failover and fencing. Depend on G03/G04/G07/G09/G14. | Use multiple isolated gateways to test partitions, certificate rotation, failed upgrades, queue saturation, resynchronization and split-brain prevention. Prove that failover cannot duplicate equipment commands or scheduled work. |
| G20 / P2 | **Distribution, extensions and operator presentation.** Supported package inventory, dependency/version diagnostics, signed updates and offline installation; evaluate an extension contract, reusable application catalog, customer branding and optional kiosk packaging. Licensing/entitlement behavior requires a product decision. | Validate package provenance/compatibility, failed-install rollback and asset availability offline. Preserve the browser Designer/operator path. Desktop launchers, Java modules, third-party project import and a marketplace are not prerequisites or implied compatibility commitments. |

### Delivery rules

- Build the smallest useful backend and administration UI together. Configuration validation, optimistic revisions, safe secret handling, dependency checks, audit and failure states are part of each increment.
- Use diagnostics from G02 in every connection, job and service increment. Status needs an observation time and an explicit unknown/stale state; aggregate counts link to the failing resource.
- Keep operational metrics, security audit, script execution history, process history and alarm journals as distinct records with their own retention and access rules.
- Record automated contract checks and observed browser flows separately. Test populated, empty, denied, disconnected and recovery cases; a navigation review alone cannot promote a feature to Implemented.
- Promote P0 only after a fresh supported deployment passes backup/restore, service lifecycle, HTTPS, identity, real database and OPC recovery acceptance. Retain the existing limits on public-installer and container claims until those artifacts are refreshed.

## Component-family delivery track

The 41 current source types are a partial application toolkit. The full intended palette is tracked in [Component coverage](COMPONENTS.md#full-component-family-roadmap), including inputs/forms, command buttons, process indicators, tables/trees/navigation, layout/embedding, drawing/symbols, supplied-data charts, historical trends, alarms, calendar/scheduling, documents/media and maps. This track is broader than charts and dashboards; it includes editing, events, local state, validation and database-backed application workflows.

The latest table slice adds typed multiple row selection and atomic database batches alongside inline cell edits through published Python handlers, configurable columns, loaded-result paging and filtering. Formatted/barcode inputs and embedded/tab/split/dock containers are implemented. Drawing/symbols, typed browser state and bounded nested forms are implemented; supplied-data charts provide ten configured modes plus a compact sparkline, with shared static/query datasets, quality gaps and local range selection. Equipment command controls use the separately authorized gateway command contract. The preceding palette slices added List, Tree view, process displays, Password input, Multi-state button and Multi-state indicator; their contracts remain in the component guide. Password input is not an authentication system. State selectors change local form values, and read-only indicators do not provide equipment commands or alarm evaluation.

Every remaining family has an explicit Planned or Partial status in that ledger. Everyday inputs, process displays, drawing, calendar presentation and charts over supplied datasets can advance independently of history storage. Historical charts require a historian; alarm tables require state/journal services; report controls require a rendering engine; equipment commands require permission, acknowledgment and audit contracts. Air-gapped media, maps and browser assets must be packaged locally. Future family coverage is a development plan, not a claim about the current installer.

## Milestones and acceptance gates

1. **Complete the connected pilot boundary.** Validate the implemented local identity/project-permission/audit system in its target deployment; validate SQL Server and test certificate lifecycle, service hosting, credentials, restart/recovery and supported workloads before network deployment.
2. **Broaden application acceptance.** Extend the passed SQLite and scripting workflows to supported browsers/platforms, concurrent operators and failure/recovery scenarios. Extend atomic screen/query/library release acceptance to supported service and container deployments. Preserve direct fixed-canvas editing and the existing form/template/popup scopes.
3. **Expand application logic and reusable data views.** Build on the property sheet, typed properties, browser input events and persistent groups with richer typed state, generic property-change contracts, richer table/selection behavior and dynamic row sources; then package organization, tag-change/message/shutdown handlers and calendar scheduling. Define cancellation, ordering, restart and permissions before presenting these as equivalent event APIs. Continue everyday controls and process indicators alongside their required behavior.
4. **Broaden tag engineering.** Extend implemented expression/UDT semantics and validated import/export to additional providers and operating workloads. Diagnose unsupported resources explicitly; do not silently approximate imported behavior.
5. **Deliver subsystem-backed features.** Historian and alarms precede historical/alarm components; reporting and transaction engines precede their dependent UI.
6. **Harden distribution and operations.** Validate real service install/upgrade/uninstall, data recovery and offline target operation; add signing, reproducible dependency inventories, offline Python packages and update/rollback procedures.

For each promotion, record the environment, setup, action, observed result and retained evidence. Simulator output, compiled code or a package recipe alone is insufficient. Performance numbers require a measured workload. Component appearance, event behavior, device writes and file compatibility are separate acceptance dimensions.
