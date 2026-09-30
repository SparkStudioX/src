using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Server.Kestrel.Core.Features;
using Microsoft.Extensions.Configuration.Json;
using Microsoft.Extensions.Hosting.WindowsServices;

namespace SparkStudio.Gateway;

/// <summary>Read-only, allowlisted deployment observations; startup settings are not reread after reload.</summary>
public sealed class GatewayDeployment
{
    private const int MaximumEntries = 128;
    private readonly DateTimeOffset startedAt = DateTimeOffset.UtcNow;
    private readonly DeploymentValue environment;
    private readonly DeploymentConfiguration configuration;
    private readonly DeploymentHosting hosting;
    private readonly string bootstrapPublicSource;
    private readonly bool forwardedHeadersHostOverride;
    private readonly bool iisHostingIndicators;
    private static readonly Regex OriginPattern = new(@"\Ahttps?://(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.*+_-]+)(?::[0-9]{1,5})?/?\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex HostPattern = new(@"\A(?:\*|\[[0-9a-fA-F:.]+\]|[A-Za-z0-9*_-]+(?:\.[A-Za-z0-9*_-]+)*)\z", RegexOptions.CultureInvariant);

    public GatewayDeployment(IConfiguration config, IHostEnvironment host, string dataDirectory)
    {
        var endpointUrls = config.GetSection("Kestrel:Endpoints").GetChildren().Take(MaximumEntries + 1)
            .Select(endpoint => (Key: endpoint.Path + ":Url", Value: endpoint["Url"]))
            .Where(endpoint => endpoint.Value is not null).ToArray();
        var endpointSources = endpointUrls.Select(endpoint => Source(config, endpoint.Key)).Distinct().ToArray();
        environment = new(host.EnvironmentName, config["environment"] == host.EnvironmentName ? Source(config, "environment") : ".NET host startup");
        configuration = new(startedAt,
            Addresses(Split(config["Urls"]), Source(config, "Urls")),
            Addresses(endpointUrls.Select(endpoint => endpoint.Value!), endpointSources.Length == 1 ? endpointSources[0] : endpointSources.Length == 0 ? "Not configured" : "Multiple configuration providers"),
            Hosts(Split(config["AllowedHosts"]), Source(config, "AllowedHosts")),
            new(dataDirectory, Environment.GetEnvironmentVariable("SPARKSTUDIO_DATA_DIR") is not null ? "SPARKSTUDIO_DATA_DIR environment variable"
                : config["DataDirectory"] is not null ? Source(config, "DataDirectory") : "Application default: data beside the gateway"),
            "These values were captured at startup. Restart the gateway after changing startup configuration, then compare the observed listeners. The public operator URL updates through Security → Operator settings without a restart.");
        bootstrapPublicSource = Environment.GetEnvironmentVariable("SPARKSTUDIO_PUBLIC_BASE_URL") is not null
            ? "SPARKSTUDIO_PUBLIC_BASE_URL environment variable" : Source(config, "Security:PublicBaseUrl");
        forwardedHeadersHostOverride = string.Equals(config["FORWARDEDHEADERS_ENABLED"], "true", StringComparison.OrdinalIgnoreCase);
        iisHostingIndicators = Environment.GetEnvironmentVariable("ASPNETCORE_IIS_PHYSICAL_PATH") is not null
            || Environment.GetEnvironmentVariable("ASPNETCORE_PORT") is not null;
        hosting = OperatingSystem.IsWindows() && WindowsServiceHelpers.IsWindowsService()
            ? new("windows-service", "Running as a Windows service.")
            : Environment.GetEnvironmentVariable("DOTNET_RUNNING_IN_CONTAINER") is "true" or "1"
                ? new("container", "The .NET runtime environment identifies this process as running in a container.")
                : OperatingSystem.IsWindows() && Environment.UserInteractive
                    ? new("interactive", "Running in an interactive Windows session.")
                    : new("unknown", "The hosting mode cannot be established from the available runtime indicators.");
    }

    public DeploymentSnapshot Snapshot(HttpContext context, IServer server, SecurityStore security)
    {
        var addresses = Addresses(server.Features.Get<IServerAddressesFeature>()?.Addresses ?? [], "Server observations");
        var observed = addresses.Values;
        var requestHttps = context.Request.IsHttps;
        var requestLoopback = GatewaySecurity.IsLoopback(context);
        var iisHosted = iisHostingIndicators || server.GetType().Namespace?.StartsWith("Microsoft.AspNetCore.Server.IIS", StringComparison.Ordinal) == true;
        bool? forwarded = forwardedHeadersHostOverride ? true : iisHosted ? null : false;
        var effectivePublic = security.Settings.PublicBaseUrl;
        var publicAddress = effectivePublic is not null
            ? new DeploymentPublicAddress(effectivePublic, security.SetupRequired ? "bootstrap" : "gateway-settings",
                security.SetupRequired ? $"Initial value from {bootstrapPublicSource}. It is saved with the account store when setup completes."
                    : "Saved gateway setting. Environment/configuration public URL values only seed a new account store; they do not override this value.")
            : new DeploymentPublicAddress(SafeOrigin($"{context.Request.Scheme}://{context.Request.Host}"), "request-origin",
                "No public operator URL is saved. Operator links use the address currently used by this browser; this is not a listener or proxy configuration.");
        return new(DateTimeOffset.UtcNow, startedAt, environment, hosting,
            new(observed, observed.Any(address => address.StartsWith("https://", StringComparison.OrdinalIgnoreCase)) ? true
                    : observed.Length == 0 || addresses.OmittedEntries != 0 ? null : false,
                observed.Any(address => !IsLoopbackAddress(address)) ? false
                    : observed.Length == 0 || addresses.OmittedEntries != 0 ? null : true, addresses.OmittedEntries),
            configuration, publicAddress,
            new(requestHttps, requestLoopback, forwarded, forwardedHeadersHostOverride,
                forwardedHeadersHostOverride
                    ? "A framework forwarded-header override was enabled at startup. SparkStudio does not configure trusted proxies. Request HTTPS and loopback observations may reflect processed forwarded headers; external proxy trust and TLS are not verified."
                    : iisHosted
                        ? "IIS hosting indicators are present. SparkStudio does not configure trusted proxies; hosting integration may affect the processed request. Proxy trust and external TLS are not verified."
                        : "SparkStudio does not configure trusted proxies, and no framework forwarding override was observed at startup. Request observations describe this gateway request, not a verified external proxy or public TLS endpoint.", Certificate(context)));
    }

    private static DeploymentCertificate Certificate(HttpContext context)
    {
        try
        {
            var certificate = context.Features.Get<ISslStreamFeature>()?.SslStream.LocalCertificate;
            if (certificate is not null)
            {
                // Parse only the public certificate. Never read/export a private key or certificate password.
                using var publicCertificate = X509CertificateLoader.LoadCertificate(certificate.GetRawCertData());
                return new("observed", publicCertificate.NotAfter.ToUniversalTime(),
                    "Expiry belongs to the certificate presented on this gateway connection only. It does not establish hostname match, trust, revocation status, other listeners or a proxy certificate.");
            }
        }
        catch (Exception error) when (error is CryptographicException or InvalidOperationException) { }
        return new("unavailable", null,
            "No server certificate is observable for this request. Plain HTTP and HTTP/3 do not expose this TLS-stream observation; proxy certificates are not inspected.");
    }

    private static string[] Split(string? value) => value?.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries) ?? [];
    private static DeploymentValues Addresses(IEnumerable<string> values, string source)
    {
        var bounded = values.Take(MaximumEntries + 1).ToArray();
        var safe = bounded.Take(MaximumEntries).Select(SafeOrigin).Where(value => value is not null).Cast<string>().ToArray();
        return new(safe.Distinct(StringComparer.OrdinalIgnoreCase).ToArray(), source, bounded.Length - safe.Length);
    }
    private static DeploymentValues Hosts(IEnumerable<string> values, string source)
    {
        var bounded = values.Take(MaximumEntries + 1).ToArray();
        var safe = bounded.Take(MaximumEntries).Where(value => value.Length <= 253 && HostPattern.IsMatch(value)).ToArray();
        return new(safe.Distinct(StringComparer.OrdinalIgnoreCase).ToArray(), source, bounded.Length - safe.Length);
    }
    private static string? SafeOrigin(string value)
    {
        if (value.Length > 2048 || !OriginPattern.IsMatch(value)) return null;
        var parsed = value.Replace("://*", "://0.0.0.0", StringComparison.Ordinal).Replace("://+", "://0.0.0.0", StringComparison.Ordinal);
        return Uri.TryCreate(parsed, UriKind.Absolute, out var uri) && uri.Port is >= 0 and <= 65535 ? value.TrimEnd('/') : null;
    }
    private static bool IsLoopbackAddress(string value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri)) return false;
        var host = uri.Host.Trim('[', ']');
        return host.Equals("localhost", StringComparison.OrdinalIgnoreCase) || IPAddress.TryParse(host, out var address)
            && (IPAddress.IsLoopback(address) || address.IsIPv4MappedToIPv6 && IPAddress.IsLoopback(address.MapToIPv4()));
    }
    private static string Source(IConfiguration config, string key)
    {
        if (config is not IConfigurationRoot root) return config[key] is null ? "Not configured" : "Configuration provider";
        foreach (var provider in root.Providers.Reverse())
        {
            if (!provider.TryGet(key, out _)) continue;
            if (provider is JsonConfigurationProvider json)
                return json.Source.Path == "appsettings.json" ? "appsettings.json" : "Environment or other JSON configuration";
            return provider.GetType().Name switch
            {
                "CommandLineConfigurationProvider" => "Command-line arguments",
                "EnvironmentVariablesConfigurationProvider" => "Environment variables",
                "ChainedConfigurationProvider" => "Host configuration",
                "MemoryConfigurationProvider" => "In-memory host configuration",
                _ => "Configuration provider"
            };
        }
        return "Not configured";
    }
}

