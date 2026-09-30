using System.Diagnostics;
using System.Text.Json;
using System.Xml.Linq;

internal static class TestReport
{
    public static async Task RunAsync(string name, string[] args, IEnumerable<(string Name, Func<Task<int>> Run)> suites)
    {
        var results = new List<Result>();
        foreach (var (suiteName, run) in suites)
        {
            var clock = Stopwatch.StartNew();
            try
            {
                var checks = await run();
                results.Add(new(suiteName, checks, clock.Elapsed.TotalSeconds, null));
                Console.WriteLine($"PASS {suiteName}: {checks} checks");
            }
            catch (Exception error)
            {
                error = error is System.Reflection.TargetInvocationException { InnerException: { } inner } ? inner : error;
                results.Add(new(suiteName, 0, clock.Elapsed.TotalSeconds, error.ToString()));
                Console.Error.WriteLine($"FAIL {suiteName}: {error}");
            }
        }
        var failures = results.Count(result => result.Error is not null);
        Console.WriteLine($"{name}: {results.Count} suites, {results.Sum(result => result.Checks)} passing checks, {failures} failed suites.");
        var index = Array.IndexOf(args, "--results");
        if (index >= 0)
        {
            if (index + 1 >= args.Length) throw new ArgumentException("--results needs a JSON output path.");
            var output = Path.GetFullPath(args[index + 1]);
            Directory.CreateDirectory(Path.GetDirectoryName(output)!);
            File.WriteAllText(output, JsonSerializer.Serialize(new { name, failures, suites = results }, new JsonSerializerOptions { WriteIndented = true }));
            new XDocument(new XElement("testsuite", new XAttribute("name", name), new XAttribute("tests", results.Count), new XAttribute("failures", failures),
                results.Select(result => new XElement("testcase", new XAttribute("name", result.Name), new XAttribute("time", result.Seconds),
                    result.Error is null ? null : new XElement("failure", result.Error))))).Save(Path.ChangeExtension(output, ".xml"));
        }
        Environment.ExitCode = failures == 0 ? 0 : 1;
    }

    private sealed record Result(string Name, int Checks, double Seconds, string? Error);
}
