using System.Net;
using System.Text.Json.Nodes;
using SparkStudio.Connectors;
using SparkStudio.Connectors.AnyLog;

await TestReport.RunAsync("AnyLog query connector", args, [("protocol", Protocol)]);

static Task<int> Protocol()
{
    var checks = 0;
    void Check(bool condition, string name)
    {
        if (!condition) throw new InvalidOperationException(name);
        checks++;
    }

    var command = AnyLogCommands.Prepare("aloperator", "SELECT * FROM temperature WHERE sensor = @sensor", [new QueryParameter("sensor", "string", "BCT")]);
    Check(command == "sql aloperator format=json SELECT * FROM temperature WHERE sensor = 'BCT'", "select is wrapped and the parameter is quoted");
    Check(AnyLogCommands.Prepare("aloperator", "select timestamp, data from star_north_p1_y_load_1 limit 20", [])
        == "sql aloperator format=json select timestamp, data from star_north_p1_y_load_1 limit 20", "the select is sent after format=json with no extra keyword");
    Check(AnyLogCommands.Prepare("mydb", "select timestamp, data from star_north_p1_y_load_1 limit 20", [])
        == "sql mydb format=json select timestamp, data from star_north_p1_y_load_1 limit 20", "the live query command names the dbms and the select");
    Check(AnyLogCommands.Prepare("aloperator", "SELECT note FROM t WHERE label = 'keep @sensor' AND id = @id;", [new QueryParameter("id", "int", 4)])
        == "sql aloperator format=json SELECT note FROM t WHERE label = 'keep @sensor' AND id = 4", "literals inside quotes stay put and a trailing semicolon is removed");
    Check(AnyLogCommands.Prepare("aloperator", "SELECT * FROM t WHERE name = @name", [new QueryParameter("name", "string", "a'b")])
        .EndsWith("name = 'a''b'", StringComparison.Ordinal), "quotes inside a parameter stay inside the literal");

    var multiline = AnyLogCommands.Prepare("aloperator", "SELECT *\nFROM temperature", []);
    Check(multiline.Contains("SELECT *\nFROM temperature", StringComparison.Ordinal) && AnyLogCommands.ForHeader(multiline) == "sql aloperator format=json SELECT * FROM temperature", "line breaks stay in the statement and the header is one line");
    Check(AnyLogCommands.FitsCommandHeader(command), "a single-line command can travel in the AnyLog command header");
    var commented = AnyLogCommands.Prepare("aloperator", "SELECT value -- latest @line\nFROM t /* note @line */ WHERE line = @line", [new QueryParameter("line", "string", "A")]);
    Check(AnyLogCommands.ForHeader(commented) == "sql aloperator format=json SELECT value  FROM t   WHERE line = 'A'", "comments are dropped so a flattened header keeps the rest of the SELECT");
    Check(AnyLogCommands.Prepare("aloperator", "SELECT '--keep' AS a, '/*keep*/' AS b FROM t", []).EndsWith("SELECT '--keep' AS a, '/*keep*/' AS b FROM t", StringComparison.Ordinal), "comment markers inside quotes stay");
    ExpectThrow("non-ASCII header text is rejected before sending", () => AnyLogCommands.ForHeader(AnyLogCommands.Prepare("aloperator", "SELECT * FROM t WHERE unit = @unit", [new QueryParameter("unit", "string", "°C")])));

    ExpectThrow("DBMS names cannot carry extra commands", () => AnyLogCommands.Prepare("aloperator format=json and get status", "SELECT 1", []));
    ExpectThrow("host and port stay in separate fields", () => AnyLogCommands.ValidateEndpoint("10.0.0.5:32349", 32349));
    ExpectThrow("only a SELECT is forwarded", () => AnyLogCommands.Prepare("aloperator", "DELETE FROM temperature", []));

    var normalized = AnyLogCommands.Normalize(new JsonObject
    {
        ["connector"] = new JsonObject { ["host"] = " query.plant.local ", ["port"] = 32349, ["dbms"] = "line_1" }
    });
    Check(normalized["host"]!.GetValue<string>() == "query.plant.local" && normalized["port"]!.GetValue<string>() == "32349" && normalized["dbms"]!.GetValue<string>() == "line_1", "saved settings are trimmed text");

    var parsed = AnyLogCommands.Parse("""[{"sensor":"BCT","value":1.5},{"sensor":"BCT","value":2}]""", 4);
    Check(parsed.Columns.SequenceEqual(["sensor", "value"]) && parsed.Rows.Count == 2 && Equals(parsed.Rows[1]["value"], 2L), "JSON objects become columns and rows");
    var queryEnvelope = AnyLogCommands.Parse("""
        {"Query":[{"timestamp":"2026-09-30 16:50:06.219000","data":"42"},{"timestamp":"2026-09-30 16:50:10.551000","data":"43"}],"Statistics":[{"Count":2,"Time":"00:00:00","Nodes":1}]}
        """, 4);
    Check(queryEnvelope.Columns.SequenceEqual(["timestamp", "data"]) && queryEnvelope.Rows.Count == 2
        && Equals(queryEnvelope.Rows[0]["data"], "42") && Equals(queryEnvelope.Rows[1]["timestamp"], "2026-09-30 16:50:10.551000"), "rows come from Query and Statistics is ignored");
    ExpectThrow("a non-JSON body is not returned to the screen", () => AnyLogCommands.Parse("Error: secret row dump", 1));
    ExpectThrow("the row cap is explicit", () => AnyLogCommands.Parse("[" + string.Join(',', Enumerable.Range(0, 1001).Select(index => "{\"n\":" + index + "}")) + "]", 1));

    var handler = new RecordingHandler();
    var connector = new AnyLogQueryConnector(() => handler);
    var result = connector.QueryAsync(new Dictionary<string, string> { ["host"] = "127.0.0.1", ["port"] = "32349", ["dbms"] = "aloperator" }, "SELECT value FROM temperature WHERE line = @line", [new QueryParameter("line", "string", "A")], CancellationToken.None).GetAwaiter().GetResult();
    Check(handler.Method == HttpMethod.Get && handler.Body is null, "the query is a GET with no body");
    Check(handler.CommandHeader == "sql aloperator format=json SELECT value FROM temperature WHERE line = 'A'" && handler.Destination == "network" && handler.UserAgent == "AnyLog/1.23", "the command header carries the select and destination replaces run client ()");
    Check(result.Rows.Count == 1 && Equals(result.Rows[0]["value"], 1L), "the connector reads the JSON response");

    var broken = new RecordingHandler { Status = HttpStatusCode.InternalServerError, ResponseBody = "node internals" };
    try
    {
        new AnyLogQueryConnector(() => broken).QueryAsync(new Dictionary<string, string> { ["host"] = "127.0.0.1", ["port"] = "32349", ["dbms"] = "aloperator" }, "SELECT 1", [], CancellationToken.None).GetAwaiter().GetResult();
        Check(false, "HTTP failures stay generic");
    }
    catch (InvalidOperationException error)
    {
        Check(error.Message == "The AnyLog query node returned HTTP 500.", "HTTP failures do not include the node body");
    }
    Check(broken.Called, "the failed query was actually sent");

    DatabaseConnectorLoader.Load(Path.GetDirectoryName(typeof(AnyLogQueryConnector).Assembly.Location)!);
    Check(DatabaseConnectors.TryGet("anylog", out var loaded) && loaded!.DisplayName == "AnyLog query node", "the plugin assembly registers itself");
    Check(DatabaseConnectors.ConnectionTestFailure(AnyLogCommands.UnreachableMessage) == AnyLogCommands.UnreachableMessage, "the fixed test failure is shown");
    Check(DatabaseConnectors.ConnectionTestFailure("password=secret") == "Connection check failed. Verify the address, authentication and certificate settings.", "remote test text is not stored");
    Check(DatabaseConnectors.Describe().Any(item => item.Type == "anylog" && item.Fields.Any(field => field.Name == "dbms")), "the connection form can ask the gateway for AnyLog fields");

    return Task.FromResult(checks);

    void ExpectThrow(string name, Action action)
    {
        try { action(); }
        catch (Exception error) when (error is ArgumentException or InvalidOperationException) { checks++; return; }
        throw new InvalidOperationException(name);
    }
}

sealed class RecordingHandler : HttpMessageHandler
{
    public HttpMethod? Method { get; private set; }
    public string? Body { get; private set; }
    public string? CommandHeader { get; private set; }
    public string? Destination { get; private set; }
    public string? UserAgent { get; private set; }
    public bool Called { get; private set; }
    public HttpStatusCode Status { get; init; } = HttpStatusCode.OK;
    public string ResponseBody { get; init; } = """[{"value":1}]""";

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Called = true;
        Method = request.Method;
        Body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
        CommandHeader = request.Headers.TryGetValues("command", out var values) ? values.Single() : null;
        Destination = request.Headers.TryGetValues("destination", out var destination) ? destination.Single() : null;
        UserAgent = request.Headers.UserAgent.ToString();
        return new HttpResponseMessage(Status) { Content = new StringContent(ResponseBody) };
    }
}
