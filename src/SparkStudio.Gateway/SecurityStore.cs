using System.Net;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.Options;

namespace SparkStudio.Gateway;

public sealed record SecurityProjectGrant(bool View = false, bool Operate = false, bool Design = false, bool Publish = false, bool Commands = false);
public sealed record SecurityPermissions(bool View, bool Operate, bool Design, bool Publish, bool GatewayAdmin, bool Commands = false);
public sealed record SecurityGatewayCapabilities(bool Diagnostics = false, bool Configuration = false, bool Backups = false, bool Audit = false, bool Sessions = false)
{
    [JsonIgnore] public bool Any => Diagnostics || Configuration || Backups || Audit || Sessions;
}
public sealed record SecurityUser(string Id, string Username, string DisplayName, bool GatewayAdmin, bool Disabled,
    long Revision, IReadOnlyDictionary<string, SecurityProjectGrant> ProjectGrants, string CreatedAt, string UpdatedAt, SecurityGatewayCapabilities? GatewayCapabilities = null);
public sealed record SecuritySettings(long Revision, string? PublicBaseUrl, IReadOnlyDictionary<string, string[]> ProjectTagPrefixes);
public sealed record SecurityAuditEntry(string Id, string RecordedAt, string Actor, string Action, string? ProjectId,
    string Outcome, string? TargetUserId, string? Resource = null);
public sealed record SecuritySession(string Id, string UserId, long UserRevision, string Audience, string CsrfToken, DateTimeOffset ExpiresAt,
    string? AdministrationId = null, DateTimeOffset CreatedAt = default, DateTimeOffset LastActivityAt = default);
public sealed record SessionInventoryItem(string Id, string Username, string DisplayName, string Audience,
    DateTimeOffset CreatedAt, DateTimeOffset LastActivityAt, DateTimeOffset ExpiresAt);
public sealed record SecurityCreateUser(string Username, string Password, string? DisplayName = null, bool GatewayAdmin = false,
    bool Disabled = false, Dictionary<string, SecurityProjectGrant>? ProjectGrants = null, SecurityGatewayCapabilities? GatewayCapabilities = null);
public sealed record SecurityUpdateUser(long Revision, string? DisplayName, bool GatewayAdmin, bool Disabled,
    Dictionary<string, SecurityProjectGrant>? ProjectGrants, string? Password = null, SecurityGatewayCapabilities? GatewayCapabilities = null);
public sealed record SecurityUpdateSettings(long Revision, string? PublicBaseUrl, Dictionary<string, string[]>? ProjectTagPrefixes);

/// <summary>Gateway-owned identities and grants. Password hashes never leave this store.</summary>
public sealed class SecurityStore
{
    private sealed record StoredUser(SecurityUser User, string PasswordHash);
    private sealed record StoredState(int Version, List<StoredUser> Users, SecuritySettings Settings);
    private sealed record Throttle(int Failures, DateTimeOffset Since, DateTimeOffset? BlockedUntil);
    private readonly object gate = new();
    private readonly SemaphoreSlim passwordSlots = new(4, 4);
    private readonly Queue<DateTimeOffset> loginAdmissions = new();
    private readonly string directory;
    private readonly string statePath;
    private readonly string setupPath;
    private readonly string auditPath;
    private readonly PasswordHasher<SecurityUser> hasher = new(Options.Create(new PasswordHasherOptions { IterationCount = 210_000 }));
    private readonly SecurityUser dummyUser = new("dummy", "dummy", "dummy", false, true, 1,
        new Dictionary<string, SecurityProjectGrant>(), "", "");
    private readonly string dummyHash;
    private StoredState state;
    private readonly Dictionary<string, SecuritySession> sessions = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Throttle> throttles = new(StringComparer.Ordinal);
    private static readonly Regex UsernamePattern = new(@"\A[A-Za-z0-9._-]{3,64}\z", RegexOptions.CultureInvariant);
    private static readonly Regex ProjectPattern = new(@"\A[a-z][a-z0-9-]{0,63}\z", RegexOptions.CultureInvariant);
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    { UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow };

