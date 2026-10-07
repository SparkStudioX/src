using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using SparkStudio.Connectors;

namespace SparkStudio.Connectors.AnyLog;

/// <summary>Builds the AnyLog REST command and reads its JSON rows. The SELECT text is the caller's statement.</summary>
public static class AnyLogCommands
{
    public const string UnreachableMessage = "The AnyLog query node did not respond. Check the address and REST port.";
    public const int MaximumResponseBytes = 16 * 1_048_576;
    private static readonly Regex DbmsName = new(@"\A[A-Za-z_][A-Za-z0-9_]{0,63}\z", RegexOptions.CultureInvariant);

    public static (string Host, int Port, string Dbms) ReadSettings(IReadOnlyDictionary<string, string> settings)
    {
        ArgumentNullException.ThrowIfNull(settings);
        var host = Required(settings, "host").Trim();
        var dbms = Required(settings, "dbms").Trim();
        if (!int.TryParse(Required(settings, "port").Trim(), NumberStyles.None, CultureInfo.InvariantCulture, out var port))
            throw new ArgumentException("Enter a query node REST port from 1 through 65535.");
        ValidateEndpoint(host, port);
        if (!DbmsName.IsMatch(dbms)) throw new ArgumentException("Enter a DBMS name made of letters, digits and underscores.");
        return (host, port, dbms);
    }

