using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

try
{
    if (args.Length != 6 || args[0] != "--root" || args[2] != "--input" || args[4] != "--output")
        throw new ArgumentException("Usage: SparkStudio.Complexity --root DIRECTORY --input FILES.json --output REPORT.json");
    var root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(args[1]));
    var paths = JsonSerializer.Deserialize<string[]>(File.ReadAllText(args[3]))
        ?? throw new ArgumentException("C# input manifest must contain a file array.");
    if (paths.Length == 0 || paths.Distinct(StringComparer.Ordinal).Count() != paths.Length)
        throw new ArgumentException("C# input manifest must contain unique source files.");
    var files = paths.Select(relative => ComplexityAnalyzer.Analyze(root, relative)).ToArray();
    var options = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = true };
    File.WriteAllText(args[5], JsonSerializer.Serialize(new {
        version = 1, language = "csharp", analyzer = typeof(CSharpSyntaxTree).Assembly.GetName().Version?.ToString(),
        generatedAt = DateTimeOffset.UtcNow, files, functions = files.SelectMany(file => file.Functions).ToArray(),
    }, options) + "\n");
}
catch (Exception error)
{
    Console.Error.WriteLine("C# complexity analysis failed: " + error.Message);
    Environment.ExitCode = 1;
}

internal static class ComplexityAnalyzer
{
    public static FileReport Analyze(string root, string relative)
    {
        var full = Path.GetFullPath(Path.Combine(root, relative));
        if (!full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
            || !relative.EndsWith(".cs", StringComparison.OrdinalIgnoreCase))
            throw new ArgumentException("C# input must name a source file within its analysis root.");
        var text = File.ReadAllText(full);
        var options = new CSharpParseOptions(LanguageVersion.Preview);
        var initial = CSharpSyntaxTree.ParseText(text, options, full);
        var symbols = initial.GetRoot().DescendantTrivia(descendIntoTrivia: true)
            .Select(trivia => trivia.GetStructure()).OfType<ConditionalDirectiveTriviaSyntax>()
            .SelectMany(directive => directive.Condition.DescendantNodesAndSelf().OfType<IdentifierNameSyntax>())
            .Select(identifier => identifier.Identifier.ValueText).Distinct(StringComparer.Ordinal).Order().ToArray();
        if (symbols.Length > 8)
            throw new ArgumentException(relative + ": complexity analysis supports at most eight independent preprocessor symbols; simplify conditional compilation.");
        var units = new Dictionary<(string Name, int Occurrence), FunctionReport>();
        for (var mask = 0; mask < 1 << symbols.Length; mask++)
        {
            var enabled = symbols.Where((_, index) => (mask & (1 << index)) != 0);
            var tree = CSharpSyntaxTree.ParseText(text, options.WithPreprocessorSymbols(enabled), full);
            var errors = tree.GetDiagnostics().Where(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error).ToArray();
            if (errors.Length > 0)
                throw new ArgumentException(relative + ": " + string.Join("; ", errors.Select(error => error.ToString())));
            var functions = new List<FunctionReport>();
            var occurrences = new Dictionary<string, int>(StringComparer.Ordinal);
            var syntax = tree.GetCompilationUnitRoot();
            if (syntax.Members.OfType<GlobalStatementSyntax>().Any())
                AddUnit(syntax, "<top-level>", syntax.Members.OfType<GlobalStatementSyntax>(), tree, relative, occurrences, functions);
            Visit(syntax, [], tree, relative, occurrences, functions);
            foreach (var function in functions)
            {
                var key = (function.Name, function.Occurrence);
                if (!units.TryGetValue(key, out var previous) || function.Complexity > previous.Complexity)
                    units[key] = function;
            }
        }
        return new(relative, Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant(),
            text.Split('\n').Length, units.Values.OrderBy(function => function.Line).ThenBy(function => function.Column).ToArray());
    }

    private static void Visit(SyntaxNode node, string[] scope, SyntaxTree tree, string file,
        Dictionary<string, int> occurrences, List<FunctionReport> functions)
    {
        var childScope = Scope(node, scope);
        if (UnitName(node) is { } local)
        {
            var name = string.Join(" / ", scope.Append(local));
            AddUnit(node, name, UnitBodies(node), tree, file, occurrences, functions);
            if (node is not TypeDeclarationSyntax) childScope = [.. scope, local];
        }
        foreach (var child in node.ChildNodes()) Visit(child, childScope, tree, file, occurrences, functions);
    }