    public SecurityStore(string dataDirectory, string? publicBaseUrl = null)
    {
        directory = Path.Combine(Path.GetFullPath(dataDirectory), "security");
        Directory.CreateDirectory(directory);
        RejectLink(directory);
        RestrictDirectory(directory);
        statePath = Path.Combine(directory, "identities.json");
        setupPath = Path.Combine(directory, "setup-code.txt");
        auditPath = Path.Combine(directory, "audit.jsonl");
        dummyHash = hasher.HashPassword(dummyUser, RandomToken());
        if (File.Exists(statePath))
        {
            RejectLink(statePath);
            state = JsonSerializer.Deserialize<StoredState>(File.ReadAllText(statePath), JsonOptions)
                ?? throw new InvalidOperationException("The gateway identity store could not be read.");
            if (state.Version != 1 || state.Users.Count == 0 || state.Users.Count > 1000
                || !state.Users.Any(item => item.User.GatewayAdmin && !item.User.Disabled)
                || state.Users.Select(item => item.User.Id).Distinct(StringComparer.Ordinal).Count() != state.Users.Count
                || state.Users.Select(item => item.User.Username).Distinct(StringComparer.OrdinalIgnoreCase).Count() != state.Users.Count)
                throw new InvalidOperationException("The gateway identity store is invalid. Restore its local backup before continuing.");
            foreach (var item in state.Users)
            {
                ValidateUsername(item.User.Username);
                ValidateGrants(item.User.ProjectGrants);
                if (item.User.Revision < 1 || string.IsNullOrWhiteSpace(item.PasswordHash))
                    throw new InvalidOperationException("The gateway identity store is invalid.");
            }
            ValidateSettings(state.Settings.PublicBaseUrl, state.Settings.ProjectTagPrefixes);
            // A leftover code after a crash is inert once an identity store exists.
            if (File.Exists(setupPath)) { RejectLink(setupPath); File.Delete(setupPath); }
        }
        else
        {
            var settings = new SecuritySettings(1, NormalizeBaseUrl(publicBaseUrl), new Dictionary<string, string[]>(StringComparer.Ordinal));
            state = new StoredState(1, [], settings);
            if (File.Exists(setupPath))
            {
                RejectLink(setupPath);
                var code = File.ReadAllText(setupPath).Trim();
                if (code.Length != 43 || code.Any(c => !(char.IsAsciiLetterOrDigit(c) || c is '-' or '_')))
                    throw new InvalidOperationException("The local gateway setup code is invalid.");
                RestrictFile(setupPath);
            }
            else WriteAtomic(setupPath, RandomToken() + Environment.NewLine);
        }
    }

    public bool SetupRequired { get { lock (gate) return state.Users.Count == 0; } }
    public SecuritySettings Settings { get { lock (gate) return CopySettings(state.Settings); } }
    public long SettingsRevision { get { lock (gate) return state.Settings.Revision; } }
    public bool CanReadProjectTag(string projectId, string path)
    {
        lock (gate) return state.Settings.ProjectTagPrefixes.TryGetValue(projectId, out var prefixes)
            && prefixes.Any(prefix => prefix == "*" || (prefix.EndsWith('/') ? path.StartsWith(prefix, StringComparison.Ordinal) : path == prefix));
    }
    public IReadOnlyList<SecurityUser> Users { get { lock (gate) return state.Users.Select(item => CopyUser(item.User)).ToArray(); } }
    public SecurityUser? GetUser(string id)
    {
        lock (gate)
        {
            var user = state.Users.FirstOrDefault(item => item.User.Id == id)?.User;
            return user is null || user.Disabled ? null : CopyUser(user);
        }
    }