public sealed record DeploymentValue(string Value, string Source);
public sealed record DeploymentValues(string[] Values, string Source, int OmittedEntries);
public sealed record DeploymentHosting(string Kind, string Description);
public sealed record DeploymentConfiguration(DateTimeOffset CapturedAt, DeploymentValues Urls, DeploymentValues KestrelEndpoints,
    DeploymentValues AllowedHosts, DeploymentValue DataDirectory, string RestartNote);
public sealed record DeploymentListeners(string[] Addresses, bool? HttpsEnabled, bool? LoopbackOnly, int OmittedEntries);
public sealed record DeploymentPublicAddress(string? Value, string Source, string Description);
public sealed record DeploymentCertificate(string Status, DateTimeOffset? ExpiresAt, string Note);
public sealed record DeploymentTransport(bool RequestHttps, bool RequestLoopback, bool? ForwardedHeadersEnabled, bool ForwardedHeadersHostOverride, string ProxyNote, DeploymentCertificate Certificate);
public sealed record DeploymentSnapshot(DateTimeOffset ObservedAt, DateTimeOffset StartedAt, DeploymentValue Environment,
    DeploymentHosting Hosting, DeploymentListeners Listeners, DeploymentConfiguration Configuration,
    DeploymentPublicAddress PublicOperatorAddress, DeploymentTransport Transport);

public static class GatewayDeploymentEndpoints
{
    public static void MapGatewayDeploymentEndpoints(this WebApplication app) =>
        app.MapGet("/api/gateway/deployment", (HttpContext context, GatewayDeployment deployment, IServer server, SecurityStore security) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            return deployment.Snapshot(context, server, security);
        }).Access("configuration");
}
