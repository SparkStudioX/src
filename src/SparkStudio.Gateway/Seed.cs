using System.Text.Json.Nodes;

namespace SparkStudio.Gateway;

public static class Seed
{
    public static JsonObject Project() => JsonNode.Parse("""
    {
      "id":"factory-overview","name":"Factory overview","revision":0,
      "parameters":{"line":"Line1"},
      "screens":[{"id":"overview","name":"Overview","width":1200,"height":760,"components":[
        {"id":"title","type":"label","x":32,"y":32,"width":650,"height":64,"props":{"text":"Production overview"}},
        {"id":"speed","type":"value","x":32,"y":128,"width":320,"height":200,"props":{"text":"Line speed","tagPath":"[default]Line/{line}/Speed","unit":"units/min"}},
        {"id":"temperature","type":"gauge","x":384,"y":128,"width":320,"height":200,"props":{"text":"Temperature","tagPath":"[default]Line/{line}/Temperature","unit":"°C","min":0,"max":100}},
        {"id":"production","type":"value","x":736,"y":128,"width":320,"height":200,"props":{"text":"Units produced","tagPath":"[default]Line/{line}/ProductionCount","unit":"units"}},
        {"id":"summary","type":"table","x":32,"y":370,"width":1024,"height":275,"props":{"text":"Production summary · sample data","queryId":"production-summary"}}
      ]}]
    }
    """)!.AsObject();
    public static JsonArray Queries() => JsonNode.Parse("""
    [{"id":"production-summary","name":"Production summary (sample)","connectionId":"sample","sql":"SELECT Line, Product, Produced, Target FROM ProductionSummary WHERE Line = @line","parameters":[{"name":"line","type":"string","defaultValue":"Line1"}]}]
    """)!.AsArray();
}