    public SecurityPermissions GetPermissions(SecurityUser? user, string? projectId)
    {
        lock (gate)
        {
            // Re-read the account for long-lived streams and request-local snapshots.
            var current = user is null ? null : state.Users.FirstOrDefault(item => item.User.Id == user.Id)?.User;
            if (current is null || current.Disabled || current.Revision != user!.Revision) return new(false, false, false, false, false);
            if (current.GatewayAdmin) return new(true, true, true, true, true, true);
            var grant = projectId is not null && current.ProjectGrants.TryGetValue(projectId, out var value) ? value : new();
            return new(grant.View, grant.Operate, grant.Design, grant.Publish, false, grant.Commands);
        }
    }

    public SecurityGatewayCapabilities GetGatewayCapabilities(SecurityUser? user)
    {
        lock (gate)
        {
            var current = user is null ? null : state.Users.FirstOrDefault(item => item.User.Id == user.Id)?.User;
            if (current is null || current.Disabled || current.Revision != user!.Revision) return new();
            return current.GatewayAdmin ? new(true, true, true, true, true) : current.GatewayCapabilities ?? new();
        }
    }

    public bool Can(SecurityUser? user, string? projectId, string permission)
    {
        var grants = GetPermissions(user, projectId);
        var gateway = GetGatewayCapabilities(user);
        return permission switch
        {
            "view" => grants.View, "operate" => grants.Operate, "design" => grants.Design,
            "publish" => grants.Publish && grants.Design, "command" => grants.Commands && grants.Operate && grants.View,
            "gatewayAdmin" => grants.GatewayAdmin, "gateway" => gateway.Any,
            "diagnostics" => gateway.Diagnostics, "configuration" => gateway.Configuration, "backups" => gateway.Backups,
            "audit" => gateway.Audit, "sessions" => gateway.Sessions, _ => false
        };
    }

    public SecurityUser Setup(string code, SecurityCreateUser request)
    {
        lock (gate)
        {
            if (state.Users.Count != 0) throw new BadHttpRequestException("Gateway setup has already been completed.", 409);
            var savedCode = File.ReadAllText(setupPath).Trim();
            if (!SecretEquals(savedCode, code))
            {
                Audit(null, "security.setup", null, "denied");
                throw new BadHttpRequestException("The local setup code is incorrect.", 403);
            }
            var user = NewUser(request with { GatewayAdmin = true, Disabled = false, ProjectGrants = [] });
            Audit(user.User, "security.setup", null, "started", user.User.Id);
            Commit(state with { Users = [user] });
            File.Delete(setupPath);
            Audit(user.User, "security.setup", null, "allowed", user.User.Id);
            return CopyUser(user.User);
        }
    }

