FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY apps/web/package*.json ./
RUN npm ci --no-audit --no-fund
COPY apps/web/ ./
RUN npm run build

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /source
COPY global.json Directory.Build.props NuGet.Config ./
COPY src/ ./src/
COPY runtimes/python/worker.py ./runtimes/python/worker.py
RUN dotnet restore src/SparkStudio.Gateway --locked-mode --configfile NuGet.Config
COPY --from=web /web/dist ./src/SparkStudio.Gateway/wwwroot
RUN dotnet publish src/SparkStudio.Gateway -c Release --no-restore --no-self-contained -o /out /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out ./
RUN mkdir /data && chown app:app /data
ENV URLS=http://0.0.0.0:8080 SPARKSTUDIO_DATA_DIR=/data SPARKSTUDIO_PYTHON=/usr/bin/python3
USER app
EXPOSE 8080
ENTRYPOINT ["dotnet", "SparkStudio.Gateway.dll"]
