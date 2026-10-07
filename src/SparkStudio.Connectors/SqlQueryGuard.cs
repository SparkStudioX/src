
namespace SparkStudio.Connectors;

/// <summary>Conservative query screen, not a SQL authorization boundary. Use a SELECT-only database principal.</summary>
public static class SqlQueryGuard
{
    private static readonly HashSet<string> Forbidden = new(StringComparer.OrdinalIgnoreCase)
    {
        "INSERT", "UPDATE", "DELETE", "MERGE", "INTO", "EXEC", "EXECUTE", "CREATE", "ALTER",
        "DROP", "TRUNCATE", "GRANT", "DENY", "REVOKE", "BACKUP", "RESTORE", "DBCC", "USE",
        "SET", "DECLARE", "WAITFOR", "SHUTDOWN", "RECONFIGURE", "KILL", "BULK", "OPENROWSET",
        "OPENQUERY", "OPENDATASOURCE", "NEXT", "BEGIN", "COMMIT", "ROLLBACK", "SAVE", "CHECKPOINT",
        "PRINT", "RAISERROR", "THROW", "RETURN", "GO", "RECEIVE", "SEND", "ATTACH", "DETACH",
        "PRAGMA", "VACUUM", "REINDEX", "ANALYZE", "LOAD_EXTENSION", "READFILE", "WRITEFILE",
        "ENABLE", "DISABLE", "REVERT", "SETUSER", "WRITETEXT", "UPDATETEXT", "READTEXT", "DUMP", "LOAD"
    };