    public SecurityUser Login(string? username, string? password, string remoteAddress)
    {
        var normalized = username is { Length: <= 64 } ? username.ToUpperInvariant() : "invalid";
        // A hostile remote client must not lock an account out at every other workstation.
        var accountKey = "account:" + normalized + "@" + remoteAddress;
        var addressKey = "address:" + remoteAddress;
        StoredUser? stored;
        lock (gate)
        {
            var now = DateTimeOffset.UtcNow;
            CheckThrottle(accountKey, now);
            CheckThrottle(addressKey, now);
            while (loginAdmissions.TryPeek(out var first) && now - first >= TimeSpan.FromSeconds(10)) loginAdmissions.Dequeue();
            if (loginAdmissions.Count >= 100) throw new BadHttpRequestException("Gateway sign-in rate limit reached. Try again shortly.", 429);
            loginAdmissions.Enqueue(now);
            stored = state.Users.FirstOrDefault(item => string.Equals(item.User.Username, username, StringComparison.OrdinalIgnoreCase));
        }
        if (!passwordSlots.Wait(0)) throw new BadHttpRequestException("Gateway sign-in is busy. Try again shortly.", 429);
        try
        {
            var user = stored?.User ?? dummyUser;
            var candidate = password is { Length: <= 256 } ? password : "";
            var result = hasher.VerifyHashedPassword(user, stored?.PasswordHash ?? dummyHash, candidate);
            var replacementHash = result == PasswordVerificationResult.SuccessRehashNeeded ? hasher.HashPassword(user, candidate) : null;
            lock (gate)
            {
            var now = DateTimeOffset.UtcNow;
            // Password work is outside the lock; a concurrent reset/disable invalidates this attempt.
            if (stored is not null && !ReferenceEquals(state.Users.FirstOrDefault(item => item.User.Id == user.Id), stored))
                throw new BadHttpRequestException("The account changed. Sign in again.", 401);
            if (stored is null || stored.User.Disabled || password is null || password.Length > 256 || result == PasswordVerificationResult.Failed)
            {
                FailThrottle(accountKey, now, 5);
                FailThrottle(addressKey, now, 25);
                Audit(null, "auth.login", null, "denied");
                throw new BadHttpRequestException("The username or password is incorrect, or this account is unavailable.", 401);
            }
            throttles.Remove(accountKey);
            if (result == PasswordVerificationResult.SuccessRehashNeeded)
            {
                var replacement = stored with { PasswordHash = replacementHash! };
                Commit(state with { Users = state.Users.Select(item => item.User.Id == user.Id ? replacement : item).ToList() });
            }
            return CopyUser(user);
            }
        }
        finally { passwordSlots.Release(); }
    }

    public bool ChangePassword(SecurityUser actor, SecuritySession session, string? currentPassword, string? newPassword, string remoteAddress)
    {
        StoredUser existing;
        var accountKey = "account:" + actor.Username.ToUpperInvariant() + "@" + remoteAddress;
        var addressKey = "address:" + remoteAddress;
        lock (gate)
        {
            var authenticated = ResolveSession(session.Id, session.Audience);
            if (authenticated is null || authenticated.Value.User.Id != actor.Id || authenticated.Value.User.Revision != actor.Revision)
                throw new BadHttpRequestException("Sign in again to continue.", 401);
            existing = state.Users.Single(item => item.User.Id == actor.Id);
            var now = DateTimeOffset.UtcNow;
            CheckThrottle(accountKey, now);
            CheckThrottle(addressKey, now);
        }
        if (!passwordSlots.Wait(0)) throw new BadHttpRequestException("Gateway password verification is busy. Try again shortly.", 429);
        try
        {
            var candidate = currentPassword is { Length: <= 256 } ? currentPassword : "";
            var verified = hasher.VerifyHashedPassword(existing.User, existing.PasswordHash, candidate);
            if (currentPassword is null || currentPassword.Length > 256 || verified == PasswordVerificationResult.Failed)
            {
                lock (gate)
                {
                    var now = DateTimeOffset.UtcNow;
                    FailThrottle(accountKey, now, 5);
                    FailThrottle(addressKey, now, 25);
                }
                throw new BadHttpRequestException("The current password is incorrect.", 400);
            }
            ValidatePassword(newPassword);
            if (SecretEquals(currentPassword, newPassword)) throw new ArgumentException("Choose a new password different from your current password.");
            var user = existing.User with { Revision = checked(existing.User.Revision + 1), UpdatedAt = Now() };
            var replacement = new StoredUser(user, hasher.HashPassword(user, newPassword!));
            lock (gate)
            {
            // Recheck after hashing: logout, disable and concurrent resets cannot reuse an old request.
            var authenticated = ResolveSession(session.Id, session.Audience);
            if (authenticated is null || authenticated.Value.User.Id != actor.Id || authenticated.Value.User.Revision != actor.Revision
                || !ReferenceEquals(state.Users.FirstOrDefault(item => item.User.Id == actor.Id), existing))
                throw new BadHttpRequestException("Sign in again to continue.", 401);
            Commit(state with { Users = state.Users.Select(item => item.User.Id == user.Id ? replacement : item).ToList() });
            foreach (var ticket in sessions.Values.Where(item => item.UserId == user.Id).ToArray()) sessions.Remove(ticket.Id);
            throttles.Remove(accountKey);
            return true;
            }
        }
        finally { passwordSlots.Release(); }
    }

