# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
# Build tools execute on the builder architecture. Only the runtime/Python stages
# execute on each target architecture, avoiding an emulated .NET SDK build.
FROM --platform=$BUILDPLATFORM node:22.17.1-bookworm-slim@sha256:2fa754a9ba4d7adbd2a51d182eaabbe355c82b673624035a38c0d42b08724854 AS web
ARG VERSION=0.2.0-preview.13
WORKDIR /web
COPY apps/web/package*.json ./
RUN node -e "if(require('./package.json').version!==process.argv[1])process.exit(1)" "$VERSION" && npm ci --no-audit --no-fund
COPY apps/web/ ./

FROM python:3.14.7-slim-bookworm@sha256:82bc3c539b8813ada9d68c63b40158fa002f7f33de9bf3312a3dfdc0620dff56 AS python
# Strip installers before copying the interpreter snapshot. Removing them in a
# later runtime layer would still distribute their original lower-layer bytes.
RUN rm -rf /usr/local/lib/python3.14/site-packages /usr/local/lib/python3.14/ensurepip \
    /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.14

# Gate tools execute on BUILDPLATFORM; the separately stripped Python above ships
# on TARGETPLATFORM. An ARM64 payload never supplies an interpreter to an x64 builder.
FROM --platform=$BUILDPLATFORM python:3.14.7-slim-bookworm@sha256:82bc3c539b8813ada9d68c63b40158fa002f7f33de9bf3312a3dfdc0620dff56 AS python-tools