    private static string[] Scope(SyntaxNode node, string[] scope) => node switch {
        BaseNamespaceDeclarationSyntax space => [.. scope, space.Name.ToString()],
        TypeDeclarationSyntax type => [.. scope, type.Identifier.Text],
        GlobalStatementSyntax => [.. scope, "<top-level>"],
        _ => scope,
    };

    private static string? UnitName(SyntaxNode node) => node switch {
        MethodDeclarationSyntax method when HasBody(method) => Signature(method.Identifier.Text, method.ParameterList),
        ConstructorDeclarationSyntax constructor when HasBody(constructor) => Signature("constructor", constructor.ParameterList),
        DestructorDeclarationSyntax destructor when HasBody(destructor) => "destructor",
        OperatorDeclarationSyntax operation when HasBody(operation) => Signature("operator " + operation.OperatorToken.Text, operation.ParameterList),
        ConversionOperatorDeclarationSyntax conversion when HasBody(conversion) => Signature(conversion.ImplicitOrExplicitKeyword.Text + " " + conversion.Type, conversion.ParameterList),
        LocalFunctionStatementSyntax local when local.Body is not null || local.ExpressionBody is not null => Signature(local.Identifier.Text, local.ParameterList),
        AccessorDeclarationSyntax accessor when accessor.Body is not null || accessor.ExpressionBody is not null =>
            (accessor.Parent?.Parent switch {
                PropertyDeclarationSyntax property => property.Identifier.Text,
                IndexerDeclarationSyntax indexer => "this[" + Parameters(indexer.ParameterList.Parameters) + "]",
                EventDeclarationSyntax signal => signal.Identifier.Text,
                _ => "<accessor>",
            }) + "." + accessor.Keyword.Text,
        PropertyDeclarationSyntax property when property.ExpressionBody is not null => property.Identifier.Text + ".get",
        IndexerDeclarationSyntax indexer when indexer.ExpressionBody is not null => "this[" + Parameters(indexer.ParameterList.Parameters) + "].get",
        TypeDeclarationSyntax type when type.ParameterList is not null => type.Identifier.Text + " / " + Signature("primary constructor", type.ParameterList),
        AnonymousFunctionExpressionSyntax => AnonymousName(node),
        _ => null,
    };

    private static bool HasBody(BaseMethodDeclarationSyntax method) => method.Body is not null || method.ExpressionBody is not null;
    private static string Signature(string name, ParameterListSyntax parameters) => name + "(" + Parameters(parameters.Parameters) + ")";
    private static string Parameters(SeparatedSyntaxList<ParameterSyntax> parameters) =>
        string.Join(",", parameters.Select(parameter => parameter.Modifiers.ToString() + parameter.Type?.ToString()));

    private static string AnonymousName(SyntaxNode node)
    {
        for (var parent = node.Parent; parent is not null; parent = parent.Parent)
        {
            if (parent is VariableDeclaratorSyntax variable) return "lambda:" + variable.Identifier.Text;
            if (parent is AssignmentExpressionSyntax assignment) return "lambda:" + Compact(assignment.Left.ToString());
            if (parent is ArgumentSyntax argument && argument.Parent?.Parent is InvocationExpressionSyntax call)
                return "callback:" + Compact(call.Expression.ToString()) + "[" + call.ArgumentList.Arguments.IndexOf(argument) + "]";
            if (parent is AnonymousFunctionExpressionSyntax || UnitNameWithoutAnonymous(parent)) break;
        }
        return "<anonymous>";
    }

    private static bool UnitNameWithoutAnonymous(SyntaxNode node) => node is BaseMethodDeclarationSyntax
        or LocalFunctionStatementSyntax or AccessorDeclarationSyntax or PropertyDeclarationSyntax;
    private static string Compact(string value) => string.Concat(value.Where(character => !char.IsWhiteSpace(character)));