    public SecurityUser CreateUser(SecurityCreateUser request)
    {
        lock (gate)
        {
            if (state.Users.Count == 0) throw new BadHttpRequestException("Complete local gateway setup first.", 409);
            if (state.Users.Count >= 1000) throw new ArgumentException("A gateway supports at most 1,000 accounts.");
            var stored = NewUser(request);
            Commit(state with { Users = [.. state.Users, stored] });
            return CopyUser(stored.User);
        }
    }

    public SecurityUser UpdateUser(string id, SecurityUpdateUser request)
    {
        lock (gate)
        {
            var existing = state.Users.FirstOrDefault(item => item.User.Id == id) ?? throw new KeyNotFoundException("Account not found.");
            if (existing.User.Revision != request.Revision) throw new BadHttpRequestException("This account changed. Reload before saving.", 409);
            var grants = ValidateGrants(request.ProjectGrants ?? new Dictionary<string, SecurityProjectGrant>());
            var user = existing.User with { DisplayName = DisplayName(request.DisplayName, existing.User.Username),
                GatewayAdmin = request.GatewayAdmin, Disabled = request.Disabled, ProjectGrants = grants, GatewayCapabilities = request.GatewayCapabilities ?? existing.User.GatewayCapabilities ?? new(),
                Revision = checked(existing.User.Revision + 1), UpdatedAt = Now() };
            if (existing.User.GatewayAdmin && !existing.User.Disabled && (!user.GatewayAdmin || user.Disabled)
                && !state.Users.Any(item => item.User.Id != id && item.User.GatewayAdmin && !item.User.Disabled))
                throw new BadHttpRequestException("The last enabled gateway administrator cannot be disabled or demoted.", 409);
            var passwordHash = existing.PasswordHash;
            if (!string.IsNullOrEmpty(request.Password))
            {
                ValidatePassword(request.Password);
                passwordHash = hasher.HashPassword(user, request.Password);
            }
            var replacement = new StoredUser(user, passwordHash);
            Commit(state with { Users = state.Users.Select(item => item.User.Id == id ? replacement : item).ToList() });
            foreach (var session in sessions.Values.Where(item => item.UserId == id).ToArray()) sessions.Remove(session.Id);
            if (!string.IsNullOrEmpty(request.Password))
                foreach (var key in throttles.Keys.Where(key => key.StartsWith("account:" + user.Username.ToUpperInvariant() + "@", StringComparison.Ordinal)).ToArray()) throttles.Remove(key);
            return CopyUser(user);
        }
    }

    public SecuritySettings UpdateSettings(SecurityUpdateSettings request)
    {
        lock (gate)
        {
            if (state.Settings.Revision != request.Revision) throw new BadHttpRequestException("Security settings changed. Reload before saving.", 409);
            var settings = ValidateSettings(request.PublicBaseUrl, request.ProjectTagPrefixes ?? new Dictionary<string, string[]>());
            settings = settings with { Revision = checked(state.Settings.Revision + 1) };
            Commit(state with { Settings = settings });
            return CopySettings(settings);
        }
    }

    public SecuritySession CreateSession(SecurityUser user, string audience)
    {
        GatewaySecurity.ValidateAudience(audience);
        lock (gate)
        {
            var current = state.Users.FirstOrDefault(item => item.User.Id == user.Id)?.User;
            if (current is null || current.Disabled || current.Revision != user.Revision)
                throw new BadHttpRequestException("Sign in again to continue.", 401);
            var now = DateTimeOffset.UtcNow;
            foreach (var expired in sessions.Values.Where(session => session.ExpiresAt <= now).ToArray()) sessions.Remove(expired.Id);
            if (sessions.Count >= 10_000) throw new BadHttpRequestException("Too many active sessions. Try again later.", 429);
            var session = new SecuritySession(RandomToken(), user.Id, user.Revision, audience, RandomToken(), now.AddHours(8),
                Guid.NewGuid().ToString("N"), now, now);
            sessions.Add(session.Id, session);
            return session;
        }
    }

