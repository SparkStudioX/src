using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace SparkStudio.Gateway;

/// <summary>Offline caption translations only. Input values, IDs and action parameters stay authored.</summary>
internal static class ProjectLocalizationValidator
{
    private static readonly Regex Locale = new("^(?:en|es|fr|de|it|pt)(?:-(?:[A-Z]{2}|[0-9]{3}))?\\z", RegexOptions.CultureInvariant);
    private static readonly Regex Key = new("^[A-Za-z][A-Za-z0-9_.-]{0,63}\\z", RegexOptions.CultureInvariant);
    private static readonly Regex Token = new(@"\{([^{}]+)\}", RegexOptions.CultureInvariant);

    public static void ValidateProject(JsonObject project)
    {
        JsonObject? messages = null;
        var defaultLocale = "";
        if (project.ContainsKey("localization"))
        {
            if (project["localization"] is not JsonObject catalog || catalog.Any(pair => pair.Key is not ("defaultLocale" or "locales" or "messages")))
                throw new ArgumentException("Localization needs only defaultLocale, locales and messages.");
            if (catalog["locales"] is not JsonArray languages || languages.Count is < 1 or > 8)
                throw new ArgumentException("Choose 1–8 unique en, es, fr, de, it or pt language codes, optionally with a region such as en-US or es-MX.");
            var locales = new HashSet<string>(StringComparer.Ordinal);
            foreach (var language in languages)
                if (!Text(language, out var locale) || !Locale.IsMatch(locale) || !locales.Add(locale))
                    throw new ArgumentException("Choose 1–8 unique en, es, fr, de, it or pt language codes, optionally with a region such as en-US or es-MX.");
            if (!Text(catalog["defaultLocale"], out defaultLocale) || !locales.Contains(defaultLocale))
                throw new ArgumentException("The default language must be one of the declared languages.");
            if (catalog["messages"] is not JsonObject definitions || definitions.Count > 500)
                throw new ArgumentException("A project can contain at most 500 translation messages.");
            messages = definitions;
            var total = 0;
            foreach (var (key, translations) in messages)
            {
                if (!Key.IsMatch(key)) throw new ArgumentException("Message keys need 1–64 letters, numbers, dots, dashes or underscores, beginning with a letter.");
                if (translations is not JsonObject entries || !entries.ContainsKey(defaultLocale) || entries.Any(pair => !locales.Contains(pair.Key)))
                    throw new ArgumentException($"Message {key} needs a default translation and can only contain declared languages.");
                foreach (var entry in entries)
                {
                    if (!Text(entry.Value, out var text) || string.IsNullOrWhiteSpace(text) || text.Length > 2048 || text.Any(character => char.IsControl(character) && character is not ('\t' or '\r' or '\n')))
                        throw new ArgumentException("Translations need 1–2048 characters without control characters other than tabs and line breaks.");
                    total += text.Length;
                    if (total > 262144) throw new ArgumentException("Translation text exceeds the project limit of 262144 characters.");
                    if (!Text(entries[defaultLocale], out var defaultText) || !Tokens(defaultText).SequenceEqual(Tokens(text)))
                        throw new ArgumentException($"Every translation of {key} must preserve its parameter tokens.");
                }
            }
        }
        foreach (var component in ProjectTemplates.Components(project))
        {
            if (component["props"] is not JsonObject props || !props.ContainsKey("textKey")) continue;
            if (!Text(props["textKey"], out var key) || messages is null || messages[key] is not JsonObject translations)
                throw new ArgumentException("An assigned caption translation is missing.");
            if (ProjectStore.Optional(component, "type") == "passwordInput") throw new ArgumentException("Password controls do not support caption translation keys.");
            if (!Text(translations[defaultLocale], out var translated) || !Tokens(ProjectStore.Optional(props, "text") ?? "").SequenceEqual(Tokens(translated)))
                throw new ArgumentException("Caption translation parameters must match the authored caption.");
        }
    }
    private static string[] Tokens(string text)
    {
        var remainder = Token.Replace(text, "");
        if (remainder.Contains('{') || remainder.Contains('}')) throw new ArgumentException("Caption parameters need matching braces.");
        return Token.Matches(text).Select(match => match.Groups[1].Value).OrderBy(value => value, StringComparer.Ordinal).ToArray();
    }
    private static bool Text(JsonNode? node, out string value)
    {
        value = "";
        return node is JsonValue scalar && scalar.TryGetValue<string>(out value!);
    }
}
