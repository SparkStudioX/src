using System.Net;
using System.Security.Claims;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;

namespace SparkStudio.Gateway;

public sealed record SecuritySetupRequest(string SetupCode, string Username, string Password, string? DisplayName = null);
public sealed record SecurityLoginRequest(string Audience, string Username, string Password, string? ProjectId = null);
public sealed record SecurityLogoutRequest(string Audience);
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record SecurityPasswordRequest(string? CurrentPassword, string? NewPassword);

/// <summary>Separate browser sessions for engineering and operator applications.</summary>
public static class GatewaySecurity
{
    public const string EngineeringAudience = "engineering";
    public const string OperatorAudience = "operator";
    public const string EngineeringScheme = "SparkStudio.Engineering";
    public const string OperatorScheme = "SparkStudio.Operator";
    public const string CsrfHeader = "X-SPARK-CSRF";
    private const string SessionClaim = "spark:session";
    private static readonly object SessionKey = new();
    private static readonly object UserKey = new();
    private static object? Item(HttpContext context, object key) => context.Items.TryGetValue(key, out var value) ? value : null;

    public static IServiceCollection AddGatewaySecurity(this IServiceCollection services, string dataDirectory)
    {
        services.AddSingleton(provider => new SecurityStore(dataDirectory,
            Environment.GetEnvironmentVariable("SPARKSTUDIO_PUBLIC_BASE_URL")
                ?? provider.GetRequiredService<IConfiguration>()["Security:PublicBaseUrl"]));
        var auth = services.AddAuthentication();
        AddCookie(auth, EngineeringScheme, EngineeringAudience);
        AddCookie(auth, OperatorScheme, OperatorAudience);
        return services;
    }

    private static void AddCookie(AuthenticationBuilder authentication, string scheme, string audience)
    {
        authentication.AddCookie(scheme, options =>
        {
            options.Cookie.Name = scheme;
            options.Cookie.HttpOnly = true;
            options.Cookie.SameSite = SameSiteMode.Strict;
            options.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
            options.Cookie.Path = "/";
            options.ExpireTimeSpan = TimeSpan.FromHours(8);
            options.SlidingExpiration = false;
            options.Events = new CookieAuthenticationEvents
            {
                OnValidatePrincipal = async context =>
                {
                    var store = context.HttpContext.RequestServices.GetRequiredService<SecurityStore>();
                    var resolved = store.ResolveSession(context.Principal?.FindFirstValue(SessionClaim), audience);
                    if (resolved is null || !IsSecureTransport(context.HttpContext))
                    {
                        context.RejectPrincipal();
                        await context.HttpContext.SignOutAsync(scheme);
                    }
                },
                OnRedirectToLogin = context => WriteError(context.HttpContext, 401, "Sign in to continue."),
                OnRedirectToAccessDenied = context => WriteError(context.HttpContext, 403, "This account does not have permission for that operation.")
            };
        });
    }

    public static async Task<SecurityUser?> AuthenticateAsync(HttpContext context, string audience)
    {
        var scheme = Scheme(audience);
        context.Items.Remove(SessionKey);
        context.Items.Remove(UserKey);
        context.User = new ClaimsPrincipal(new ClaimsIdentity());
        if (!IsSecureTransport(context)) return null;
        var result = await context.AuthenticateAsync(scheme);
        if (!result.Succeeded || result.Principal is null) return null;
        var store = context.RequestServices.GetRequiredService<SecurityStore>();
        var resolved = store.ResolveSession(result.Principal.FindFirstValue(SessionClaim), audience);
        if (resolved is null) return null;
        context.User = result.Principal;
        context.Items[SessionKey] = resolved.Value.Session;
        context.Items[UserKey] = resolved.Value.User;
        context.Items["spark.sessionExpiresAt"] = resolved.Value.Session.ExpiresAt;
        return resolved.Value.User;
    }

    public static SecurityUser? CurrentUser(HttpContext context) => Item(context, UserKey) as SecurityUser;
    public static string? CurrentSessionAdministrationId(HttpContext context) => (Item(context, SessionKey) as SecuritySession)?.AdministrationId;

    // A subscription retains only the identity needed for revalidation, never a completed HTTP request.
    public static Func<bool> CaptureSessionValidator(HttpContext context)
    {
        if (Item(context, SessionKey) is not SecuritySession session) throw new UnauthorizedAccessException("Sign in to continue.");
        var store = context.RequestServices.GetRequiredService<SecurityStore>();
        return () => store.ResolveSession(session.Id, session.Audience) is not null;
    }

