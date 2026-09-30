FROM node:22.17.1-bookworm-slim AS web
WORKDIR /web
COPY apps/web/package*.json ./
RUN npm ci --no-audit --no-fund
COPY apps/web/ ./
RUN npm run build

FROM mcr.microsoft.com/dotnet/sdk:10.0.401 AS build
WORKDIR /source
COPY global.json Directory.Build.props NuGet.Config ./
COPY src/ ./src/
COPY runtimes/python/worker.py ./runtimes/python/worker.py
RUN dotnet restore src/SparkStudio.Gateway --locked-mode --configfile NuGet.Config
COPY --from=web /web/dist ./src/SparkStudio.Gateway/wwwroot
RUN dotnet publish src/SparkStudio.Gateway -c Release --no-restore --no-self-contained -o /out /p:UseAppHost=false

FROM python:3.14.7-slim-bookworm AS python

FROM mcr.microsoft.com/dotnet/aspnet:10.0.9-noble AS runtime
USER root
# Match the Windows worker's CPython release. Bookworm's older glibc ABI runs on
# Noble; validate the native extension dependencies below during every build.
RUN apt-get update && apt-get install -y --no-install-recommends libbz2-1.0 libexpat1 libffi8 liblzma5 libncursesw6 libreadline8t64 libsqlite3-0 libssl3t64 zlib1g && rm -rf /var/lib/apt/lists/*
COPY --from=python /usr/local/ /usr/local/
RUN ldconfig && /usr/local/bin/python3 -I -c "import sys, sqlite3, ssl, bz2, lzma, ctypes; assert sys.version_info[:3] == (3, 14, 7)"
WORKDIR /app
COPY --from=build /out ./
COPY LICENSE ./SparkStudio-LICENSE.txt
RUN mkdir /data && chown app:app /data
ENV URLS=http://0.0.0.0:8080 SPARKSTUDIO_DATA_DIR=/data SPARKSTUDIO_PYTHON=/usr/local/bin/python3
USER app
EXPOSE 8080
ENTRYPOINT ["dotnet", "SparkStudio.Gateway.dll"]