    public (SecuritySession Session, SecurityUser User)? ResolveSession(string? id, string audience)
    {
        lock (gate)
        {
            if (id is null || !sessions.TryGetValue(id, out var session) || session.Audience != audience) return null;
            var user = state.Users.FirstOrDefault(item => item.User.Id == session.UserId)?.User;
            if (session.ExpiresAt <= DateTimeOffset.UtcNow || user is null || user.Disabled || user.Revision != session.UserRevision)
            { sessions.Remove(id); return null; }
            session = session with { LastActivityAt = DateTimeOffset.UtcNow };
            sessions[id] = session;
            return (session, CopyUser(user));
        }
    }

    public void RevokeSession(string? id) { if (id is not null) lock (gate) sessions.Remove(id); }

    // Administration handles are unrelated to authentication/CSRF secrets.
    public IReadOnlyList<SessionInventoryItem> SessionInventory()
    {
        lock (gate)
        {
            var now = DateTimeOffset.UtcNow;
            return sessions.Values.Where(session => session.ExpiresAt > now && session.AdministrationId is not null)
                .Select(session => (Session: session, User: state.Users.FirstOrDefault(item => item.User.Id == session.UserId)?.User))
                .Where(item => item.User is not null && !item.User.Disabled && item.User.Revision == item.Session.UserRevision)
                .Select(item => new SessionInventoryItem(item.Session.AdministrationId!, item.User!.Username, item.User.DisplayName,
                    item.Session.Audience, item.Session.CreatedAt, item.Session.LastActivityAt, item.Session.ExpiresAt))
                .OrderByDescending(item => item.LastActivityAt).ToArray();
        }
    }

    public bool RevokeManagedSession(string administrationId)
    {
        if (!Guid.TryParseExact(administrationId, "N", out _)) throw new ArgumentException("Invalid session administration ID.");
        lock (gate)
        {
            var session = sessions.Values.FirstOrDefault(item => item.AdministrationId == administrationId);
            return session is not null && sessions.Remove(session.Id);
        }
    }

    public void Audit(SecurityUser? actor, string action, string? projectId, string outcome, string? targetUserId = null, string? resource = null)
    {
        // Callers supply event identifiers, never form contents or credentials.
        if (action.Length > 100 || action.Any(char.IsControl) || outcome.Length > 32 || outcome.Any(char.IsControl))
            throw new ArgumentException("Invalid security audit event.");
        if (resource is { Length: > 512 } || resource?.Any(char.IsControl) == true)
            throw new ArgumentException("Invalid security audit resource.");
        var entry = new SecurityAuditEntry(Guid.NewGuid().ToString("N"), Now(), actor?.Username ?? "anonymous", action,
            projectId, outcome, targetUserId, resource);
        lock (gate)
        {
            if (File.Exists(auditPath))
            {
                RejectLink(auditPath);
                if (new FileInfo(auditPath).Length >= 5 * 1024 * 1024)
                {
                    var previous = auditPath + ".previous";
                    if (File.Exists(previous)) RejectLink(previous);
                    File.Move(auditPath, previous, true);
                }
            }
            File.AppendAllText(auditPath, JsonSerializer.Serialize(entry, JsonOptions) + "\n", new UTF8Encoding(false));
            RestrictFile(auditPath);
        }
    }

