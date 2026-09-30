using System.Text.Json.Nodes;
using SparkStudio.Gateway;

internal static class ChartChecks
{
    public static int Run()
    {
        var passed = 0;
        JsonObject Props() => JsonNode.Parse("""{"chart":{"kind":"line","xKey":"time","series":[{"key":"reading"}]},"data":{"columns":["time","reading"],"rows":[{"time":"08:00","reading":4},{"time":"09:00","reading":null}]}}""")!.AsObject();
        void Reject(Action<JsonObject> edit) { var props = Props(); edit(props); try { ChartValidator.Validate("chart", props); } catch (ArgumentException) { passed++; return; } throw new Exception("Invalid chart accepted."); }
        ChartValidator.Validate("chart", Props()); passed++;
        ChartValidator.Validate("sparkline", Props()); passed++;
        foreach (var kind in new[] { "line", "area", "bar", "pie", "radar", "status" }) { var props = Props(); props["chart"]!["kind"] = kind; ChartValidator.Validate("chart", props); passed++; }
        Reject(props => props["chart"]!["kind"] = "historian");
        Reject(props => props["chart"]!["xKey"] = "missing");
        Reject(props => props["chart"]!["series"] = new JsonArray());
        Reject(props => props["chart"]!["series"] = new JsonArray(new JsonObject { ["key"] = "reading" }, new JsonObject { ["key"] = "reading" }));
        Reject(props => props["chart"]!["series"]![0]!["color"] = "url(remote)");
        Reject(props => props["chart"]!["yMin"] = "1");
        Reject(props => { props["chart"]!["yMin"] = 3; props["chart"]!["yMax"] = 2; });
        Reject(props => props["chart"]!["rangeSelector"] = "yes");
        Reject(props => props["chart"]!["unknown"] = true);
        Reject(props => props["chart"]!["kind"] = "box");
        Reject(props => props["chart"]!["kind"] = "gantt");
        Reject(props => props["data"]!["rows"]![0]!["reading"] = "4");
        Reject(props => props["data"]!["rows"]![0]!["reading"] = 9007199254740992d);
        Reject(props => { props["chart"]!["kind"] = "pie"; props["data"]!["rows"]![0]!["reading"] = -1; });
        Reject(props => props["chart"]!["kind"] = "scatter");
        Reject(props => props["chart"]!["kind"] = "timeSeries");
        var query = Props(); query["dataSource"] = new JsonObject { ["queryId"] = "external" }; query.Remove("data"); ChartValidator.Validate("chart", query); passed++;
        var quality = Props(); quality["chart"]!["qualityKey"] = "quality"; quality["data"]!["columns"]!.AsArray().Add("quality"); foreach (var row in quality["data"]!["rows"]!.AsArray()) row!["quality"] = "Bad_Disconnected"; ChartValidator.Validate("chart", quality); passed++;
        return passed;
    }
}