    private static IEnumerable<SyntaxNode> UnitBodies(SyntaxNode node) => node switch {
        BaseMethodDeclarationSyntax method => new SyntaxNode?[] { method.InitializerNode(), method.Body, method.ExpressionBody }.OfType<SyntaxNode>(),
        LocalFunctionStatementSyntax local => new SyntaxNode?[] { local.Body, local.ExpressionBody }.OfType<SyntaxNode>(),
        AccessorDeclarationSyntax accessor => new SyntaxNode?[] { accessor.Body, accessor.ExpressionBody }.OfType<SyntaxNode>(),
        PropertyDeclarationSyntax property => [property.ExpressionBody!],
        IndexerDeclarationSyntax indexer => [indexer.ExpressionBody!],
        TypeDeclarationSyntax type => PrimaryBodies(type),
        AnonymousFunctionExpressionSyntax anonymous => [anonymous.Body],
        _ => throw new ArgumentException("Unsupported C# executable unit."),
    };

    private static ConstructorInitializerSyntax? InitializerNode(this BaseMethodDeclarationSyntax method) =>
        method is ConstructorDeclarationSyntax constructor ? constructor.Initializer : null;

    private static IEnumerable<SyntaxNode> PrimaryBodies(TypeDeclarationSyntax type) =>
        type.ChildNodes().OfType<BaseListSyntax>().Cast<SyntaxNode>().Concat(type.Members.SelectMany(member => member switch {
            FieldDeclarationSyntax field => field.Declaration.Variables.Select(variable => variable.Initializer).OfType<SyntaxNode>(),
            PropertyDeclarationSyntax property => new SyntaxNode?[] { property.Initializer }.OfType<SyntaxNode>(),
            _ => [],
        }));

    private static void AddUnit(SyntaxNode location, string name, IEnumerable<SyntaxNode> bodies, SyntaxTree tree,
        string file, Dictionary<string, int> occurrences, List<FunctionReport> functions)
    {
        var decisions = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var body in bodies) Count(body, body, decisions);
        occurrences.TryGetValue(name, out var previous);
        occurrences[name] = previous + 1;
        var span = tree.GetLineSpan(location.Span);
        functions.Add(new(file, name, previous + 1, span.StartLinePosition.Line + 1,
            span.StartLinePosition.Character + 1, span.EndLinePosition.Line + 1, 1 + decisions.Values.Sum(), decisions));
    }

    private static void Count(SyntaxNode node, SyntaxNode root, Dictionary<string, int> decisions)
    {
        if (node != root && (UnitName(node) is not null || node is TypeDeclarationSyntax)) return;
        if (Decision(node) is { } kind) decisions[kind] = decisions.GetValueOrDefault(kind) + 1;
        foreach (var child in node.ChildNodes()) Count(child, root, decisions);
    }

    private static string? Decision(SyntaxNode node) => node.Kind() switch {
        SyntaxKind.IfStatement => "if",
        SyntaxKind.ForStatement => "for",
        SyntaxKind.ForEachStatement or SyntaxKind.ForEachVariableStatement => "foreach",
        SyntaxKind.WhileStatement => "while",
        SyntaxKind.DoStatement => "do-while",
        SyntaxKind.CatchClause => "catch",
        SyntaxKind.ConditionalExpression => "conditional expression",
        SyntaxKind.CaseSwitchLabel or SyntaxKind.CasePatternSwitchLabel => "non-default switch case",
        SyntaxKind.SwitchExpressionArm when ((SwitchExpressionArmSyntax)node).Pattern is not DiscardPatternSyntax => "non-default switch arm",
        SyntaxKind.WhenClause => "when guard",
        SyntaxKind.LogicalAndExpression => "&&",
        SyntaxKind.LogicalOrExpression => "||",
        SyntaxKind.CoalesceExpression => "??",
        SyntaxKind.AndPattern => "and pattern",
        SyntaxKind.OrPattern => "or pattern",
        _ => null,
    };
}

internal sealed record FileReport(string File, string Sha256, int Lines, IReadOnlyList<FunctionReport> Functions);
internal sealed record FunctionReport(string File, string Name, int Occurrence, int Line, int Column, int EndLine,
    int Complexity, IReadOnlyDictionary<string, int> Decisions);