    public IReadOnlyList<SecurityAuditEntry> ReadAudit(int limit = 100)
    {
        if (limit is < 1 or > 500) throw new ArgumentException("Audit limit must be between 1 and 500.");
        lock (gate)
        {
            var items = new Queue<SecurityAuditEntry>();
            foreach (var path in new[] { auditPath + ".previous", auditPath })
            {
                if (!File.Exists(path)) continue;
                RejectLink(path);
                foreach (var line in File.ReadLines(path))
                {
                    if (string.IsNullOrWhiteSpace(line)) continue;
                    try
                    {
                        var item = JsonSerializer.Deserialize<SecurityAuditEntry>(line, JsonOptions);
                        if (item is not null) { items.Enqueue(item); if (items.Count > limit) items.Dequeue(); }
                    }
                    catch (JsonException) { /* A interrupted final append must not hide earlier audit events. */ }
                }
            }
            return items.Reverse().ToArray();
        }
    }

    public static bool SecretEquals(string? expected, string? supplied)
    {
        if (expected is null || supplied is null || supplied.Length > 1024) return false;
        return CryptographicOperations.FixedTimeEquals(SHA256.HashData(Encoding.UTF8.GetBytes(expected)), SHA256.HashData(Encoding.UTF8.GetBytes(supplied)));
    }

    private StoredUser NewUser(SecurityCreateUser request)
    {
        ValidateUsername(request.Username);
        ValidatePassword(request.Password);
        if (state.Users.Any(item => string.Equals(item.User.Username, request.Username, StringComparison.OrdinalIgnoreCase)))
            throw new ArgumentException("That username is already in use.");
        var now = Now();
        var user = new SecurityUser(Guid.NewGuid().ToString("N"), request.Username, DisplayName(request.DisplayName, request.Username),
            request.GatewayAdmin, request.Disabled, 1, ValidateGrants(request.ProjectGrants ?? new Dictionary<string, SecurityProjectGrant>()), now, now, request.GatewayCapabilities ?? new());
        return new(user, hasher.HashPassword(user, request.Password));
    }

