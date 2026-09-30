namespace SparkStudio.Gateway;

/// <summary>
/// Synchronous configuration stores share one reentrant monitor. A configuration
/// snapshot holds it only while capturing local bytes, never while encrypting or
/// transferring an archive. Store operations must not await while holding it.
/// </summary>
public static class GatewayConfigurationLock
{
    public static object SyncRoot { get; } = new();
}
