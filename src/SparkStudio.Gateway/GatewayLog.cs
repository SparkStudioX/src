namespace SparkStudio.Gateway;

internal static class GatewayLog
{
    internal static readonly Action<ILogger, Exception?> ProcessConfigurationUnavailable = LoggerMessage.Define(LogLevel.Error, new EventId(0), "Process data configuration is unavailable; other gateway services remain available");
    internal static readonly Action<ILogger, Exception?> ProcessStorageUnavailable = LoggerMessage.Define(LogLevel.Error, new EventId(0), "Process data storage is unavailable; no files were deleted and other gateway services remain available");
    internal static readonly Action<ILogger, Exception?> ProcessConfigurationWriteFailed = LoggerMessage.Define(LogLevel.Error, new EventId(0), "Process data configuration storage update failed");
    internal static readonly Action<ILogger, Exception?> ProcessSampleWriteFailed = LoggerMessage.Define(LogLevel.Error, new EventId(0), "Process data sample could not be persisted");
    internal static readonly Action<ILogger, string, string, Exception?> ProjectStartFailed = LoggerMessage.Define<string, string>(LogLevel.Error, new EventId(0), "Project {ProjectId} could not start ({ErrorType}); other projects remain available.");
    internal static readonly Action<ILogger, Exception?> ScriptHistoryReadFailed = LoggerMessage.Define(LogLevel.Error, new EventId(0), "Could not load script execution history");
    internal static readonly Action<ILogger, string, Exception?> ScriptQueueFailed = LoggerMessage.Define<string>(LogLevel.Warning, new EventId(0), "Gateway event {ResourceId} was not queued");
    internal static readonly Action<ILogger, string, Exception?> ScriptEventFailed = LoggerMessage.Define<string>(LogLevel.Error, new EventId(0), "Script event {ResourceId} stopped unexpectedly");
    internal static readonly Action<ILogger, Exception?> ScriptHistoryWriteFailed = LoggerMessage.Define(LogLevel.Error, new EventId(0), "Could not persist script execution history");
    internal static readonly Action<ILogger, string, Exception?> SourceSynchronizationFailed = LoggerMessage.Define<string>(LogLevel.Warning, new EventId(0), "Source lifecycle synchronization failed ({ErrorType}).");
    internal static readonly Action<ILogger, string, Exception?> SourceDiscoveryRejected = LoggerMessage.Define<string>(LogLevel.Warning, new EventId(0), "Automatic source discovery rejected a transaction ({ErrorType}).");
    internal static readonly Action<ILogger, string, Exception?> TagSubscriberFailed = LoggerMessage.Define<string>(LogLevel.Warning, new EventId(0), "Tag event subscriber failed ({ErrorType}).");
    internal static readonly Action<ILogger, string, Exception?> RemovedTransportCleanupFailed = LoggerMessage.Define<string>(LogLevel.Warning, new EventId(0), "A removed connection's transport cleanup failed ({ErrorType}).");
    internal static readonly Action<ILogger, string, Exception?> MemoryTagCheckpointFailed = LoggerMessage.Define<string>(LogLevel.Error, new EventId(0), "Memory tag checkpoint failed ({ErrorType}); the in-memory values remain active.");
    internal static readonly Action<ILogger, int, string, Exception?> DeviceGroupCapacityReached = LoggerMessage.Define<int, string>(LogLevel.Warning, new EventId(0), "Device acquisition group capacity (32) reached; {TagCount} tags in connection {ConnectionId} cannot acquire.");
    internal static readonly Action<ILogger, string, Exception?> TagAcquisitionLoopFailed = LoggerMessage.Define<string>(LogLevel.Error, new EventId(0), "Tag acquisition loop failed ({ErrorType}); local acquisition is being retired.");
    internal static readonly Action<ILogger, string, Exception?> DeviceAcquisitionFailed = LoggerMessage.Define<string>(LogLevel.Warning, new EventId(0), "Device acquisition failed ({ErrorType}); a new acquisition will be attempted.");
}