    private static void ValidateUsername(string? username)
    {
        if (username is null || !UsernamePattern.IsMatch(username)) throw new ArgumentException("Username must contain 3–64 letters, numbers, periods, underscores or hyphens.");
    }
    private static void ValidatePassword(string? password)
    {
        if (password is null || password.Length is < 12 or > 256) throw new ArgumentException("Password must contain 12–256 characters.");
    }
    private static string DisplayName(string? displayName, string username)
    {
        var value = string.IsNullOrWhiteSpace(displayName) ? username : displayName.Trim();
        if (value.Length > 100 || value.Any(char.IsControl)) throw new ArgumentException("Display name must contain at most 100 characters, without control characters.");
        return value;
    }
    private static Dictionary<string, SecurityProjectGrant> ValidateGrants(IReadOnlyDictionary<string, SecurityProjectGrant> grants)
    {
        if (grants.Count > 1000) throw new ArgumentException("At most 1,000 project grants are supported.");
        var result = new Dictionary<string, SecurityProjectGrant>(StringComparer.Ordinal);
        foreach (var (id, grant) in grants)
        {
            if (!ProjectPattern.IsMatch(id) || grant is null) throw new ArgumentException("Project grants contain an invalid project or permission.");
            var normalized = grant.Commands ? grant with { Operate = true, View = true } : grant;
            if (normalized.Operate && !normalized.View) throw new ArgumentException("Operate permission requires View permission.");
            if (grant.Publish && !grant.Design) throw new ArgumentException("Publish permission requires Design permission.");
            result.Add(id, normalized);
        }
        return result;
    }
    private static SecuritySettings ValidateSettings(string? baseUrl, IReadOnlyDictionary<string, string[]> prefixes)
    {
        if (prefixes.Count > 1000) throw new ArgumentException("At most 1,000 project tag scopes are supported.");
        var result = new Dictionary<string, string[]>(StringComparer.Ordinal);
        foreach (var (id, values) in prefixes)
        {
            if (!ProjectPattern.IsMatch(id) || values is null || values.Length > 100) throw new ArgumentException("Invalid project tag scope.");
            if (values.Any(value => string.IsNullOrWhiteSpace(value) || value.Length > 512 || value.Any(char.IsControl)))
                throw new ArgumentException("Tag prefixes must contain 1–512 characters without control characters. Use an empty list to deny access.");
            if (values.Distinct(StringComparer.Ordinal).Count() != values.Length) throw new ArgumentException("Tag prefixes must be unique.");
            result.Add(id, [.. values]);
        }
        return new(1, NormalizeBaseUrl(baseUrl), result);
    }
    private static string? NormalizeBaseUrl(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        if (value.Length > 2048 || !Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.UserInfo.Length != 0
            || uri.Query.Length != 0 || uri.Fragment.Length != 0 || uri.AbsolutePath != "/"
            || (uri.Scheme != "https" && !(uri.Scheme == "http" && (uri.Host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
                || IPAddress.TryParse(uri.Host.Trim('[', ']'), out var ip) && IPAddress.IsLoopback(ip)))))
            throw new ArgumentException("Public base URL must be an HTTPS origin, or an HTTP origin on localhost, without a path, credentials, query or fragment.");
        return uri.GetLeftPart(UriPartial.Authority);
    }
    private static SecurityUser CopyUser(SecurityUser user) => user with { ProjectGrants = new Dictionary<string, SecurityProjectGrant>(user.ProjectGrants, StringComparer.Ordinal) };
    private static SecuritySettings CopySettings(SecuritySettings settings) => settings with { ProjectTagPrefixes = settings.ProjectTagPrefixes.ToDictionary(item => item.Key, item => item.Value.ToArray(), StringComparer.Ordinal) };
    private static string RandomToken() => Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private static string Now() => DateTimeOffset.UtcNow.ToString("O");
    private void Commit(StoredState next) { WriteAtomic(statePath, JsonSerializer.Serialize(next, JsonOptions)); state = next; }
    private void WriteAtomic(string path, string content)
    {
        if (File.Exists(path)) RejectLink(path);
        var temporary = Path.Combine(directory, Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                RestrictFile(temporary);
                var bytes = Encoding.UTF8.GetBytes(content);
                stream.Write(bytes);
                stream.Flush(true);
            }
            File.Move(temporary, path, true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
    private void CheckThrottle(string key, DateTimeOffset now)
    {
        if (!throttles.TryGetValue(key, out var value)) return;
        if (value.BlockedUntil > now) throw new BadHttpRequestException("Too many sign-in attempts. Try again in 15 minutes.", 429);
        if (now - value.Since >= TimeSpan.FromMinutes(15)) throttles.Remove(key);
    }
    private void FailThrottle(string key, DateTimeOffset now, int limit)
    {
        if (throttles.Count >= 10_000 && !throttles.ContainsKey(key))
            foreach (var old in throttles.OrderBy(item => item.Value.Since).Take(1000).Select(item => item.Key).ToArray()) throttles.Remove(old);
        var previous = throttles.GetValueOrDefault(key) ?? new(0, now, null);
        var count = previous.Failures + 1;
        throttles[key] = new(count, previous.Since, count >= limit ? now.AddMinutes(15) : null);
    }
    private static void RejectLink(string path)
    {
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("Gateway security files cannot be symbolic links.");
    }
    private static void RestrictDirectory(string path)
    {
        if (OperatingSystem.IsWindows())
        {
            var owner = WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException("The gateway service identity is unavailable.");
            var security = new DirectorySecurity();
            security.SetAccessRuleProtection(true, false);
            foreach (var identity in new[] { owner, new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null), new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null) })
                security.AddAccessRule(new FileSystemAccessRule(identity, FileSystemRights.FullControl,
                    InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
            new DirectoryInfo(path).SetAccessControl(security);
        }
        else File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
    }
    private static void RestrictFile(string path)
    {
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    }
}
