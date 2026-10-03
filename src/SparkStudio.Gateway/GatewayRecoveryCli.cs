using System.Text.Json;

namespace SparkStudio.Gateway;

/// <summary>Offline commands run before ASP.NET, stores, connectors or scripts are initialized.</summary>
public static class GatewayRecoveryCli
{
    private static readonly JsonSerializerOptions ReportJson = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    public static bool IsRequested(string[] args) => args.Any(argument => argument.Equals("--recovery", StringComparison.OrdinalIgnoreCase)
        || argument.StartsWith("--recovery=", StringComparison.OrdinalIgnoreCase));

    public static async Task<int> RunAsync(string[] args)
    {
        using var cancellation = new CancellationTokenSource();
        ConsoleCancelEventHandler interrupt = (_, value) => { value.Cancel = true; cancellation.Cancel(); };
        try
        {
            var options = ParseOptions(args);
            var action = options["recovery"];
            if (!options.TryGetValue("archive", out var archive)) throw new ArgumentException("Specify --archive with an explicit .sparkbak path.");
            if (action != "inspect" && !options.ContainsKey("data-dir")) throw new ArgumentException("Backup and restore require an explicit --data-dir path.");
            if (action == "inspect" && options.ContainsKey("data-dir")) throw new ArgumentException("Inspect does not accept a data directory or extract data.");
            var passphrase = ReadPassphrase(options.GetValueOrDefault("passphrase-env"));
            // Before the passphrase is read there is nothing to clean up; retain
            // the terminal's normal Ctrl+C behavior instead of trapping ReadKey.
            Console.CancelKeyPress += interrupt;
            var report = action switch
            {
                "backup" => await GatewayRecovery.BackupAsync(options["data-dir"], archive, passphrase, cancellation.Token),
                "inspect" => await GatewayRecovery.InspectAsync(archive, passphrase, cancellation.Token),
                "restore" => await GatewayRecovery.RestoreAsync(archive, options["data-dir"], passphrase, cancellation.Token),
                _ => throw new ArgumentException("Recovery action must be backup, inspect or restore.")
            };
            Console.WriteLine(JsonSerializer.Serialize(new { action, verified = true, quarantined = action == "restore", report }, ReportJson));
            return 0;
        }
        catch (OperationCanceledException) { Console.Error.WriteLine("Recovery was cancelled; no existing data directory was replaced."); return 130; }
        catch (Exception error) when (error is ArgumentException or InvalidOperationException or InvalidDataException or IOException or UnauthorizedAccessException or System.Security.Cryptography.CryptographicException)
        { Console.Error.WriteLine("Recovery failed: " + error.Message); return 1; }
        finally { Console.CancelKeyPress -= interrupt; }
    }

    internal static Dictionary<string, string> ParseOptions(string[] args)
    {
        if (args.Length % 2 != 0) throw new ArgumentException("Recovery options must be --name value pairs. Passphrases must never be supplied as arguments.");
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var pair in args.Chunk(2))
        {
            var name = pair[0].StartsWith("--", StringComparison.Ordinal) ? pair[0][2..] : "";
            if (name is not ("recovery" or "data-dir" or "archive" or "passphrase-env") || string.IsNullOrWhiteSpace(pair[1]) || !result.TryAdd(name, pair[1]))
                throw new ArgumentException("Unknown, empty or duplicate recovery option.");
        }
        if (result.GetValueOrDefault("recovery") is not ("backup" or "inspect" or "restore")) throw new ArgumentException("Recovery action must be backup, inspect or restore.");
        return result;
    }

    private static string ReadPassphrase(string? environmentName)
    {
        if (environmentName is not null)
        {
            if (environmentName.Length > 128 || environmentName.Any(character => !char.IsAsciiLetterOrDigit(character) && character != '_'))
                throw new ArgumentException("Passphrase environment variable names must contain only letters, digits and underscores.");
            var value = Environment.GetEnvironmentVariable(environmentName);
            Environment.SetEnvironmentVariable(environmentName, null); // Do not propagate it to any subsequent child process.
            return ValidatePassphrase(value);
        }
        var characters = new char[1025]; var count = 0;
        try
        {
            if (!Console.IsInputRedirected) Console.Error.Write("Recovery passphrase: ");
            while (true)
            {
                var value = Console.IsInputRedirected ? Console.Read() : ReadConsoleCharacter();
                if (value is -1 or '\n' or '\r') break;
                if (value == '\b') { if (count > 0) characters[--count] = '\0'; continue; }
                if (count >= 1024) throw new ArgumentException("Recovery passphrase exceeds 1024 characters.");
                characters[count++] = (char)value;
            }
            if (!Console.IsInputRedirected) Console.Error.WriteLine();
            return ValidatePassphrase(new string(characters, 0, count));
        }
        finally { Array.Clear(characters); }
    }
    private static int ReadConsoleCharacter()
    {
        var key = Console.ReadKey(intercept: true);
        return key.Key == ConsoleKey.Enter ? '\n' : key.Key == ConsoleKey.Backspace ? '\b' : key.KeyChar;
    }
    private static string ValidatePassphrase(string? value)
    {
        if (value is null || value.Length is < 12 or > 1024) throw new ArgumentException("Supply a recovery passphrase of 12–1024 characters through stdin or the named environment variable.");
        return value;
    }
}
