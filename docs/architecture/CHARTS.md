# Supplied-data charts

Add **Chart** or **Sparkline** from the Designer palette. Chart settings select line, area, bar, XY scatter, time series, pie, radar, numeric status, box and whisker, or Gantt presentation. Charts use saved datasets or published named read queries through the common dataset binding editor. They do not collect tag history or provide a historian.

Configure the X/category column and one to eight series with column keys, labels and optional six-digit hex colors. The common property sheet supplies caption, geometry and appearance bindings. Chart axes, legend, range, series and saved dataset are rows in that same grid. Series and datasets expand only when edited; Data source has its named-query fx control. Chart settings are staged until **Apply chart**, then participate in Undo, Save, Publish and project export/import.

Datasets contain `columns` and rectangular `rows`, with at most 64 columns and 1,000 rows. Numeric observations must be finite and exactly representable at integer precision. Null observations create gaps. An optional quality column treats `Good` or `Good_*` as available; other quality values create gaps rather than showing zero. Radar polygons with missing vertices are omitted. Pie/radar values must be nonnegative. No automatic aggregation or silent row truncation occurs.

Time series and Gantt accept epoch milliseconds or ISO timestamps with an explicit zone. Time series sort a display copy by timestamp; input data is unchanged and duplicate timestamps remain distinct. Box plots require five series in order: minimum, Q1, median, Q3 and maximum, already calculated by the data source. Gantt needs an additional finish column, at or after start. Numeric status is a step plot, not an alarm journal.

Optional Y bounds clip the plotted display without changing raw values. The range selector selects a percentage of loaded observations; it does not fetch older history. **View data** exposes the complete loaded dataset, including missing values. Named-query refresh, cancellation, permissions and publication isolation follow the common dataset contract. Failed or disconnected queries show diagnostics instead of presenting stale values as current.

## Workshop

Import `supplied-data-charts.sparkproj` from `artifacts/sparkproj`, review and publish it. Its synthetic datasets require no database, device or Python runtime.

1. Open Production: compare line, bar, pie and sparkline views of the same sample shift. Adjust the line chart's range and expand View data.
2. Open Quality: inspect a deliberate null gap and bad-quality point, then compare radar and box summaries.
3. Open Scheduling: inspect Gantt intervals and timestamped samples. These are supplied records, not jobs or stored history.
4. In Designer, edit a series label or color, Apply and Undo; Save and Publish to update the operator view.
5. Export and import the project. Datasets, axes and series travel with the saved project; transient range selection does not.

Meaningful model and server checks cover malformed definitions, numeric precision, unknown columns, missing data, timezone requirements, ordering, range bounds and package preservation. This family does not add historian ingestion, alarm evaluation or equipment commands.
