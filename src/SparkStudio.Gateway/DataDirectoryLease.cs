namespace SparkStudio.Gateway;

/// <summary>Cooperating gateways and offline recovery commands hold this for their whole operation.</summary>
public sealed class DataDirectoryLease : IDisposable
{
    public const string FileName = ".sparkstudio-data.lock";
    private readonly FileStream stream;
    private DataDirectoryLease(FileStream stream) => this.stream = stream;

    public static DataDirectoryLease Acquire(string directory, bool createDirectory = true)
    {
        directory = Path.GetFullPath(directory);
        RecoveryFileSystem.RejectLinks(directory);
        if (createDirectory) Directory.CreateDirectory(directory);
        else if (!Directory.Exists(directory)) throw new DirectoryNotFoundException("The gateway data directory does not exist.");
        var path = Path.Combine(directory, FileName);
        RecoveryFileSystem.RejectLinks(path);
        try
        {
            var stream = new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            try { RecoveryFileSystem.CheckOrdinaryFile(stream); return new DataDirectoryLease(stream); }
            catch { stream.Dispose(); throw; }
        }
        catch (IOException error)
        {
            throw new InvalidOperationException("The gateway data directory is already in use or cannot be exclusively locked. Stop the gateway and all other writers before offline recovery.", error);
        }
    }

    // Do not delete the lock file: another process may have acquired this same
    // inode/file immediately after close. Removing it would create two owners.
    public void Dispose() => stream.Dispose();
}