    public static JsonObject Normalize(JsonObject connection)
    {
        var source = connection["connector"] as JsonObject ?? throw new ArgumentException("Enter the query node address, REST port and DBMS.");
        var settings = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["host"] = Setting(source, "host"),
            ["port"] = Setting(source, "port"),
            ["dbms"] = Setting(source, "dbms")
        };
        var (host, port, dbms) = ReadSettings(settings);
        return new JsonObject { ["host"] = host, ["port"] = port.ToString(CultureInfo.InvariantCulture), ["dbms"] = dbms };
    }

    public static string Prepare(string dbms, string sql, IReadOnlyList<QueryParameter> parameters)
    {
        if (!DbmsName.IsMatch(dbms)) throw new ArgumentException("Enter a DBMS name made of letters, digits and underscores.");
        var statement = SqlQueryGuard.Validate(sql).Trim();
        if (statement.EndsWith(';')) statement = statement[..^1].TrimEnd();
        statement = Bind(statement, parameters);
        return $"sql {dbms} format=json {statement}";
    }

    public static bool FitsCommandHeader(string command)
        => command.Length <= 3500 && !command.Contains('\r') && !command.Contains('\n');

    /// <summary>The query node reads the command from one HTTP header. Line breaks become spaces so the SELECT still fits.</summary>
    public static string ForHeader(string command)
    {
        var header = command.Replace("\r\n", " ", StringComparison.Ordinal).Replace('\n', ' ').Replace('\r', ' ');
        if (!FitsCommandHeader(header)) throw new ArgumentException("The AnyLog command is limited to one line of 3,500 characters.");
        return header;
    }

    public static QueryResult Parse(string body, double durationMs)
    {
        if (string.IsNullOrWhiteSpace(body)) throw new InvalidOperationException("The AnyLog query node returned an empty response.");
        var text = body.Trim();
        if (text.Length > 0 && text[0] == '\uFEFF') text = text[1..].Trim();
        JsonNode? node;
        try { node = JsonNode.Parse(text); }
        catch (JsonException) { throw new InvalidOperationException("The AnyLog query node did not return JSON rows."); }
        var rowsNode = Rows(node) ?? throw new InvalidOperationException("The AnyLog query node did not return JSON rows.");
        return ReadRows(rowsNode, durationMs);
    }

    private static string Required(IReadOnlyDictionary<string, string> settings, string name)
        => settings.TryGetValue(name, out var value) && !string.IsNullOrWhiteSpace(value) ? value : throw new ArgumentException(Missing(name));

    private static string Setting(JsonObject source, string name)
    {
        if (source[name] is JsonValue node && node.TryGetValue<string>(out var text) && !string.IsNullOrWhiteSpace(text)) return text.Trim();
        if (source[name] is JsonValue number && number.TryGetValue<int>(out var port)) return port.ToString(CultureInfo.InvariantCulture);
        throw new ArgumentException(Missing(name));
    }

    private static string Missing(string name) => name switch
    {
        "host" => "Enter the query node address.",
        "port" => "Enter a query node REST port from 1 through 65535.",
        _ => "Enter a DBMS name made of letters, digits and underscores."
    };

    public static void ValidateEndpoint(string host, int port)
    {
        if (port is < 1 or > 65535) throw new ArgumentException("Enter a query node REST port from 1 through 65535.");
        if (string.IsNullOrWhiteSpace(host) || host.Length > 253 || host.Any(char.IsWhiteSpace) || host.Contains('\\') || host.Contains('/') || host.Contains('@'))
            throw new ArgumentException("Enter a query node hostname or IP address.");
        if (host.Contains(':') && !IPAddress.TryParse(host, out _))
            throw new ArgumentException("Enter the query node address without a port. Put the REST port in its own field.");
        if (Uri.CheckHostName(host) is not (UriHostNameType.Dns or UriHostNameType.IPv4 or UriHostNameType.IPv6))
            throw new ArgumentException("Enter a query node hostname or IP address.");
    }

    private static string Bind(string sql, IReadOnlyList<QueryParameter> parameters)
    {
        var map = new Dictionary<string, QueryParameter>(StringComparer.OrdinalIgnoreCase);
        foreach (var parameter in parameters)
        {
            var name = parameter.Name.Trim().TrimStart('@');
            if (!map.TryAdd(name, parameter)) throw new ArgumentException("Duplicate SQL parameter names are not supported.");
        }
        var result = new StringBuilder(sql.Length);
        for (var i = 0; i < sql.Length; i++)
        {
            var current = sql[i];
            if (current == '\'') { i = CopyQuote(sql, i, result, '\''); continue; }
            if (current == '"') { i = CopyQuote(sql, i, result, '"'); continue; }
            if (current == '-' && i + 1 < sql.Length && sql[i + 1] == '-') { i = CopyUntil(sql, i, result, '\n'); continue; }
            if (current == '/' && i + 1 < sql.Length && sql[i + 1] == '*') { i = CopyBlock(sql, i, result); continue; }
            if (current != '@') { result.Append(current); continue; }
            var start = i;
            var name = ReadName(sql, ref i);
            if (name.Length > 0 && map.TryGetValue(name, out var parameter)) result.Append(Literal(parameter));
            else result.Append(sql, start, i - start + 1);
        }
        return result.ToString();
    }

    private static int CopyQuote(string sql, int start, StringBuilder result, char quote)
    {
        result.Append(quote);
        for (var i = start + 1; i < sql.Length; i++)
        {
            result.Append(sql[i]);
            if (sql[i] != quote) continue;
            if (i + 1 < sql.Length && sql[i + 1] == quote) { result.Append(sql[++i]); continue; }
            return i;
        }
        return sql.Length - 1;
    }

    private static int CopyUntil(string sql, int start, StringBuilder result, char end)
    {
        var stop = sql.IndexOf(end, start);
        if (stop < 0) stop = sql.Length - 1;
        result.Append(sql, start, stop - start + 1);
        return stop;
    }

    private static int CopyBlock(string sql, int start, StringBuilder result)
    {
        var stop = sql.IndexOf("*/", start + 2, StringComparison.Ordinal);
        stop = stop < 0 ? sql.Length - 1 : stop + 1;
        result.Append(sql, start, stop - start + 1);
        return stop;
    }

    private static string ReadName(string sql, ref int index)
    {
        var start = index + 1;
        var end = start;
        while (end < sql.Length && (char.IsAsciiLetterOrDigit(sql[end]) || sql[end] == '_')) end++;
        if (end == start) return "";
        index = end - 1;
        return sql[start..end];
    }

    private static string Literal(QueryParameter parameter)
    {
        var value = Scalar(parameter.Value);
        if (value is null) return "NULL";
        try
        {
            return parameter.Type.ToLowerInvariant() switch
            {
                "string" or "nvarchar" or "date" or "datetime" or "datetime2" or "datetimeoffset" or "guid" or "uniqueidentifier"
                    => Quote(Convert.ToString(value, CultureInfo.InvariantCulture) ?? ""),
                "int" or "int32" or "integer" => Convert.ToInt32(value, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture),
                "long" or "int64" or "bigint" => Convert.ToInt64(value, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture),
                "number" or "double" or "float" => Finite(Convert.ToDouble(value, CultureInfo.InvariantCulture)).ToString("G17", CultureInfo.InvariantCulture),
                "decimal" => Convert.ToDecimal(value, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture),
                "bool" or "boolean" or "bit" => Convert.ToBoolean(value, CultureInfo.InvariantCulture) ? "true" : "false",
                _ => throw new ArgumentException("Unsupported SQL parameter type.")
            };
        }
        catch (Exception error) when (error is FormatException or OverflowException or InvalidCastException)
        {
            throw new ArgumentException($"Invalid value for query parameter '{parameter.Name}' ({parameter.Type}). Check its declared type.");
        }
    }

    private static object? Scalar(object? input)
    {
        if (input is not JsonElement json) return input;
        return json.ValueKind switch
        {
            JsonValueKind.Null or JsonValueKind.Undefined => null,
            JsonValueKind.String => json.GetString(),
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.Number => json.GetRawText(),
            _ => throw new ArgumentException("SQL parameter values must be scalar values.")
        };
    }

    private static string Quote(string text)
    {
        if (text.Contains('\0')) throw new ArgumentException("SQL parameters cannot contain a NUL character.");
        if (text.Length > 1_048_576) throw new ArgumentException("SQL parameter exceeds 1 MiB.");
        return "'" + text.Replace("'", "''", StringComparison.Ordinal) + "'";
    }

    private static double Finite(double value)
        => double.IsFinite(value) ? value : throw new ArgumentException("SQL numeric parameters must be finite.");

    private static JsonArray? Rows(JsonNode? node)
    {
        if (node is JsonArray array) return array;
        if (node is not JsonObject obj) return null;
        // AnyLog returns { "Query": [ rows ], "Statistics": [ ... ] }. Statistics is not the result.
        if (obj["Query"] is JsonArray query) return query;
        return obj["query"] as JsonArray;
    }

    private static QueryResult ReadRows(JsonArray rows, double durationMs)
    {
        var columns = new List<string>();
        var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var result = new List<Dictionary<string, object?>>();
        long bytes = 0;
        foreach (var item in rows)
        {
            if (result.Count == ConnectorService.MaximumQueryRows)
                throw new InvalidOperationException($"Query exceeds {ConnectorService.MaximumQueryRows:N0} rows. Add LIMIT or a narrower WHERE clause.");
            if (item is not JsonObject row) throw new InvalidOperationException("The AnyLog query node did not return JSON rows.");
            var values = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var pair in row)
            {
                var column = Column(pair.Key, columns, used);
                var cell = Cell(pair.Value);
                bytes += cell is string text ? text.Length * 2L : 32;
                if (bytes > MaximumResponseBytes) throw new InvalidOperationException("Query results exceed the 16 MiB connector limit.");
                values[column] = cell;
            }
            result.Add(values);
        }
        return new QueryResult(columns.ToArray(), result, durationMs);
    }

    private static string Column(string name, List<string> columns, HashSet<string> used)
    {
        var basis = string.IsNullOrWhiteSpace(name) ? "Column" : name;
        if (!used.Add(basis)) return columns.First(item => item.Equals(basis, StringComparison.OrdinalIgnoreCase));
        columns.Add(basis);
        return basis;
    }

    private static object? Cell(JsonNode? node)
    {
        if (node is null || node.GetValueKind() is JsonValueKind.Null) return null;
        if (node is not JsonValue value) return Bounded(node.ToJsonString());
        if (value.TryGetValue<bool>(out var flag) && value.GetValueKind() is JsonValueKind.True or JsonValueKind.False) return flag;
        if (value.TryGetValue<string>(out var text)) return Bounded(text ?? "");
        var raw = value.ToJsonString();
        if (long.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var whole)) return whole;
        if (double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var number))
            return double.IsFinite(number) ? number : throw new InvalidOperationException("An AnyLog result contains a non-finite number.");
        return Bounded(raw);
    }

    private static string Bounded(string text)
        => text.Length <= 1_048_576 ? text : throw new InvalidOperationException("A query cell exceeds the 1 MiB connector limit.");
}
