using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.Configuration;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using SparkStudio.Gateway;

internal static class ContainerHttpsRedirectChecks
{
    public static async Task<int> RunAsync()
    {
        var checks = 0;
        void Check(bool condition, string message) { if (!condition) throw new InvalidOperationException(message); checks++; }
        ContainerHttpsRedirect? Redirect(string? port, string? origin) => ContainerHttpsRedirect.FromConfiguration(new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["SPARKSTUDIO_CONTAINER_HTTP_PORT"] = port, ["SPARKSTUDIO_CONTAINER_HTTPS_ORIGIN"] = origin }).Build());
        Check(Redirect(null, null) is null, "Unconfigured deployments do not gain redirect behavior.");
        foreach (var (port, origin) in new[] {
            ((string?)null, "https://localhost:8443"), ("8090", null), ("0", "https://localhost:8443"), ("65536", "https://localhost:8443"),
            (" 8090", "https://localhost:8443"), ("8090", "http://localhost:8443"), ("8090", "https://localhost"),
            ("8090", "https://localhost:443"), ("8090", "https://localhost:8443/"), ("8090", "https://localhost:8443/path"),
            ("8090", "https://localhost:8443?query=1"), ("8090", "https://localhost:8443#fragment"), ("8090", "https://user:password@localhost:8443"),
            ("8090", "https://*.example.invalid:8443"), ("8090", "https://localhost:8443\r\nLocation: https://other.invalid"),
            ("8090", "https://0.0.0.0:8443"), ("8090", "https://127.1:8443"), ("8090", "https://224.0.0.1:8443"),
            ("8090", "https://[::]:8443"), ("8090", "https://[ff02::1]:8443"), ("8090", "https://-bad.invalid:8443"),
            ("8090", "https://bad..invalid:8443"), ("8090", "https://localhost.:8443"), ("8090", "https://" + new string('a', 64) + ".invalid:8443")
        })
        {
            try { Redirect(port, origin); throw new InvalidOperationException("Unsafe or ambiguous redirect settings were accepted."); }
            catch (ArgumentException) { checks++; }
        }
        foreach (var origin in new[] { "https://localhost:8443", "https://192.0.2.10:18443", "https://plant.example.invalid:8443", "https://[::1]:8443" })
            Check(Redirect("8090", origin) is not null, "Explicit DNS/IPv4/IPv6 origins are accepted without resolving DNS.");

        var redirect = Redirect("8090", "https://localhost:8443")!;
        foreach (var hostname in new[] { "localhost:8443", "LOCALHOST:8443", "127.0.0.1:8443", "127.0.0.2:8443", "[::1]:8443", "[::ffff:127.0.0.1]:8443" })
            Check(!redirect.AllowsHstsForHost(new HostString(hostname)), "Container localhost/loopback responses do not set a host-wide HSTS policy that would break a parallel HTTP gateway.");
        foreach (var hostname in new[] { "plant.example.invalid:8443", "192.0.2.10:8443", "[2001:db8::10]:8443", "not-localhost.example.invalid:8443" })
            Check(redirect.AllowsHstsForHost(new HostString(hostname)), "Public DNS and non-loopback IP TLS responses retain HSTS behavior.");
        DefaultHttpContext Context(string method, int port, string target = "/")
        {
            var context = new DefaultHttpContext();
            context.Connection.LocalPort = port;
            context.Request.Method = method;
            context.Request.Scheme = "http";
            context.Request.Host = new HostString("attacker.invalid:8090");
            context.Features.Get<IHttpRequestFeature>()!.RawTarget = target;
            context.Response.Body = new MemoryStream();
            return context;
        }
        var nextCalls = 0;
        Task Next(HttpContext context) { nextCalls++; return Task.CompletedTask; }
        foreach (var method in new[] { "GET", "HEAD" })
        {
            var context = Context(method, 8090, "/runtime/a%2Fb?value=%2F%25&return=https%3A%2F%2Fevil.invalid");
            context.Request.Headers["X-Forwarded-Host"] = "attacker.invalid";
            context.Request.Headers["X-Forwarded-Proto"] = "https";
            await redirect.InvokeAsync(context, Next);
            Check(context.Response.StatusCode == 308 && context.Response.Headers.Location == "https://localhost:8443/runtime/a%2Fb?value=%2F%25&return=https%3A%2F%2Fevil.invalid",
                "GET/HEAD preserve escaped path/query and never use Host or forwarded headers for redirect authority.");
            Check(context.Response.Headers.CacheControl == "no-store" && nextCalls == 0, "Redirects do not cache configuration or execute account/API handlers.");
        }
        foreach (var method in new[] { "POST", "PUT", "PATCH", "DELETE", "OPTIONS" })
        {
            var context = Context(method, 8090, "/api/auth/setup");
            await redirect.InvokeAsync(context, Next);
            Check(context.Response.StatusCode == 403 && !context.Response.Headers.ContainsKey("Location") && nextCalls == 0,
                "Non-read HTTP methods are rejected rather than replaying a credential or write request through a redirect.");
        }
        foreach (var target in new[] { "http://other.invalid/", "/bad\r\nInjected: value", "/bad\\path", "/bad#fragment", "/bad path", "/" + new string('a', 65536) })
        {
            var context = Context("GET", 8090, target);
            await redirect.InvokeAsync(context, Next);
            Check(context.Response.StatusCode == 400 && !context.Response.Headers.ContainsKey("Location") && nextCalls == 0, "Invalid request targets cannot reach a Location header.");
        }
        foreach (var port in new[] { 5090, 8443, 5091 })
        {
            var context = Context("POST", port, "/api/auth/setup");
            var before = nextCalls;
            await redirect.InvokeAsync(context, Next);
            Check(nextCalls == before + 1 && !context.Response.Headers.ContainsKey("Location"), "Only the explicit public HTTP socket port is redirected; management/bootstrap remains private and unchanged.");
        }
        var tls = Context("POST", 8090, "/api/auth/login");
        tls.Features.Set<ITlsConnectionFeature>(new TlsConnectionFeature());
        var tlsBefore = nextCalls;
        await redirect.InvokeAsync(tls, Next);
        Check(nextCalls == tlsBefore + 1 && !tls.Response.Headers.ContainsKey("Location"), "An actual direct TLS connection bypasses the HTTP landing redirect.");
        var forgedScheme = Context("POST", 8090);
        forgedScheme.Request.Scheme = "https";
        var schemeBefore = nextCalls;
        await redirect.InvokeAsync(forgedScheme, Next);
        Check(forgedScheme.Response.StatusCode == 403 && nextCalls == schemeBefore, "A rewritten request scheme cannot confer direct TLS trust.");
        var fallback = Context("GET", 8090);
        fallback.Features.Get<IHttpRequestFeature>()!.RawTarget = null!;
        fallback.Request.PathBase = "/base";
        fallback.Request.Path = "/spaces here";
        fallback.Request.QueryString = new QueryString("?value=%2F");
        await redirect.InvokeAsync(fallback, Next);
        Check(fallback.Response.Headers.Location == "https://localhost:8443/base/spaces%20here?value=%2F", "Non-network test hosts without raw targets escape path components safely.");

        Check(GatewaySecurity.CookieName(GatewaySecurity.EngineeringScheme) == GatewaySecurity.EngineeringScheme
            && GatewaySecurity.CookieName(GatewaySecurity.OperatorScheme) == GatewaySecurity.OperatorScheme,
            "Absent namespaces preserve existing Windows/local cookie names.");
        foreach (var invalid in new[] { "", " ", "namespace.with.dot", "cookie;Domain=other.invalid", "line\r\nInjection", "unicode-é", new string('a', 49) })
        {
            try { GatewaySecurity.CookieName(GatewaySecurity.EngineeringScheme, invalid); throw new InvalidOperationException("Invalid cookie namespace was accepted."); }
            catch (ArgumentException) { checks++; }
        }
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddDataProtection().UseEphemeralDataProtectionProvider();
        services.AddGatewaySecurity("unused-synthetic-data", "SparkStudioDocker");
        using var provider = services.BuildServiceProvider();
        var cookies = provider.GetRequiredService<IOptionsMonitor<CookieAuthenticationOptions>>();
        foreach (var scheme in new[] { GatewaySecurity.EngineeringScheme, GatewaySecurity.OperatorScheme })
        {
            var options = cookies.Get(scheme);
            Check(options.Cookie.Name == "SparkStudioDocker." + scheme
                && options.Cookie.Name != GatewaySecurity.CookieName(scheme)
                && options.Cookie.Name != GatewaySecurity.CookieName(scheme, "OtherContainer"),
                "Parallel gateway namespaces isolate host-scoped engineering and operator cookies without renaming authentication schemes.");
            Check(options.Cookie.HttpOnly && options.Cookie.SameSite == SameSiteMode.Strict
                && options.Cookie.SecurePolicy == CookieSecurePolicy.SameAsRequest && options.Cookie.Path == "/",
                "Cookie isolation preserves HttpOnly, SameSite, TLS Secure policy and path behavior.");
        }
        return checks;
    }
}
