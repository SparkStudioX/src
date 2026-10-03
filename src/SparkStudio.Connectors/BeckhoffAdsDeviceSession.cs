using System.Net.NetworkInformation;
using System.Text.Json;
using System.Text.RegularExpressions;
using TwinCAT;
using TwinCAT.Ads;
using TwinCAT.Ads.Configuration;
using TwinCAT.Ads.TcpRouter;
using TwinCAT.Ads.TypeSystem;
using TwinCAT.TypeSystem;

namespace SparkStudio.Connectors;

public sealed class BeckhoffAdsDeviceSession : IDeviceSession
{
    private readonly DeviceSettings settings;
    private readonly SemaphoreSlim opening = new(1, 1);
    private AdsRouterLease? router;
    private bool disposed;

    public BeckhoffAdsDeviceSession(ConnectionDefinition connection)
    {
        settings = connection.Device ?? throw new ArgumentException("ADS device settings are required.");
        _ = new AmsNetId(settings.LocalAmsNetId); _ = new AmsNetId(settings.TargetAmsNetId);
        foreach (var point in settings.Points) ValidatePoint(point);
    }

    public static void ValidatePoint(DevicePoint point)
    {
        DeviceScalarCodec.NativeLayout(point);
        if (!Regex.IsMatch(point.Address, @"^[A-Za-z_][A-Za-z0-9_]*(?:\[\d+(?:,\d+)*\])?(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\[\d+(?:,\d+)*\])?)*$", RegexOptions.CultureInvariant))
            throw new ArgumentException("Use an ADS symbol path such as MAIN.Speed or MAIN.Values[0].");
    }

