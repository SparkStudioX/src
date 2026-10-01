using System.Collections.Concurrent;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using SparkStudio.Gateway;

static void Check(bool value, string message) { if (!value) throw new Exception(message); }
static async Task Reject(Func<Task> action, string name)
{
    try { await action(); } catch (Exception error) when (error is ArgumentException or IOException or InvalidOperationException or OperationCanceledException or TimeoutException) { Check(!error.ToString().Contains("fixture-password"), "Destination error leaked credentials or a raw server reply."); return; }
    throw new Exception("Expected rejection: " + name);
}
var fixture = Path.Combine(AppContext.BaseDirectory, "fixture"); Directory.CreateDirectory(fixture);
var source = Path.Combine(fixture, "source"); Directory.CreateDirectory(source); File.WriteAllText(Path.Combine(source, "projects.json"), "{\"synthetic\":true}");
var archive = Path.Combine(fixture, "encrypted.sparkbak");
await GatewayRecovery.BackupAsync(source, archive, "synthetic-backup-fixture-passphrase");
var payload = File.ReadAllBytes(archive); var owner = Guid.NewGuid();
var old = BackupDestinations.CreateArchiveName(owner, DateTimeOffset.UtcNow.AddDays(-8), Guid.NewGuid());
var fresh = BackupDestinations.CreateArchiveName(owner, DateTimeOffset.UtcNow.AddDays(-1), Guid.NewGuid());
var foreign = BackupDestinations.CreateArchiveName(Guid.NewGuid(), DateTimeOffset.UtcNow.AddDays(-20), Guid.NewGuid());
var badDate = old.Replace(old.Split('-')[2], "20261399T999999999Z");
string NewName() => BackupDestinations.CreateArchiveName(owner, DateTimeOffset.UtcNow, Guid.NewGuid());
Check(BackupDestinations.IsOwnedArchiveName(old, owner) && !BackupDestinations.IsOwnedArchiveName(foreign, owner) && !BackupDestinations.IsOwnedArchiveName(badDate, owner), "Owned archive date/identity checks failed.");
foreach (var invalid in new[] { "../" + old, "nested/" + old, ".\\" + old, old + ".partial", old.ToUpperInvariant(), "x" + old }) Check(!BackupDestinations.IsOwnedArchiveName(invalid, owner), "Unsafe retention name accepted.");
BackupDestinations.Validate(new("smb", @"\\fixture-server\share\backups", "fixture", null, "fixture-domain"));
BackupDestinations.Validate(new("smb", @"\\fixture-server\share"));
BackupDestinations.Validate(new("ftp", "ftp://localhost:2121/backups/", "fixture", AllowInsecureFtp: true));
foreach (var invalid in new[] {
    new BackupDestination("smb", @"C:\backups"), new("ftp", "ftp://localhost:2121/backups/", "fixture"), new("smb", @"\\?\UNC\host\share"), new("smb", @"\\host\share\..\secret"),
    new("smb", @"\\host\share", "a\\b", "pw", "domain"), new("smb", @"\\host\share", "\\b", "pw"),
    new("ftp", "ftp://user:password@localhost/path/", "fixture"), new("ftp", "ftp://localhost/path/../other/", "fixture"),
    new("ftp", "ftp://localhost/%2e%2e/", "fixture"), new("ftps", "ftps://localhost/", "fixture"), new("ftp", "ftp://localhost/"),
    new("ftp", "ftp://localhost/", "fixture", TimeoutSeconds: 29), new("ftp", "ftp://localhost/", "fixture", TimeoutSeconds: 3601) })
    await Reject(() => Task.Run(() => BackupDestinations.Validate(invalid)), "destination validation");
