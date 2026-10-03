# Docker deployment

The Docker preview packages SparkStudio for **Linux x86-64 (`amd64`) and ARM64 (`arm64`)**. Docker Desktop on Windows must use Linux containers. The image includes the gateway, browser assets, .NET 10.0.12 and Python 3.14.7; no host Python or .NET installation is required.

This guide targets `ladder99/sparkstudio:0.2.0-preview.13-docker.1`, using product version `0.2.0-preview.13`, built from [`8019931a2b4d9a7da6cbdfe136e4ea5f1cd21c22`](https://github.com/SparkStudioX/src/commit/8019931a2b4d9a7da6cbdfe136e4ea5f1cd21c22). Its source revision and per-platform manifests are recorded inside the image. Check the [verification ledger](PARITY.md) for exact-image acceptance and remaining limits. The [public Docker image](https://hub.docker.com/r/ladder99/sparkstudio/tags?name=0.2.0-preview.13-docker.1) and `preview` alias resolve to the verified registry index `sha256:206fe5ef68f1f80501c63e81fa64b5d32d554071a0d2bad34e21338f7ddd9221`. Both architectures passed exact-image deployment checks described below. Companion-asset and website verification are recorded in the release notes. This Docker edition keeps the independently published Windows preview.13 installer and workshop assets unchanged. The `preview` alias follows the published Docker preview; use the explicit edition or verified registry digest for repeatable deployment. No stable or `latest` tag is advertised.

The edition adds the preview.13 engineering features, including [Ask Spark](ASK_SPARK.md), tabbed connection editors, Layers-pane multiple selection and [read-only MQTT, MTConnect and i3X sources](DATA_SOURCES.md). The completed image checks do not establish live provider, source-server, physical-controller or other deployment-environment acceptance. See the source guides and the platform limitations below before configuring a gateway.

Both architectures passed **8 deployment groups and all 37 frozen workshop import, publication and binary-export round trips**, first against the local image and again against the public immutable registry digest. Checks covered isolated non-root startup, certificate-validated HTTPS, fixed-origin redirects, secure cookies/CSRF, administrator bootstrap, SQLite, memory tags, ordinary Python gateway actions, a separately authenticated published operator session and captured Python button action, AI/source configuration, and same-edition restart persistence. AI checks made no Gemini requests; source checks used configuration, scalar preview and expected source-worker rejection without real source servers. ARM64 ran under Docker Desktop emulation on x86-64. The tests used loopback ports 18090/18443 and removed their owned Compose projects and volumes.

## Start the gateway

Download the [compose.yaml pinned to this image build](https://github.com/SparkStudioX/src/blob/8019931a2b4d9a7da6cbdfe136e4ea5f1cd21c22/compose.yaml) into an empty deployment folder. Run these commands from that folder:

```sh
docker compose pull
docker compose up -d --wait
docker compose exec gateway sparkstudio-admin setup
```

The last command asks for a username, password and confirmation in the terminal, with hidden password input. There are no default credentials. It reads the one-time setup code inside the data volume and uses the gateway's existing setup API over its private loopback listener. Initial setup cannot be performed remotely through the published ports; `setup` cannot reset or replace existing accounts. After setup, sign in at **https://localhost:8443**. The generated self-signed certificate requires deliberate client trust as described below.

| Listener | Compose default | Purpose |
| --- | --- | --- |
| HTTP | `127.0.0.1:8090` → container `8090` | GET/HEAD redirects to the configured HTTPS address; unsafe HTTP requests are rejected |
| HTTPS | `127.0.0.1:8443` → container `8443` | Designer, operator applications and authenticated gateway settings |
| Management | Container loopback `127.0.0.1:5090` only | Initial setup and health checks; never published |

These host ports allow the Windows gateway on 5090 to continue running. Docker uses a separate `SparkStudioDocker` cookie namespace, so its logins do not overwrite Windows gateway cookies on the same hostname. Separate containers on the same hostname should each use a distinct `SPARKSTUDIO_COOKIE_NAMESPACE` value.

Container HTTPS responses on `localhost` and loopback IP hosts omit HSTS, whose browser policy applies across ports. This prevents the container from forcing a parallel Windows HTTP gateway onto an unsupported HTTPS port. Public hostnames retain HSTS, and container access still requires real TLS and Secure cookies.

Compose defaults to host loopback access. It runs as the nonroot `app` user (UID 1654), drops Linux capabilities, sets `no-new-privileges`, makes the root filesystem read-only, and provides a temporary `/tmp` plus a persistent named data volume. The health check requires both gateway readiness and its Python worker. Graceful shutdown has a 45-second allowance.

## HTTPS certificates

On first startup, the container generates a self-signed certificate valid for one year for `localhost`, `127.0.0.1` and `::1`. The certificate and private key persist under `/data/certificates/container/`; restarts retain the same identity. Startup validates validity dates, matching keys and configured certificate names. It refuses an incomplete, expired or mismatched pair instead of silently replacing it. Hostname validation uses certificate SANs; an arbitrary Common Name is insufficient.

Export only the public certificate:

```sh
docker compose cp gateway:/data/certificates/container/server.crt ./sparkstudio-container.crt
```

Compare its fingerprint with the certificate shown by the gateway, then trust the public certificate on the intended operator computer using your organization's certificate procedure. The container does not change Windows, browser or operating-system trust stores. For an isolated command-line check, `curl --cacert sparkstudio-container.crt https://localhost:8443/api/auth/session?audience=engineering` validates the certificate without changing system trust. Do not distribute `server.key`.

To supply an existing PEM certificate chain and matching unencrypted private key, add read-only mounts accessible to UID 1654 and set both paths:

```yaml
services:
  gateway:
    environment:
      SPARKSTUDIO_TLS_CERTIFICATE: /run/tls/server.crt
      SPARKSTUDIO_TLS_KEY: /run/tls/server.key
      SPARKSTUDIO_PUBLIC_HOST: gateway.example.internal
      SPARKSTUDIO_TLS_NAMES: gateway.example.internal
    volumes:
      - ./tls:/run/tls:ro
```

Include intermediates after the leaf certificate. This override belongs beside the downloaded Compose file as `compose.override.yaml`; retain its named `/data` volume. Certificate files remain deployment data and must not be committed into the application repository.

## Network access and port overrides

For LAN access, configure the deployment's `.env` before first startup, for example:

```dotenv
SPARKSTUDIO_BIND_ADDRESS=0.0.0.0
SPARKSTUDIO_PUBLIC_HOST=192.168.1.50
SPARKSTUDIO_TLS_NAMES=192.168.1.50
SPARKSTUDIO_HTTP_PORT=8090
SPARKSTUDIO_HTTPS_PORT=8443
SPARKSTUDIO_COOKIE_NAMESPACE=SparkStudioDocker
```

Use the gateway computer's real fixed address or DNS hostname, never `0.0.0.0` as a certificate identity. A specific IP works without DNS when it is an exact IP SAN in the certificate. Configure host firewall access for the intended network. Operator clients must trust the issuing CA or the exported self-signed public certificate.

The internal ports stay 8090/8443; the port variables select host mappings and the public redirect destination. For another parallel gateway, change both host ports and its cookie namespace. `SPARKSTUDIO_PUBLIC_HOST` must be included in `SPARKSTUDIO_TLS_NAMES`. If the identity changes after the certificate is generated, supply a valid replacement pair or perform a deliberate certificate rotation while stopped. Changing environment variables alone cannot make an existing certificate valid for a new address.

HTTP redirects use the explicitly configured HTTPS origin, not a client-controlled Host or forwarded header. Authentication continues to require actual HTTPS or actual loopback. A reverse proxy is not automatically trusted to assert transport security; direct TLS is the tested configuration. Automatic ACME issuance/renewal and proxy-specific deployment acceptance are not included.

## Data, backup and upgrades

Gateway configuration, accounts, projects, tags, SQLite databases, history, certificates and encryption keys live in the **`sparkstudio-data` named volume** at `/data`. On Linux, secret protection uses keys in that private volume rather than Windows DPAPI. Treat a full-volume copy as sensitive gateway data and restrict who can inspect the Docker engine or its volumes.

Use **Gateway Settings → Backups** for encrypted configuration downloads and named schedules. The [backup guide](SCHEDULED_BACKUPS.md) defines what configuration backups include; they do not contain SQLite database contents or all historian data. For complete recovery, stop the gateway and take a consistent backup of the entire data volume, including keys, certificates and databases. Follow the [offline recovery guide](GATEWAY_RECOVERY.md) for the scope and restore constraints. Windows service-account/DPAPI commands in that guide do not apply to Linux. Actual remote SMB, trusted FTPS and S3 account-policy acceptance remain separate integration gates; container publication does not certify those destinations.

`docker compose down` removes the container/network and retains the volume. `docker compose down --volumes` deletes gateway data. To upgrade, back up the volume, review the new edition's notes, update the image pin, then:

```sh
docker compose pull
docker compose up -d --wait
```

For an offline recovery CLI invocation, stop the running gateway and explicitly bypass normal TLS initialization: `docker compose run --rm --no-deps --entrypoint dotnet gateway SparkStudio.Gateway.dll <recovery-arguments>`. Use the reviewed recovery arguments and an appropriate stopped-data or empty restore mount from the recovery guide. The ordinary startup entrypoint generates certificate files in an empty volume, so it is unsuitable for preparing an empty full-restore target.

Do not run two gateways against one volume. Avoid downgrading changed data without a compatible pre-upgrade backup. The deployment verifier checks restarting the same edition with retained data; consult the ledger for completed per-platform results. This does not establish cross-version data migration or automatic rollback.

Import the [preview.13 workshop collection](https://github.com/SparkStudioX/releases/releases/tag/v0.2.0-preview.13) through Projects. Its 37 portable `.sparkproj` files remain unpublished on import; review and publish in Designer. Ask Spark and read-only sources are setup-required exercises with their own prerequisites. Gateway tags, connections and external services still require their own configuration. The container's `localhost` means the container itself: when connecting to a server on the Docker Desktop host, use its documented host address, commonly `host.docker.internal`, and configure the server's permissions, firewall and OPC trust accordingly. An i3X service reached through that hostname requires HTTPS; the loopback HTTP exception does not apply to a host outside the container.

## Ask Spark in a container

Configure Gemini under **Gateway Settings → AI**. The gateway container needs outbound HTTPS access to the selected Gemini service, and the configured account must support the selected model. Browser voice capture needs microphone permission and a trusted secure origin; a certificate warning is not proof that browser microphone APIs will be available.

The defaults remain 100 model steps per message, four parallel reads and an unlimited monthly token allowance until configured. Raw provider logging is enabled by default and writes timestamped plaintext exchange files under `/data/askspark/`. Unix permissions restrict the directory to `0700` and files to `0600`; Docker-engine administrators can still access the volume. These files have no automatic deletion or logging size cap. Configure the allowance, disable new logging when unwanted and manage retained files deliberately. See [Ask Spark](ASK_SPARK.md) for approvals, data handling and the limits of canvas and operator verification.

## Source expressions in the default container

The default Compose profile supports MQTT **UTF-8 scalar** mappings with receipt timestamps and arrival ordering, without payload or timestamp/sequence/epoch expressions. Scripted JSON/XML extraction and these expressions require the separately contained source worker. On Linux that worker requires an actual writable, delegated **cgroup v2 memory controller** under `/sys/fs/cgroup`, selected through `SPARKSTUDIO_SOURCE_CGROUP_ROOT`.

The shipped non-root, read-only Compose profile does not provide that delegation. Worker-dependent mappings fail closed; enabling even one such mapping can prevent its MQTT connection from starting because the worker is prepared at connection startup. Disable those mappings or use scalar payloads with no expressions in the default deployment. A separate delegated-cgroup deployment needs its own qualification; changing the container to privileged or removing isolation is not a supported workaround.

This restriction concerns source payload/order expressions. MTConnect, i3X, ordinary gateway Python actions and Ask Spark use separate execution paths. It does not disable those features. Physical controllers and real broker/agent interoperability still require their own acceptance.

## Build and verify a container edition

Release images must come from a clean, reviewed source commit. Four base-image indexes are pinned by digest in the Dockerfile, and each target uses its own locked Linux NuGet graph. Browser/build tools execute on the builder architecture; Python/runtime stages execute on the target. The `.dockerignore` uses an allowlist to exclude local data, build artifacts, private reference material and certificates.

```sh
docker buildx build --platform linux/amd64,linux/arm64 --load \
  --build-arg SOURCE_REVISION=<full-reviewed-source-sha> \
  --build-arg VERSION=0.2.0-preview.13 \
  --build-arg CONTAINER_EDITION=0.2.0-preview.13-docker.1 \
  -t ladder99/sparkstudio:0.2.0-preview.13-docker.1 .
node tools/test-docker-deployment.mjs ladder99/sparkstudio:0.2.0-preview.13-docker.1 linux/amd64 --http-port 18090 --https-port 18443
node tools/test-docker-deployment.mjs ladder99/sparkstudio:0.2.0-preview.13-docker.1 linux/arm64 --http-port 18090 --https-port 18443
```

Local loading of multiple architectures requires Docker's containerd image store; Docker Desktop used for earlier acceptance supports it. The deployment verifier creates and removes its own Compose project and volume, validates TLS against the exported public certificate, creates disposable accounts through the local CLI, and checks SQLite, Python, memory tags, portable workshops, publication, export, graceful shutdown and retained data. The commands above explicitly use loopback 18090/18443, leaving normal Compose deployments on 8090/8443 untouched. For release verification, pass the already verified `artifacts/workshops/0.2.0-preview.13/SparkStudio-Workshops-0.2.0-preview.13.zip` as the positional argument after the platform. Its adjacent manifest and checksums are required; it is the unchanged Windows preview.13 workshop bundle. The default loose-package folder remains ignored `artifacts/sparkproj/` for local authoring checks. Use `--expected-source-commit` with the full image-build SHA when verifying an existing image from a later documentation or verifier checkout. The verifier never stops another application to free ports.

Every platform includes `/app/container-manifest.json`, `/app/sbom.cdx.json`, SparkStudio's proprietary license and `/app/THIRD-PARTY-NOTICES/`. The manifest hashes the application payload and identifies the source revision, edition, target architecture and base-image digests. Inventories retain the actual NuGet/browser package licenses, Linux package copyrights/common licenses, .NET notices and CPython license. SparkStudio's license does not replace third-party licenses. Packaging fails when required reviewed license evidence is absent or changes.

## Dependency sources

Publication of this edition requires `SparkStudio-Corresponding-Sources-0.2.0-preview.13-docker.1.tar.gz` and a separately hashed `SparkStudio-Source-Manifest-0.2.0-preview.13-docker.1.json` in the [Docker edition release](https://github.com/SparkStudioX/releases/releases/tag/v0.2.0-preview.13-docker.1). Construct the bundle from the exact original Ubuntu source packages, their `.dsc` files and upstream/Ubuntu patch archives, plus CPython 3.14.7 sources. Its scope must include packages in both final platform filesystems and retained ancestor layers of the pinned runtime. The local source audit reconciled 73 Ubuntu source versions (72 in current final inventories and one retained ancestor-only OpenSSL version), CPython 3.14.7, 236 original files and 244 archive members. It verified original checksums and safe ordinary-file membership without extracting the original archives. Companion-asset availability and download verification are recorded in the release notes.

The manifest records official source URLs, package/version pairs, file sizes and SHA-256 values. Ubuntu archive files are checked against their original `.dsc` checksums; CPython is checked against its official release checksum. The included README describes source extraction and build recipes. Keep a package's `.dsc`, original archive and patch archive together, then use `dpkg-source -x <package>.dsc` in a separate build environment. No downloaded dependency source is committed to SparkStudio's application repository, and the source bundle contains no gateway data or inspection-only container layer archives.

The verified local source archive is 381,467,430 bytes with SHA-256 `adcb56161b1cc0af06968819527a1a3435b887da5392d2e8f60781482b9a9d0b`. The separate source manifest has SHA-256 `820217c9103f53a6095a27ac70051d267533e83fdf43f5b79a4cc123e9325aa8`. These identities must match the public downloads before the edition is announced.

The original licenses/notices and their corresponding source availability remain part of distribution. An SBOM alone does not substitute for them. SparkStudio application source and its license remain separately identified in the source repository and image.

After source CI and both platform deployments pass, publish the exact verified image, verify the public manifest's `amd64`/`arm64` platforms and digest, and repeat deployment against that digest. Then update the independent Docker metadata/card and hosted guide in the website, require successful Pages deployment, and verify the live links. Keep the Windows installer download and its published bytes unchanged for a Docker-only edition. Record the source revision, registry digest, test environment and remaining gates in [the verification ledger](PARITY.md). ARM64 acceptance on an x86-64 laptop uses emulation; physical ARM hardware acceptance remains unverified.