    private async Task<AdsClient> OpenAsync(CancellationToken cancellation)
    {
        ObjectDisposedException.ThrowIf(disposed, this);
        await opening.WaitAsync(cancellation);
        try
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            router ??= await AdsRouterLease.AcquireAsync(settings, cancellation);
        }
        finally { opening.Release(); }
        // Direct AdsClient without session/resurrection interceptors: no failed-write replay.
        var client = new AdsClient(new AdsClientSettings(settings.TimeoutMs));
        client.SetCommunicationInterceptor(new CommunicationInterceptors());
        try
        {
            await client.ConnectAsync(new AmsNetId(settings.TargetAmsNetId), settings.Port, cancellation);
            if (client.SourceAddress.NetId.ToString() != settings.LocalAmsNetId)
                throw new InvalidOperationException("The active ADS router has a different local AMS Net ID. Use its configured identity or stop it before using a gateway-managed router.");
            Check(await client.ReadStateAsync(cancellation));
            return client;
        }
        catch { client.Dispose(); throw; }
    }

    private static void Check(ResultAds result)
    {
        if (!result.Succeeded) throw new InvalidOperationException($"The ADS operation failed with status {result.ErrorCode}.");
    }

    public Task TestAsync(CancellationToken cancellation) => DeviceScalarCodec.SdkAsync(() => TestCoreAsync(cancellation), "ADS");
    private async Task TestCoreAsync(CancellationToken cancellation)
    {
        using var deadline = DeviceScalarCodec.Deadline(settings.TimeoutMs, cancellation);
        using var client = await OpenAsync(deadline.Token);
    }

    public Task<IReadOnlyList<BrowseNode>> BrowseAsync(string? parent, CancellationToken cancellation) =>
        DeviceScalarCodec.SdkAsync(() => BrowseCoreAsync(parent, cancellation), "ADS");
    private async Task<IReadOnlyList<BrowseNode>> BrowseCoreAsync(string? parent, CancellationToken cancellation)
    {
        ObjectDisposedException.ThrowIf(disposed, this); cancellation.ThrowIfCancellationRequested();
        if (parent == "@configured") return DeviceConfiguration.Map(settings);
        using var deadline = DeviceScalarCodec.Deadline(settings.TimeoutMs, cancellation);
        using var client = await OpenAsync(deadline.Token);
        var loader = SymbolLoaderFactory.Create(client, new SymbolLoaderSettings(SymbolsLoadMode.VirtualTree)
        { AutomaticReconnection = false, ExpandArrayValues = false });
        try
        {
            var loaded = await loader.GetSymbolsAsync(deadline.Token);
            Check(loaded);
            IEnumerable<ISymbol> symbols = loaded.Symbols ?? throw new InvalidOperationException("The ADS server returned no symbol catalog.");
            if (!string.IsNullOrEmpty(parent))
            {
                var queue = new Queue<ISymbol>(symbols);
                ISymbol? selected = null;
                var visited = 0;
                while (queue.TryDequeue(out var symbol))
                {
                    deadline.Token.ThrowIfCancellationRequested();
                    if (++visited > 10000) throw new InvalidOperationException("The ADS catalog exceeds the 10000-symbol browse limit.");
                    if (symbol.InstancePath == parent) { selected = symbol; break; }
                    if (parent.StartsWith(symbol.InstancePath + ".", StringComparison.Ordinal) || parent.StartsWith(symbol.InstancePath + "[", StringComparison.Ordinal))
                        foreach (var child in symbol.SubSymbols.Take(10001)) queue.Enqueue(child);
                }
                symbols = selected?.SubSymbols ?? throw new ArgumentException("The ADS browse parent is no longer in the symbol catalog.");
            }
            var page = symbols.Take(10001).ToArray();
            if (page.Length > 10000) throw new InvalidOperationException("The ADS catalog exceeds the 10000-symbol browse limit.");
            var result = page.Select(symbol =>
            {
                var point = settings.Points.FirstOrDefault(point => point.Address == symbol.InstancePath);
                var scalarType = NativeType(symbol);
                return new BrowseNode(symbol.InstancePath, symbol.InstanceName, !SymbolExtensions.IsContainerType(symbol),
                    point?.DataType ?? scalarType, point?.Writable == true && !symbol.IsReadOnly, "native", point?.Id,
                    symbol.InstancePath, scalarType == "String" ? symbol.ByteSize - 1 : null);
            }).ToList();
            if (string.IsNullOrEmpty(parent) && settings.Points.Count != 0)
                result.Insert(0, new("@configured", "Saved point map", false, null, false, "configured"));
            return result;
        }
        finally { (loader as IDisposable)?.Dispose(); }
    }

    private static string? NativeType(ISymbol symbol)
    {
        if (symbol is not IAdsSymbol ads || SymbolExtensions.IsContainerType(symbol) || symbol.IsPointer || symbol.IsReference) return null;
        return ads.DataTypeId.ToString() switch
        {
            "ADST_BIT" => "Boolean", "ADST_INT16" => "Int16", "ADST_UINT16" => "UInt16",
            "ADST_INT32" => "Int32", "ADST_UINT32" => "UInt32", "ADST_INT64" => "Int64",
            "ADST_REAL32" => "Float", "ADST_REAL64" => "Double", "ADST_STRING" => "String", _ => null
        };
    }

    private static async Task VerifySymbolAsync(AdsClient client, DevicePoint point, bool writing, CancellationToken token)
    {
        ValidatePoint(point);
        var result = await client.ReadSymbolAsync(point.Address, token);
        Check(result);
        var symbol = result.Value ?? throw new InvalidOperationException("The ADS server returned no symbol metadata.");
        if (NativeType(symbol) != DeviceScalarCodec.StorageType(point) || symbol.ByteSize != (DeviceScalarCodec.StorageType(point) == "String" ? point.StringLength + 1 : DeviceScalarCodec.Width(DeviceScalarCodec.StorageType(point))))
            throw new ArgumentException("The ADS symbol type or layout differs from the saved point map. Refresh its metadata after PLC changes.");
        if (writing && symbol.IsReadOnly) throw new ArgumentException("The ADS symbol is read-only.");
    }

    public Task<IReadOnlyList<ConnectorValue>> ReadAsync(IReadOnlyList<DevicePoint> points, CancellationToken cancellation) =>
        DeviceScalarCodec.SdkAsync(() => ReadCoreAsync(points, cancellation), "ADS");
    private async Task<IReadOnlyList<ConnectorValue>> ReadCoreAsync(IReadOnlyList<DevicePoint> points, CancellationToken cancellation)
    {
        using var deadline = DeviceScalarCodec.Deadline(settings.TimeoutMs, cancellation);
        using var client = await OpenAsync(deadline.Token);
        var values = new List<ConnectorValue>();
        foreach (var point in points)
        {
            deadline.Token.ThrowIfCancellationRequested();
            uint handle = 0;
            try
            {
                await VerifySymbolAsync(client, point, false, deadline.Token);
                var created = await client.CreateVariableHandleAsync(point.Address, deadline.Token); Check(created); handle = created.Handle;
                var result = await client.ReadAnyAsync(handle, DeviceScalarCodec.ClrType(DeviceScalarCodec.StorageType(point)),
                    point.DataType == "String" ? [point.StringLength] : [], deadline.Token);
                Check(result);
                values.Add(new(point.Id, DeviceScalarCodec.Decode(point, result.Value ?? throw new InvalidOperationException("The ADS server returned no value.")), point.DataType, "Good", DateTimeOffset.UtcNow));
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !deadline.IsCancellationRequested)
            { values.Add(DeviceScalarCodec.Bad(point, ex)); }
            finally { if (handle != 0) await ReleaseHandleAsync(client, handle); }
        }
        return values;
    }

    private static async Task ReleaseHandleAsync(AdsClient client, uint handle)
    {
        // Cleanup is bounded independently: a canceled read must still release its PLC handle.
        using var cleanup = new CancellationTokenSource(TimeSpan.FromMilliseconds(500));
        try { await client.DeleteVariableHandleAsync(handle, cleanup.Token); }
        catch { /* Disposing the client closes the owning ADS port if the device cannot acknowledge cleanup. */ }
    }

    public Task<string> WriteAsync(DevicePoint point, JsonElement value, Action? beforeDispatch, CancellationToken cancellation) =>
        DeviceScalarCodec.SdkAsync(() => WriteCoreAsync(point, value, beforeDispatch, cancellation), "ADS");
    private async Task<string> WriteCoreAsync(DevicePoint point, JsonElement value, Action? beforeDispatch, CancellationToken cancellation)
    {
        if (!point.Writable) throw new ArgumentException("This point does not permit writes.");
        var raw = DeviceScalarCodec.Encode(point, value);
        using var deadline = DeviceScalarCodec.Deadline(settings.TimeoutMs, cancellation);
        using var client = await OpenAsync(deadline.Token);
        await VerifySymbolAsync(client, point, true, deadline.Token);
        var created = await client.CreateVariableHandleAsync(point.Address, deadline.Token); Check(created);
        try
        {
            deadline.Token.ThrowIfCancellationRequested(); beforeDispatch?.Invoke();
            var result = await client.WriteAnyAsync(created.Handle, raw, point.DataType == "String" ? [point.StringLength] : [], deadline.Token);
            Check(result); // Failures after this boundary remain uncertain to the command coordinator.
            return "Good";
        }
        finally { await ReleaseHandleAsync(client, created.Handle); }
    }

    public void Dispose()
    {
        disposed = true;
        router?.Dispose(); router = null;
    }
}