Check(!new BackupDestination("ftp", "ftp://localhost/", "fixture", "fixture-password").ToString().Contains("fixture-password"), "Credential DTO ToString exposed password.");
Console.WriteLine("PASS archive ownership, malformed names, destination validation and credential separation");
var remote = Path.Combine(fixture, "remote"); Directory.CreateDirectory(remote);
foreach (var name in new[] { old, fresh, foreign, badDate, old + ".partial", "operator-notes.txt" }) File.WriteAllBytes(Path.Combine(remote, name), [1,2,3]);
var delivered = NewName();
var result = await BackupDestinations.DeliverDirectoryFixtureAsync(remote, archive, delivered, owner, 7, default);
Check(result.RemovedCount == 1 && result.RetentionWarning is null && !File.Exists(Path.Combine(remote, old)), "Local retention failed.");
Check(File.ReadAllBytes(Path.Combine(remote, delivered)).SequenceEqual(payload) && result.Sha256 == Convert.ToHexString(SHA256.HashData(payload)).ToLowerInvariant(), "Local copy/digest differs.");
Check(new[] { fresh, foreign, badDate, old + ".partial", "operator-notes.txt" }.All(name => File.Exists(Path.Combine(remote, name))), "Unowned archive removed.");
await Reject(() => BackupDestinations.DeliverDirectoryFixtureAsync(remote, archive, delivered, owner, 7, default), "existing final archive");
Console.WriteLine("PASS ordinary-file upload, verified bytes, atomic promotion and owner-only age retention");
var directoryOld = BackupDestinations.CreateArchiveName(owner, DateTimeOffset.UtcNow.AddDays(-9), Guid.NewGuid()); Directory.CreateDirectory(Path.Combine(remote, directoryOld));
result = await BackupDestinations.DeliverDirectoryFixtureAsync(remote, archive, NewName(), owner, 7, default);
Check(result.RetentionWarning is not null && Directory.Exists(Path.Combine(remote, directoryOld)), "Retention failure lost delivered outcome or removed directory.");
Console.WriteLine("PASS post-promotion retention failure reports successful delivery with warning");

await using var ftp = new FtpFixture();
BackupDestination Target(string kind = "ftp") => new(kind, $"ftp://127.0.0.1:{ftp.Port}/backups/", "fixture-user", "fixture-password", TimeoutSeconds: 30, AllowInsecureFtp: kind == "ftp");
void Seed() { ftp.Files.Clear(); ftp.Commands.Clear(); ftp.ResetPromotion(); foreach (var name in new[] { old, fresh, foreign, badDate }) ftp.Files[name] = [1,2,3]; ftp.ExtraListing = new[] { "../" + old, "nested/" + old, "./" + old, "operator-notes.txt" }; }
Seed(); delivered = NewName(); result = await BackupDestinations.DeliverAsync(Target(), archive, delivered, owner);
Check(result.RemovedCount == 1 && ftp.Files[delivered].SequenceEqual(payload) && !ftp.Files.ContainsKey(old) && ftp.Files.ContainsKey(fresh) && ftp.Files.ContainsKey(foreign) && ftp.Files.ContainsKey(badDate), "FTP delivery/retention differs.");
var commands = ftp.Commands.ToArray();
Check(Array.FindIndex(commands, value => value.StartsWith("RETR ")) < Array.FindIndex(commands, value => value.StartsWith("RNTO ")) && Array.FindIndex(commands, value => value.StartsWith("RNTO ")) < Array.FindIndex(commands, value => value == "DELE backups/" + old), "FTP verification/promotion/prune order differs.");
Check(commands.Where(value => value.StartsWith("DELE ")).All(value => value == "DELE backups/" + old), "FTP deleted nested or unrelated filename.");
Console.WriteLine("PASS actual FTP upload/readback/rename protocol and exact-name retention filtering");
Seed(); ftp.CorruptReadback = true; delivered = NewName();
await Reject(() => BackupDestinations.DeliverAsync(Target(), archive, delivered, owner), "corrupt readback");
Check(ftp.Files.ContainsKey(old) && !ftp.Files.ContainsKey(delivered) && !ftp.Commands.Any(value => value == "DELE backups/" + old), "Corrupt upload pruned previous backup or promoted file."); ftp.CorruptReadback = false;
Seed(); ftp.RejectUpload = true;
await Reject(() => BackupDestinations.DeliverAsync(Target(), archive, NewName(), owner), "rejected upload");
Check(ftp.Files.ContainsKey(old) && !ftp.Commands.Any(value => value == "DELE backups/" + old), "Failed upload pruned previous backup."); ftp.RejectUpload = false;
Console.WriteLine("PASS corrupted same-size readback and failed upload preserve previous archives");
Seed(); ftp.ExtraListing = [new string('x', 1024 * 1024 + 1)];
await Reject(() => BackupDestinations.DeliverAsync(Target(), archive, NewName(), owner), "oversized listing");
Check(!ftp.Commands.Any(value => value.StartsWith("STOR ") || value.StartsWith("DELE ")), "Oversized listing started transfer/pruning.");
Seed(); ftp.StallReadback = true;
using (var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(500)))
{
    var watch = System.Diagnostics.Stopwatch.StartNew(); await Reject(() => BackupDestinations.DeliverAsync(Target(), archive, NewName(), owner, cancellationToken: cancellation.Token), "stalled readback");
    Check(watch.Elapsed < TimeSpan.FromSeconds(5) && ftp.Files.ContainsKey(old), "Stalled transfer was not cancelled or pruned previous backup.");
}
ftp.StallReadback = false;
Console.WriteLine("PASS bounded directory listing and full-transfer cancellation");
Seed(); ftp.StallRetention = true; delivered = NewName();
using (var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(600)))
{
    result = await BackupDestinations.DeliverAsync(Target(), archive, delivered, owner, cancellationToken: cancellation.Token);
    Check(result.RetentionWarning is not null && ftp.Files.ContainsKey(delivered) && ftp.Files.ContainsKey(old), "Cancellation after promotion misreported upload failure.");
}
ftp.StallRetention = false;
Console.WriteLine("PASS cancelled retention preserves committed delivery result");
Seed(); delivered = NewName();
await Reject(() => BackupDestinations.DeliverAsync(Target("ftps"), archive, delivered, owner), "untrusted FTPS certificate");
Check(!ftp.Commands.Any(value => value.StartsWith("USER ") || value.StartsWith("PASS ") || value.StartsWith("STOR ") || value.StartsWith("DELE ")), "FTPS sent credentials/data after certificate rejection.");
Console.WriteLine("PASS explicit FTPS fails closed before credentials for untrusted fixture certificate");
await BackupS3Checks.RunAsync(archive, payload, owner, old, fresh, foreign, badDate);
Console.WriteLine("Backup destination and S3 fixture groups passed.");