    public static string Validate(string sql)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sql);
        if (sql.Length > 65536) throw new ArgumentException("Query text is limited to 65,536 characters.");
        var tokens = Tokenize(sql);
        if (tokens.Count == 0 || tokens[0].Kind != 'w' ||
            !(tokens[0].Text.Equals("SELECT", StringComparison.OrdinalIgnoreCase) ||
              tokens[0].Text.Equals("WITH", StringComparison.OrdinalIgnoreCase)))
            throw new ArgumentException("Only a single SELECT query or WITH … SELECT query is supported.");

        var depth = 0;
        var rootSelect = false;
        var expectingUnionSelect = false;
        for (var i = 0; i < tokens.Count; i++)
        {
            var token = tokens[i];
            if (token.Kind == ';' && i != tokens.Count - 1)
                throw new ArgumentException("Multiple SQL statements are not supported.");
            if (token.Kind == '(') depth++;
            if (token.Kind == ')' && --depth < 0) throw new ArgumentException("Unbalanced query parentheses.");
            if (token.Kind != 'w') continue;
            if (Forbidden.Contains(token.Text))
                throw new ArgumentException($"The SQL keyword {token.Text.ToUpperInvariant()} is not permitted in read queries.");
            if (depth != 0) continue;
            if (token.Text.Equals("SELECT", StringComparison.OrdinalIgnoreCase))
            {
                if (rootSelect && !expectingUnionSelect) throw new ArgumentException("Multiple SQL statements are not supported.");
                rootSelect = true;
                expectingUnionSelect = false;
            }
            else if (token.Text.Equals("UNION", StringComparison.OrdinalIgnoreCase) ||
                     token.Text.Equals("INTERSECT", StringComparison.OrdinalIgnoreCase) ||
                     token.Text.Equals("EXCEPT", StringComparison.OrdinalIgnoreCase))
                expectingUnionSelect = true;
            else if (!token.Text.Equals("ALL", StringComparison.OrdinalIgnoreCase))
                expectingUnionSelect = false;
        }
        if (depth != 0 || !rootSelect || expectingUnionSelect)
            throw new ArgumentException("A complete SELECT query is required.");
        return sql;
    }

    public static string ValidateUpdate(string sql)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sql);
        if (sql.Length > 65536) throw new ArgumentException("Query text is limited to 65,536 characters.");
        var tokens = Tokenize(sql);
        if (tokens.Count == 0 || tokens[0].Kind != 'w' ||
            !new[] { "INSERT", "UPDATE", "DELETE" }.Contains(tokens[0].Text, StringComparer.OrdinalIgnoreCase))
            throw new ArgumentException("Only one INSERT … VALUES, UPDATE, or DELETE statement is supported.");
        var depth = 0;
        var sets = 0;
        var values = 0;
        for (var i = 0; i < tokens.Count; i++)
        {
            var token = tokens[i];
            if (token.Kind == ';' && i != tokens.Count - 1) throw new ArgumentException("Multiple SQL statements are not supported.");
            if (token.Kind == '(') depth++;
            if (token.Kind == ')' && --depth < 0) throw new ArgumentException("Unbalanced query parentheses.");
            if (token.Kind != 'w') continue;
            var word = token.Text.ToUpperInvariant();
            if (i > 0 && word is "INSERT" or "UPDATE" or "DELETE")
                throw new ArgumentException("Multiple SQL mutations are not supported.");
            if ((Forbidden.Contains(word) && word is not ("INSERT" or "UPDATE" or "DELETE" or "INTO" or "SET")) ||
                word is "OUTPUT" or "RETURNING" or "REPLACE")
                throw new ArgumentException($"The SQL keyword {word} is not permitted in update statements.");
            if (depth == 0 && word == "SELECT") throw new ArgumentException("Update statements cannot return a query result.");
            if (depth == 0 && word == "SET" && ++sets > 1) throw new ArgumentException("Multiple SET clauses are not supported.");
            if (depth == 0 && word == "VALUES") values++;
        }
        if (depth != 0 || (tokens[0].Text.Equals("INSERT", StringComparison.OrdinalIgnoreCase) && values != 1) ||
            (tokens[0].Text.Equals("UPDATE", StringComparison.OrdinalIgnoreCase) && sets != 1))
            throw new ArgumentException("A complete single INSERT … VALUES, UPDATE, or DELETE statement is required.");
        return sql;
    }

    private readonly record struct Token(char Kind, string Text);

    private static List<Token> Tokenize(string sql)
    {
        var result = new List<Token>();
        for (var i = 0; i < sql.Length;)
        {
            var c = sql[i];
            if (char.IsWhiteSpace(c)) { i++; continue; }
            if (c == '-' && i + 1 < sql.Length && sql[i + 1] == '-')
            {
                i += 2;
                while (i < sql.Length && sql[i] != '\n' && sql[i] != '\r') i++;
                continue;
            }
            if (c == '/' && i + 1 < sql.Length && sql[i + 1] == '*')
            {
                i += 2;
                var nesting = 1;
                while (i < sql.Length && nesting > 0)
                {
                    if (i + 1 < sql.Length && sql[i] == '/' && sql[i + 1] == '*') { nesting++; i += 2; }
                    else if (i + 1 < sql.Length && sql[i] == '*' && sql[i + 1] == '/') { nesting--; i += 2; }
                    else i++;
                }
                if (nesting != 0) throw new ArgumentException("Unterminated SQL comment.");
                continue;
            }
            if (c is '\'' or '"' or '[' or '`')
            {
                var end = c == '[' ? ']' : c;
                i++;
                var closed = false;
                while (i < sql.Length)
                {
                    if (sql[i++] != end) continue;
                    if (i < sql.Length && sql[i] == end) { i++; continue; }
                    closed = true;
                    break;
                }
                if (!closed) throw new ArgumentException("Unterminated SQL literal or identifier.");
                result.Add(new Token('q', ""));
                continue;
            }
            if (char.IsLetter(c) || c is '_' or '@' or '#')
            {
                var start = i++;
                while (i < sql.Length && (char.IsLetterOrDigit(sql[i]) || sql[i] is '_' or '@' or '#' or '$')) i++;
                result.Add(new Token(c == '@' ? 'p' : 'w', sql[start..i]));
                continue;
            }
            result.Add(new Token(c, c.ToString()));
            i++;
        }
        return result;
    }
}
