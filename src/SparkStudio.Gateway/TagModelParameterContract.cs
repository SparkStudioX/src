using System.Text.Json;
using System.Text.RegularExpressions;

namespace SparkStudio.Gateway;

/// <summary>Model parameter names and placeholders use the same authored contract in the browser and gateway.</summary>
internal static class TagModelParameterContract
{
    private static readonly (string NameFragment, int MaximumPlaceholders) Contract = Load();
    internal static readonly Regex Name = Pattern("^" + Contract.NameFragment + "$");
    internal static readonly Regex Placeholder = Pattern(@"\{(" + Contract.NameFragment + @")\}");
    internal static int MaximumPlaceholders => Contract.MaximumPlaceholders;

    private static Regex Pattern(string pattern) => new(pattern, RegexOptions.CultureInvariant | RegexOptions.NonBacktracking, TimeSpan.FromMilliseconds(100));
    private static (string NameFragment, int MaximumPlaceholders) Load()
    {
        using var stream = typeof(TagModelParameterContract).Assembly.GetManifestResourceStream("SparkStudio.ModelParameterContract.json")
            ?? throw new InvalidOperationException("The model parameter contract is missing.");
        using var document = JsonDocument.Parse(stream);
        var root = document.RootElement;
        if (root.GetProperty("version").GetInt32() != 1) throw new InvalidOperationException("The model parameter contract version is unsupported.");
        return (root.GetProperty("nameFragment").GetString()!, root.GetProperty("maximumPlaceholders").GetInt32());
    }
}