FROM --platform=$BUILDPLATFORM mcr.microsoft.com/dotnet/sdk:10.0.401-noble@sha256:35d40304542c8689331f8cab17c65926cdf48fe711e289321d71924b230a7d29 AS build
ARG TARGETARCH
ARG SOURCE_REVISION
ARG VERSION=0.2.0-preview.13
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 SPARKSTUDIO_PYTHON=/usr/local/bin/python3
WORKDIR /source
# Run quality checks on the builder architecture with the exact pinned tools.
# Authored offline fixtures and policy files are allowed by .dockerignore;
# development data, caches and generated artifacts never enter this context.
COPY --from=web /usr/local/bin/node /usr/local/bin/node
COPY --from=web /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
COPY --from=python-tools /usr/local/ /usr/local/
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && apt-get update && apt-get install -y --no-install-recommends \
       git libbz2-1.0 libexpat1 libffi8 liblzma5 libncursesw6 libreadline8t64 libsqlite3-0 libssl3t64 zlib1g \
    && rm -rf /var/lib/apt/lists/* \
    && /usr/local/bin/python3 -I -c "import sys, sqlite3, ssl, bz2, lzma, ctypes; assert sys.version_info[:3] == (3, 14, 7)"
COPY global.json Directory.Build.props Directory.Build.targets .editorconfig NuGet.Config ./
COPY src/ ./src/
COPY . ./
COPY --from=web /web/ ./apps/web/
RUN npm run build --prefix apps/web
RUN mkdir -p src/SparkStudio.Gateway/wwwroot && cp -a apps/web/dist/. src/SparkStudio.Gateway/wwwroot/
RUN case "$TARGETARCH" in amd64) rid=linux-x64 ;; arm64) rid=linux-arm64 ;; *) echo "Only amd64 and arm64 are supported" >&2; exit 1 ;; esac \
    && dotnet restore src/SparkStudio.Gateway --runtime "$rid" --locked-mode --configfile NuGet.Config \
       /p:RestorePackagesWithLockFile=true /p:NuGetLockFilePath="packages.$rid.lock.json" /p:SelfContained=false
RUN case "$TARGETARCH" in amd64) rid=linux-x64 ;; arm64) rid=linux-arm64 ;; *) exit 1 ;; esac \
    && printf '%s' "$SOURCE_REVISION" | grep -Eq '^[0-9a-f]{40}$' \
    && grep -Fq "<Version>$VERSION</Version>" src/SparkStudio.Gateway/SparkStudio.Gateway.csproj \
    && dotnet publish src/SparkStudio.Gateway -c Release --runtime "$rid" --no-restore --self-contained false \
       -o /out /p:UseAppHost=false /p:SourceRevisionId="$SOURCE_REVISION" /p:InformationalVersion="$VERSION+$SOURCE_REVISION"

FROM mcr.microsoft.com/dotnet/aspnet:10.0.12-noble@sha256:2d584d8147faddb0d678c5748d47953e5b8e18621ed4fb7049a91381d9d7746f AS runtime-prep
USER root
# Bookworm's older glibc ABI runs on Noble. The worker uses the standard library;
# development package installers are removed from the shipped interpreter.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libbz2-1.0 libexpat1 libffi8 liblzma5 libncursesw6 libreadline8t64 libsqlite3-0 libssl3t64 zlib1g openssl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=python /usr/local/ /usr/local/
RUN ldconfig \
    && /usr/local/bin/python3 -I -c "import sys, sqlite3, ssl, bz2, lzma, ctypes, urllib.request; assert sys.version_info[:3] == (3, 14, 7)"
COPY tools/collect-docker-runtime.py /tmp/collect-docker-runtime.py
RUN /usr/local/bin/python3 -I /tmp/collect-docker-runtime.py /base-notices && rm /tmp/collect-docker-runtime.py

FROM web AS notices
ARG TARGETARCH
ARG SOURCE_REVISION
ARG VERSION=0.2.0-preview.13
ARG CONTAINER_EDITION=0.2.0-preview.13-docker.1
COPY --from=build /out /out
COPY --from=build /root/.nuget/packages /nuget
COPY --from=runtime-prep /base-notices /base-notices
COPY LICENSE /out/SparkStudio-LICENSE.txt
COPY tools/write-docker-notices.mjs tools/package-notice-supplements.mjs /tools/
RUN node /tools/write-docker-notices.mjs --payload /out --web /web --nuget /nuget --runtime /base-notices \
    --source-commit "$SOURCE_REVISION" --architecture "$TARGETARCH" --container-edition "$CONTAINER_EDITION" --version "$VERSION" \
    --runtime-image mcr.microsoft.com/dotnet/aspnet:10.0.12-noble@sha256:2d584d8147faddb0d678c5748d47953e5b8e18621ed4fb7049a91381d9d7746f \
    --python-image python:3.14.7-slim-bookworm@sha256:82bc3c539b8813ada9d68c63b40158fa002f7f33de9bf3312a3dfdc0620dff56 \
    --sdk-image mcr.microsoft.com/dotnet/sdk:10.0.401-noble@sha256:35d40304542c8689331f8cab17c65926cdf48fe711e289321d71924b230a7d29 \
    --node-image node:22.17.1-bookworm-slim@sha256:2fa754a9ba4d7adbd2a51d182eaabbe355c82b673624035a38c0d42b08724854

FROM runtime-prep AS runtime
ARG SOURCE_REVISION
ARG VERSION=0.2.0-preview.13
ARG CONTAINER_EDITION=0.2.0-preview.13-docker.1
LABEL org.opencontainers.image.title="sparkstudio" \
      org.opencontainers.image.description="Industrial software. Built your way." \
      org.opencontainers.image.source="https://github.com/SparkStudioX/src" \
      org.opencontainers.image.url="https://sparkstudiox.com" \
      org.opencontainers.image.version="$CONTAINER_EDITION" \
      org.opencontainers.image.revision="$SOURCE_REVISION" \
      org.opencontainers.image.licenses="LicenseRef-SparkStudio-Proprietary"
WORKDIR /app
COPY --from=notices /out ./
COPY LICENSE ./SparkStudio-LICENSE.txt
COPY tools/docker-entrypoint.py /usr/local/bin/sparkstudio-entrypoint
COPY tools/container-admin.py /usr/local/bin/sparkstudio-admin
RUN /usr/local/bin/python3 -I -c "from pathlib import Path; [p.write_bytes(p.read_bytes().replace(b'\r\n',b'\n')) for p in map(Path, ['/usr/local/bin/sparkstudio-entrypoint','/usr/local/bin/sparkstudio-admin'])]" \
    && chmod 755 /usr/local/bin/sparkstudio-entrypoint /usr/local/bin/sparkstudio-admin \
    && mkdir /data && chown app:app /data && chmod 700 /data \
    && rm -rf /base-notices
ENV SPARKSTUDIO_DATA_DIR=/data SPARKSTUDIO_PYTHON=/usr/local/bin/python3 \
    PYTHONDONTWRITEBYTECODE=1 DOTNET_CLI_TELEMETRY_OPTOUT=1
USER app
EXPOSE 8090 8443
HEALTHCHECK --interval=30s --timeout=12s --start-period=30s --retries=3 CMD ["sparkstudio-admin", "health"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["sparkstudio-entrypoint"]
CMD ["dotnet", "SparkStudio.Gateway.dll"]