    public static bool SessionStillValid(HttpContext context)
    {
        if (Item(context, SessionKey) is not SecuritySession session) return false;
        return context.RequestServices.GetRequiredService<SecurityStore>().ResolveSession(session.Id, session.Audience) is not null;
    }

    public static void RequireCsrf(HttpContext context) => ValidateCsrf(context);
    public static void ValidateCsrf(HttpContext context, SecurityUser? user = null)
    {
        if (Item(context, SessionKey) is not SecuritySession session
            || context.Request.Headers[CsrfHeader].Count != 1
            || !SecurityStore.SecretEquals(session.CsrfToken, context.Request.Headers[CsrfHeader][0]))
            throw new BadHttpRequestException("The session security token is missing or expired. Refresh and try again.", 403);
        var store = context.RequestServices.GetRequiredService<SecurityStore>();
        var resolved = store.ResolveSession(session.Id, session.Audience);
        if (resolved is null || user is not null && resolved.Value.User.Id != user.Id)
            throw new BadHttpRequestException("Sign in again to continue.", 401);
    }

    public static bool IsSecureTransport(HttpContext context) => context.Request.IsHttps || IsLoopback(context);
    public static bool IsLoopback(HttpContext context)
    {
        var address = context.Connection.RemoteIpAddress;
        return address is not null && (IPAddress.IsLoopback(address) || address.IsIPv4MappedToIPv6 && IPAddress.IsLoopback(address.MapToIPv4()));
    }
    public static string ValidateAudience(string? audience)
    {
        if (audience is not EngineeringAudience and not OperatorAudience)
            throw new ArgumentException("Audience must be engineering or operator.");
        return audience;
    }
    private static string Scheme(string audience) => ValidateAudience(audience) == EngineeringAudience ? EngineeringScheme : OperatorScheme;