sealed class FtpFixture : IAsyncDisposable
{
    private readonly TcpListener control = new(IPAddress.Loopback, 0);
    private readonly CancellationTokenSource stop = new();
    private readonly List<Task> clients = [];
    private readonly Task accept;
    private readonly X509Certificate2 certificate;
    public ConcurrentDictionary<string, byte[]> Files { get; } = new(StringComparer.Ordinal);
    public ConcurrentQueue<string> Commands { get; } = new();
    public string[] ExtraListing = [];
    public bool CorruptReadback, RejectUpload, StallReadback, StallRetention;
    private int promoted;
    public void ResetPromotion() => Interlocked.Exchange(ref promoted, 0);
    public int Port => ((IPEndPoint)control.LocalEndpoint).Port;
    public FtpFixture()
    {
        using var rsa = RSA.Create(2048); var request = new CertificateRequest("CN=untrusted-backup-fixture", rsa, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        using var issued = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(1));
        certificate = X509CertificateLoader.LoadPkcs12(issued.Export(X509ContentType.Pfx), null, X509KeyStorageFlags.EphemeralKeySet);
        control.Start(); accept = Accept();
    }
    private async Task Accept()
    {
        try { while (!stop.IsCancellationRequested) { var client = await control.AcceptTcpClientAsync(stop.Token); lock (clients) clients.Add(Handle(client)); } }
        catch (OperationCanceledException) { } catch (SocketException) when (stop.IsCancellationRequested) { }
    }
    private async Task Handle(TcpClient client)
    {
        using (client)
        {
            Stream stream = client.GetStream(); StreamReader reader = new(stream, Encoding.ASCII, false, 1024, true); StreamWriter writer = new(stream, Encoding.ASCII, 1024, true) { AutoFlush = true, NewLine = "\r\n" };
            TcpListener? passive = null; string? rename = null;
            async Task Reply(string text) => await writer.WriteLineAsync(text);
            try
            {
                await Reply("220 synthetic fixture");
                while (!stop.IsCancellationRequested)
                {
                    var line = await reader.ReadLineAsync(stop.Token); if (line is null) break;
                    var split = line.IndexOf(' '); var verb = (split < 0 ? line : line[..split]).ToUpperInvariant(); var arg = split < 0 ? "" : line[(split + 1)..];
                    if (verb is not "PASS") Commands.Enqueue(line); // never record the synthetic password either
                    if (verb is "STOR" or "RETR" or "RNFR" or "RNTO" or "DELE") { if (!arg.StartsWith("backups/") || arg[8..].Contains('/')) throw new Exception("Unexpected fixture file path"); arg = arg[8..]; }
                    switch (verb)
                    {
                        case "AUTH":
                            await Reply("234 TLS accepted");
                            var secure = new SslStream(stream, false); await secure.AuthenticateAsServerAsync(new SslServerAuthenticationOptions { ServerCertificate = certificate, EnabledSslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13 }, stop.Token);
                            stream = secure; reader = new(stream, Encoding.ASCII, false, 1024, true); writer = new(stream, Encoding.ASCII, 1024, true) { AutoFlush = true, NewLine = "\r\n" }; break;
                        case "USER": await Reply("331 password required"); break;
                        case "PASS": await Reply("230 logged in"); break;
                        case "OPTS": case "TYPE": case "CWD": case "PBSZ": case "PROT": await Reply("200 accepted"); break;
                        case "SYST": await Reply("215 UNIX Type: L8"); break;
                        case "FEAT": await Reply("211 no features"); break;
                        case "PWD": await Reply("257 \"/\" is current directory"); break;
                        case "PASV":
                            passive?.Stop(); passive = new(IPAddress.Loopback, 0); passive.Start(); var port = ((IPEndPoint)passive.LocalEndpoint).Port;
                            await Reply($"227 Entering Passive Mode (127,0,0,1,{port / 256},{port % 256})"); break;
                        case "NLST": case "STOR": case "RETR":
                            if (verb == "STOR" && RejectUpload) { await Reply("550 fixture-password synthetic rejected upload"); break; }
                            if (passive is null) { await Reply("425 passive required"); break; }
                            await Reply("150 data ready"); using (var data = await passive.AcceptTcpClientAsync(stop.Token))
                            {
                                await using var content = data.GetStream();
                                if (verb == "NLST")
                                {
                                    if (StallRetention && Volatile.Read(ref promoted) > 0) await Task.Delay(Timeout.Infinite, stop.Token);
                                    var listing = Encoding.UTF8.GetBytes(string.Join("\r\n", Files.Keys.Concat(ExtraListing)) + "\r\n"); await content.WriteAsync(listing, stop.Token);
                                }
                                else if (verb == "STOR") { using var bytes = new MemoryStream(); await content.CopyToAsync(bytes, stop.Token); Files[arg] = bytes.ToArray(); }
                                else
                                {
                                    if (StallReadback) await Task.Delay(Timeout.Infinite, stop.Token);
                                    var bytes = Files[arg].ToArray(); if (CorruptReadback) bytes[^1] ^= 0xff; await content.WriteAsync(bytes, stop.Token);
                                }
                            }
                            passive.Stop(); passive = null; await Reply("226 transfer complete"); break;
                        case "RNFR": rename = arg; await Reply("350 ready to rename"); break;
                        case "RNTO":
                            if (rename is null || Files.ContainsKey(arg) || !Files.TryRemove(rename, out var value)) await Reply("550 rename rejected");
                            else { Files[arg] = value; Interlocked.Increment(ref promoted); await Reply("250 renamed"); } break;
                        case "DELE": Files.TryRemove(arg, out _); await Reply("250 deleted"); break;
                        case "QUIT": await Reply("221 goodbye"); return;
                        default: throw new Exception("Unexpected FTP command: " + verb);
                    }
                }
            }
            catch (Exception error) when (error is IOException or SocketException or OperationCanceledException or AuthenticationException) { }
            finally { passive?.Stop(); await stream.DisposeAsync(); }
        }
    }
    public async ValueTask DisposeAsync()
    {
        stop.Cancel(); control.Stop(); await accept; Task[] running; lock (clients) running = clients.ToArray();
        await Task.WhenAll(running); certificate.Dispose(); stop.Dispose();
    }
}
