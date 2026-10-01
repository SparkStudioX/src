using System.Globalization;
using System.Net;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http.Extensions;
using Microsoft.AspNetCore.Http.Features;

namespace SparkStudio.Gateway;

/// <summary>Opt-in container HTTP landing link. It never grants HTTP account access.</summary>
public sealed class ContainerHttpsRedirect
{
    private static readonly Regex Origin = new(@"\Ahttps://(?<host>\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+):(?<port>[0-9]{4,5})\z", RegexOptions.CultureInvariant);
    private readonly int httpPort;
    private readonly string httpsOrigin;

    private ContainerHttpsRedirect(int httpPort, string httpsOrigin)
    { this.httpPort = httpPort; this.httpsOrigin = httpsOrigin; }

    public bool AllowsHstsForHost(HostString host)
    {
        // HSTS is host-wide across ports. A localhost Docker evaluation must
        // not force a separate Windows HTTP gateway on localhost onto TLS.
        // Network identities keep HSTS; direct TLS and account guards remain.
        var hostname = host.Host.Trim('[', ']');
        if (hostname.Equals("localhost", StringComparison.OrdinalIgnoreCase)) return false;
        return !IPAddress.TryParse(hostname, out var address) || !(IPAddress.IsLoopback(address)
            || address.IsIPv4MappedToIPv6 && IPAddress.IsLoopback(address.MapToIPv4()));
    }

    public static ContainerHttpsRedirect? FromConfiguration(IConfiguration configuration)
    {
        var port = configuration["SPARKSTUDIO_CONTAINER_HTTP_PORT"];
        var origin = configuration["SPARKSTUDIO_CONTAINER_HTTPS_ORIGIN"];
        if (port is null && origin is null) return null;
        if (port is null || port.Length > 5 || port.Any(character => !char.IsAsciiDigit(character))
            || !int.TryParse(port, NumberStyles.None, CultureInfo.InvariantCulture, out var httpPort) || httpPort is < 1024 or > 65535
            || origin is null || origin.Length > 320 || !Origin.IsMatch(origin)
            || !Uri.TryCreate(origin, UriKind.Absolute, out var address) || address.Port is < 1024 or > 65535)
            throw new ArgumentException("Container redirect requires an HTTP port from 1024 to 65535 and a fixed HTTPS origin with an explicit port, without credentials, path, query or fragment.");
        // Uri canonicalizes abbreviated IPv4 hosts; validate the supplied
        // identity first so those forms cannot silently change the destination.
        var hostname = Origin.Match(origin).Groups["host"].Value.Trim('[', ']');
        if (IPAddress.TryParse(hostname, out var ip))
        {
            if (ip.Equals(IPAddress.Any) || ip.Equals(IPAddress.IPv6Any) || ip.IsIPv6Multicast
                || ip.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork && (hostname != ip.ToString() || ip.GetAddressBytes()[0] is 0 or >= 224))
                throw new ArgumentException("Container redirect needs a specific DNS or IP identity, not a wildcard, abbreviated or multicast address.");
        }
        else if (hostname.Length > 253 || hostname.All(character => char.IsAsciiDigit(character) || character == '.')
            || Uri.CheckHostName(hostname) != UriHostNameType.Dns || hostname.StartsWith('.') || hostname.EndsWith('.')
            || hostname.Split('.').Any(label => label.Length is < 1 or > 63 || label.StartsWith('-') || label.EndsWith('-')))
            throw new ArgumentException("Container redirect needs a valid DNS hostname or specific IP identity.");
        return new(httpPort, address.GetLeftPart(UriPartial.Authority));
    }

    public async Task InvokeAsync(HttpContext context, RequestDelegate next)
    {
        // Request scheme and forwarded headers cannot confer TLS trust. The
        // internal management port is deliberately outside this middleware.
        if (context.Connection.LocalPort != httpPort || GatewaySecurity.IsDirectTls(context))
        { await next(context); return; }
        context.Response.Headers.CacheControl = "no-store";
        if (!HttpMethods.IsGet(context.Request.Method) && !HttpMethods.IsHead(context.Request.Method))
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            await context.Response.WriteAsJsonAsync(new { error = "Use the gateway HTTPS address for account and API requests." });
            return;
        }
        // Keep encoded slashes and query values exactly as the server received
        // them. Authority comes solely from validated startup configuration.
        var target = context.Features.Get<IHttpRequestFeature>()?.RawTarget;
        if (string.IsNullOrEmpty(target)) target = context.Request.GetEncodedPathAndQuery();
        if (target.Length > 65_536 || !target.StartsWith('/') || target.Any(character => character is < '!' or > '~' or '\\' or '#'))
        { context.Response.StatusCode = StatusCodes.Status400BadRequest; return; }
        context.Response.StatusCode = StatusCodes.Status308PermanentRedirect;
        context.Response.Headers.Location = httpsOrigin + target;
    }
}