    public static IEndpointRouteBuilder MapGatewaySecurityEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/api/auth/session", async (HttpContext context, SecurityStore store, ProjectCatalog catalog,
            string audience, string? projectId) =>
        {
            GuardTransportAndOrigin(context);
            ValidateAudience(audience);
            var user = await AuthenticateAsync(context, audience);
            return Results.Json(SessionResponse(context, store, catalog, audience, user, projectId));
        });
        endpoints.MapPost("/api/auth/setup", async (HttpContext context, SecuritySetupRequest request, SecurityStore store, ProjectCatalog catalog) =>
        {
            GuardTransportAndOrigin(context, json: true);
            if (!IsLoopback(context)) throw new BadHttpRequestException("Initial setup must be completed on the gateway computer.", 403);
            var user = store.Setup(request.SetupCode, new(request.Username, request.Password, request.DisplayName));
            await SignIn(context, store, user, EngineeringAudience);
            return Results.Json(SessionResponse(context, store, catalog, EngineeringAudience, user, null));
        });
        endpoints.MapPost("/api/auth/login", async (HttpContext context, SecurityLoginRequest request, SecurityStore store, ProjectCatalog catalog) =>
        {
            GuardTransportAndOrigin(context, json: true);
            ValidateAudience(request.Audience);
            if (store.SetupRequired) throw new BadHttpRequestException("Complete local gateway setup first.", 409);
            var user = store.Login(request.Username, request.Password, context.Connection.RemoteIpAddress?.ToString() ?? "unknown");
            var allowed = user.GatewayAdmin || request.Audience == EngineeringAudience && string.IsNullOrEmpty(request.ProjectId) && store.GetGatewayCapabilities(user).Any || (request.ProjectId is { Length: > 0 }
                ? store.Can(user, request.ProjectId, request.Audience == EngineeringAudience ? "design" : "view")
                : user.ProjectGrants.Values.Any(grant => request.Audience == EngineeringAudience ? grant.Design : grant.View));
            if (!allowed)
            {
                store.Audit(user, "auth.login", request.ProjectId, "denied");
                throw new BadHttpRequestException("This account does not have access to the requested application.", 403);
            }
            if (request.ProjectId is { Length: > 0 }) catalog.Describe(request.ProjectId);
            await SignIn(context, store, user, request.Audience);
            store.Audit(user, "auth.login", request.ProjectId, "allowed");
            return Results.Json(SessionResponse(context, store, catalog, request.Audience, user, request.ProjectId));
        });
        endpoints.MapPost("/api/auth/password", async (HttpContext context, SecurityPasswordRequest request, SecurityStore store) =>
        {
            GuardTransportAndOrigin(context, json: true);
            var audiences = context.Request.Headers["X-SPARK-AUDIENCE"];
            if (audiences.Count > 1) throw new ArgumentException("Choose one authentication audience.");
            var audience = ValidateAudience(audiences.Count == 0 ? EngineeringAudience : audiences[0]);
            var user = await AuthenticateAsync(context, audience);
            if (user is null) throw new BadHttpRequestException("Sign in to continue.", 401);
            ValidateCsrf(context, user);
            var session = (SecuritySession)context.Items[SessionKey]!;
            // A browser can be signed in as a different person in the other application.
            // Clear only this account's cookies; its other devices are revoked in the store.
            var schemes = new List<string>();
            foreach (var scheme in new[] { EngineeringScheme, OperatorScheme })
            {
                var authenticated = await context.AuthenticateAsync(scheme);
                if (authenticated.Principal?.FindFirstValue(ClaimTypes.NameIdentifier) == user.Id) schemes.Add(scheme);
            }
            AuditMutation(context, store, user, "auth.password.change", user.Id,
                () => store.ChangePassword(user, session, request.CurrentPassword, request.NewPassword,
                    context.Connection.RemoteIpAddress?.ToString() ?? "unknown"));
            foreach (var scheme in schemes) await context.SignOutAsync(scheme);
            context.Items.Remove(SessionKey);
            context.Items.Remove(UserKey);
            context.User = new ClaimsPrincipal(new ClaimsIdentity());
            return Results.Json(new { changed = true });
        });
        endpoints.MapPost("/api/auth/logout", async (HttpContext context, SecurityLogoutRequest request, SecurityStore store) =>
        {
            GuardTransportAndOrigin(context, json: true);
            var user = await AuthenticateAsync(context, request.Audience);
            if (user is null) throw new BadHttpRequestException("Sign in to continue.", 401);
            ValidateCsrf(context, user);
            if (context.Items[SessionKey] is SecuritySession session) store.RevokeSession(session.Id);
            await context.SignOutAsync(Scheme(request.Audience));
            context.Items.Remove(SessionKey);
            context.Items.Remove(UserKey);
            store.Audit(user, "auth.logout", null, "allowed");
            return Results.Json(new { ok = true });
        });
        endpoints.MapGet("/api/security/users", async (HttpContext context, SecurityStore store) =>
        {
            await RequireAdmin(context, store);
            return Results.Json(new { users = store.Users });
        });
        endpoints.MapPost("/api/security/users", async (HttpContext context, SecurityCreateUser request, SecurityStore store, ProjectCatalog catalog) =>
        {
            var actor = await RequireAdmin(context, store, mutation: true);
            CheckProjects(catalog, request.ProjectGrants?.Keys);
            var user = AuditMutation(context, store, actor, "security.user.create", null, () => store.CreateUser(request));
            return Results.Json(user, statusCode: 201);
        });
        endpoints.MapPut("/api/security/users/{id}", async (HttpContext context, string id, SecurityUpdateUser request, SecurityStore store, ProjectCatalog catalog) =>
        {
            var actor = await RequireAdmin(context, store, mutation: true);
            CheckProjects(catalog, request.ProjectGrants?.Keys);
            var user = AuditMutation(context, store, actor, "security.user.update", id, () => store.UpdateUser(id, request));
            return Results.Json(user);
        });
        endpoints.MapGet("/api/security/settings", async (HttpContext context, SecurityStore store) =>
        {
            await RequireAdmin(context, store);
            return Results.Json(store.Settings);
        });
        endpoints.MapPut("/api/security/settings", async (HttpContext context, SecurityUpdateSettings request, SecurityStore store, ProjectCatalog catalog) =>
        {
            var actor = await RequireAdmin(context, store, mutation: true);
            CheckProjects(catalog, request.ProjectTagPrefixes?.Keys);
            var settings = AuditMutation(context, store, actor, "security.settings.update", null, () => store.UpdateSettings(request));
            return Results.Json(settings);
        });
        endpoints.MapGet("/api/security/audit", async (HttpContext context, SecurityStore store, int? limit) =>
        {
            await RequireCapability(context, store, "audit");
            return Results.Json(new { entries = store.ReadAudit(limit ?? 100) });
        });
        return endpoints;
    }

    private static async Task<SecurityUser> RequireAdmin(HttpContext context, SecurityStore store, bool mutation = false)
        => await RequireCapability(context, store, "gatewayAdmin", mutation);

    private static async Task<SecurityUser> RequireCapability(HttpContext context, SecurityStore store, string capability, bool mutation = false)
    {
        GuardTransportAndOrigin(context, json: mutation);
        var user = await AuthenticateAsync(context, EngineeringAudience);
        if (user is null) throw new BadHttpRequestException("Sign in to the gateway administration application.", 401);
        if (!store.Can(user, null, capability))
        {
            store.Audit(user, "security.access", null, "denied");
            throw new BadHttpRequestException($"Gateway {capability} permission is required.", 403);
        }
        if (mutation) ValidateCsrf(context, user);
        return user;
    }

    private static async Task SignIn(HttpContext context, SecurityStore store, SecurityUser user, string audience)
    {
        // Rotate only the selected audience. Operator sign-in cannot affect engineering credentials.
        var existing = await context.AuthenticateAsync(Scheme(audience));
        store.RevokeSession(existing.Principal?.FindFirstValue(SessionClaim));
        var session = store.CreateSession(user, audience);
        var principal = new ClaimsPrincipal(new ClaimsIdentity(new[] {
            new Claim(ClaimTypes.NameIdentifier, user.Id), new Claim(ClaimTypes.Name, user.Username),
            new Claim(SessionClaim, session.Id), new Claim("spark:audience", audience)
        }, Scheme(audience)));
        await context.SignInAsync(Scheme(audience), principal, new AuthenticationProperties
        {
            IsPersistent = false, AllowRefresh = false, IssuedUtc = DateTimeOffset.UtcNow, ExpiresUtc = session.ExpiresAt
        });
        context.User = principal;
        context.Items[SessionKey] = session;
        context.Items[UserKey] = user;
        context.Items["spark.sessionExpiresAt"] = session.ExpiresAt;
    }

    private static object SessionResponse(HttpContext context, SecurityStore store, ProjectCatalog catalog, string audience,
        SecurityUser? user, string? projectId)
    {
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers.Pragma = "no-cache";
        var permissions = store.GetPermissions(user, projectId);
        object? project = null;
        if (projectId is { Length: > 0 } && user is not null
            && (audience == EngineeringAudience ? permissions.Design || permissions.GatewayAdmin : permissions.View))
        {
            try
            {
                var info = catalog.Describe(projectId);
                project = new { id = projectId, name = info["name"]?.GetValue<string>() ?? projectId };
            }
            catch (KeyNotFoundException)
            {
                // An archived project ends project access, not the gateway login session.
                permissions = new(false, false, false, false, permissions.GatewayAdmin);
            }
        }
        return new
        {
            setupRequired = store.SetupRequired, audience,
            user = user is null ? null : new { user.Id, user.Username, user.DisplayName, user.GatewayAdmin },
            csrfToken = user is null ? null : (Item(context, SessionKey) as SecuritySession)?.CsrfToken,
            permissions, gatewayCapabilities = store.GetGatewayCapabilities(user), project, operatorBaseUrl = store.Settings.PublicBaseUrl
        };
    }

    private static void CheckProjects(ProjectCatalog catalog, IEnumerable<string>? projectIds)
    {
        if (projectIds is null) return;
        foreach (var projectId in projectIds) catalog.Describe(projectId, includeArchived: true);
    }

    private static T AuditMutation<T>(HttpContext context, SecurityStore store, SecurityUser actor, string action, string? target, Func<T> mutate)
    {
        var resource = context.Request.Path.Value;
        store.Audit(actor, action, null, "started", target, resource);
        try
        {
            var result = mutate();
            store.Audit(actor, action, null, "allowed", result is SecurityUser user ? user.Id : target, resource);
            return result;
        }
        catch
        {
            store.Audit(actor, action, null, "failed", target, resource);
            throw;
        }
    }

    private static void GuardTransportAndOrigin(HttpContext context, bool json = false)
    {
        context.Response.Headers.CacheControl = "no-store";
        if (!IsSecureTransport(context)) throw new BadHttpRequestException("HTTPS is required when accessing gateway accounts from another computer.", 403);
        if (json && !context.Request.HasJsonContentType()) throw new BadHttpRequestException("Authentication requests must use application/json.", 415);
        if (context.Request.Headers.Origin is { Count: > 0 } origins)
        {
            var expected = $"{context.Request.Scheme}://{context.Request.Host}";
            var origin = origins.Count == 1 ? origins[0] : null;
            var development = IsLoopback(context) && context.RequestServices.GetRequiredService<IHostEnvironment>().IsDevelopment()
                && origin is "http://localhost:5173" or "http://127.0.0.1:5173";
            if (!string.Equals(origin, expected, StringComparison.OrdinalIgnoreCase) && !development)
                throw new BadHttpRequestException("Cross-origin account requests are not allowed.", 403);
        }
        if (context.Request.Headers["Sec-Fetch-Site"] == "cross-site")
            throw new BadHttpRequestException("Cross-site account requests are not allowed.", 403);
    }

    private static async Task WriteError(HttpContext context, int status, string error)
    {
        context.Response.StatusCode = status;
        await context.Response.WriteAsJsonAsync(new { error });
    }
}