// Shared ownership prevents one connection from stopping peers or silently changing their Net ID.
internal sealed class AdsRouterLease : IDisposable
{
    private static readonly SemaphoreSlim gate = new(1, 1);
    private static AmsTcpIpRouter? shared;
    private static CancellationTokenSource? lifetime;
    private static Task? running;
    private static readonly Dictionary<string, (string Host, int Count)> routes = new(StringComparer.Ordinal);
    private readonly string target;
    private readonly bool managed;
    private bool disposed;

    private AdsRouterLease(string target, bool managed) { this.target = target; this.managed = managed; }

    internal static async Task<AdsRouterLease> AcquireAsync(DeviceSettings settings, CancellationToken cancellation)
    {
        await gate.WaitAsync(cancellation);
        try
        {
            if (shared is null && IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners().Any(endpoint => endpoint.Port == 48898))
                return new(settings.TargetAmsNetId, false); // Existing router and back-route are administrator-managed.
            if (shared is null)
            {
                shared = new AmsTcpIpRouter(new AmsNetId(settings.LocalAmsNetId));
                lifetime = new CancellationTokenSource();
                running = shared.StartAsync(lifetime.Token);
                try
                {
                    while (!shared.IsRunning)
                    {
                        if (running.IsCompleted) { await running; throw new InvalidOperationException("The gateway ADS router did not start."); }
                        await Task.Delay(20, cancellation);
                    }
                }
                catch { StopRouter(); throw; }
            }
            if (shared!.NetId?.ToString() != settings.LocalAmsNetId)
                throw new ArgumentException("Active ADS connections must share one local AMS Net ID.");
            if (routes.TryGetValue(settings.TargetAmsNetId, out var route))
            {
                if (!string.Equals(route.Host, settings.Host, StringComparison.OrdinalIgnoreCase))
                    throw new ArgumentException("This target AMS Net ID already has an active route to another host.");
                routes[settings.TargetAmsNetId] = (route.Host, route.Count + 1);
            }
            else
            {
                try { shared.AddRoute(new Route("SparkStudio-" + settings.TargetAmsNetId, new AmsNetId(settings.TargetAmsNetId), settings.Host)); }
                catch { if (routes.Count == 0) StopRouter(); throw; }
                routes.Add(settings.TargetAmsNetId, (settings.Host, 1));
            }
            return new(settings.TargetAmsNetId, true);
        }
        finally { gate.Release(); }
    }

    private static void StopRouter()
    {
        lifetime?.Cancel(); shared?.Stop();
        if (running is not null) _ = running.ContinueWith(task => _ = task.Exception, TaskContinuationOptions.OnlyOnFaulted);
        lifetime?.Dispose(); lifetime = null; shared = null; running = null;
    }

    public void Dispose()
    {
        if (disposed) return; disposed = true;
        if (!managed) return;
        gate.Wait();
        try
        {
            if (!routes.TryGetValue(target, out var route)) return;
            if (route.Count > 1) routes[target] = (route.Host, route.Count - 1);
            else { routes.Remove(target); shared?.RemoveRoute(new AmsNetId(target)); }
            if (routes.Count == 0) StopRouter();
        }
        finally { gate.Release(); }
    }
}
