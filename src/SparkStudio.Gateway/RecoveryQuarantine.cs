using System.Net;
using System.Security.Cryptography;
using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

/// <summary>A restored gateway stays isolated for the entire process, including after approval.</summary>
public sealed class RecoveryQuarantine
{
    private const int MaximumMarkerBytes = 65536;
    public const string MarkerName = "recovery-quarantine.json";
    public const string BlockedMessage = "Gateway recovery mode blocks connections and Python scripts. Review Recovery in Gateway Settings, approve resuming, then restart the gateway.";
    private readonly object gate = new();
    private readonly string marker;
    private readonly string dataDirectory;
    private readonly string? revision;
    private readonly JsonObject? receipt;
    private readonly bool invalid;
    private bool approved;
    public bool Active { get; }

    public RecoveryQuarantine(string directory)
    {
        dataDirectory = Path.GetFullPath(directory);
        marker = Path.Combine(dataDirectory, MarkerName);
        try { _ = File.GetAttributes(marker); Active = true; }
        catch (Exception error) when (error is FileNotFoundException or DirectoryNotFoundException) { return; }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { Active = true; invalid = true; return; }
        try
        {
            var info = new FileInfo(marker);
            if ((info.Attributes & FileAttributes.ReparsePoint) != 0 || info.Length > MaximumMarkerBytes)
                throw new InvalidOperationException();
            var bytes = File.ReadAllBytes(marker);
            revision = Convert.ToHexString(SHA256.HashData(bytes));
            receipt = JsonNode.Parse(bytes)?.AsObject();
            invalid = receipt?["schemaVersion"]?.GetValue<int>() != 1
                || receipt?["state"]?.GetValue<string>() != "quarantined"
                || !Guid.TryParse(receipt?["archiveId"]?.GetValue<string>(), out _)
                || receipt?["scope"]?.GetValue<string>() is { } scope && scope is not ("full" or "configuration");
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.Text.Json.JsonException or InvalidOperationException or FormatException)
        { invalid = true; }
    }

    public void EnsureOperationsAllowed()
    {
        if (Active) throw new InvalidOperationException(BlockedMessage);
    }

    public object Snapshot()
    {
        lock (gate) return new
        {
            active = Active, restartRequired = approved, invalidMarker = invalid, revision,
            dataDirectory,
            restoredAtUtc = invalid ? null : receipt?["restoredAtUtc"]?.DeepClone(),
            archiveId = invalid ? null : receipt?["archiveId"]?.DeepClone(),
            sourceVersion = invalid ? null : receipt?["sourceVersion"]?.DeepClone(),
            fileCount = invalid ? null : receipt?["fileCount"]?.DeepClone(),
            totalBytes = invalid ? null : receipt?["totalBytes"]?.DeepClone(),
            scope = invalid ? null : receipt?["scope"]?.GetValue<string>() ?? "full",
            excludedPaths = invalid || receipt?["excludedPaths"] is not System.Text.Json.Nodes.JsonArray excluded ? new JsonArray() : excluded.DeepClone(),
            excludedPathCount = invalid ? null : receipt?["excludedPathCount"]?.DeepClone(),
            coverage = !invalid && receipt?["scope"]?.GetValue<string>() == "configuration" ? GatewayBackups.Coverage : "Complete offline data-directory snapshot: projects, publications, local databases, accounts, grants, connections, tags, assets, keyring and certificates. Temporary backup work/cache is excluded. External databases need their own backup.",
            portability = "Windows-protected connection secrets retain their original machine and Windows account binding. Reenter credentials when moving to another machine or service account.",
            backupMode = "Stop the gateway and its Python workers before backup. The data-directory lease prevents concurrent access by this gateway version; older versions and third-party writers must be stopped separately."
        };
    }

    public object ApproveForRestart(RecoveryApproval request)
    {
        lock (gate)
        {
            if (!Active || approved) throw new InvalidOperationException("No recovery approval is pending.");
            if (invalid) throw new InvalidOperationException("The recovery marker is invalid. Inspect this restore offline before resuming.");
            if (request.Confirmation != "RESUME RESTORED GATEWAY" || !request.ReviewedConnections || !request.ReviewedScripts || !request.ReviewedIdentityAndDeployment)
                throw new ArgumentException("Review connections, scripts, account/key portability and deployment, then enter RESUME RESTORED GATEWAY.");
            if (request.Revision != revision || !File.Exists(marker)
                || (File.GetAttributes(marker) & FileAttributes.ReparsePoint) != 0
                || new FileInfo(marker).Length > MaximumMarkerBytes
                || Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(marker))) != revision)
                throw new InvalidOperationException("Recovery state changed. Refresh and review it again.");
            // The original receipt is retained. No work is enabled in this process; restart
            // is the explicit boundary at which the absence of the marker takes effect.
            File.Move(marker, Path.Combine(dataDirectory, $"recovery-reviewed-{Guid.NewGuid():N}.json"), false);
            approved = true;
            return Snapshot();
        }
    }

    public void ConfigureIsolation(WebApplicationBuilder builder)
    {
        if (!Active) return;
        // A restored DNS-only Host policy must not make local recovery inaccessible.
        builder.Configuration["AllowedHosts"] = "localhost;127.0.0.1;[::1]";
        var value = builder.Configuration["RecoveryPort"] ?? builder.Configuration["InstallerManagementPort"] ?? "5090";
        if (!int.TryParse(value, out var port) || port is < 1024 or > 65535)
            throw new InvalidOperationException("RecoveryPort must be between 1024 and 65535.");
        builder.WebHost.ConfigureKestrel(options =>
        {
            // Replace the configuration loader as well as URL binding. An inherited
            // Kestrel:Endpoints entry must not reopen a network listener during recovery.
            options.Configure(new ConfigurationBuilder().Build());
            options.Listen(IPAddress.Loopback, port);
        });
    }
}

public sealed record RecoveryApproval(string Revision, string Confirmation, bool ReviewedConnections,
    bool ReviewedScripts, bool ReviewedIdentityAndDeployment);

public static class GatewayRecoveryEndpoints
{
    public static void MapGatewayRecoveryEndpoints(this WebApplication app)
    {
        app.MapGet("/api/gateway/recovery", (RecoveryQuarantine recovery) => recovery.Snapshot()).Access("admin");
        app.MapPost("/api/gateway/recovery/approve", (RecoveryApproval request, RecoveryQuarantine recovery) => recovery.ApproveForRestart(request))
            .Access("admin", audit: true);
    }
}
