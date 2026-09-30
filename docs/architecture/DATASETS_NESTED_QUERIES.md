# Datasets and nested query repeaters

Charts and sparklines accept a saved `props.data` dataset and an optional `props.dataSource` read-query binding. The query takes precedence; removing it restores saved data. Choose **Dataset binding → Edit dataset binding** to stage a named read query, parameter expressions and refresh policy. Run preview performs an explicit read. Apply creates one Designer history entry; Cancel leaves the saved source unchanged. Chart columns and series stay in the chart editor.

A dataset has `columns: string[]` and `rows: Record<string, scalar | null>[]`. It permits up to 64 unique columns, 1,000 rows, 128 characters per column name and 4,096 characters per text cell. Every row must contain exactly its declared columns. Numbers must be finite and integers exact within the browser's safe range. Null remains null. Invalid shapes, missing columns and oversized results fail as a whole; no implicit truncation or zero substitution occurs. These are supplied data and named-read-query sources, not historian retrieval.

Query parameters use the existing scalar-query expression contract: containing parameters, non-password form inputs, custom properties and declared session/screen/private state. Tags and other query results cannot feed these mappings. Values must match declared SQL parameter types without implicit conversion. Omitted mappings use captured query defaults. Dataset source expressions participate in gateway declaration checks and publication captures their read queries.

Dataset, scalar-property and repeater reads share an application-owner coordinator: eight concurrent requests, 128 active query identities, a 30-second deadline, and cancellation when the last consumer leaves. Results never cross project, publication or application owner. Parameter changes hide an obsolete sample immediately. Polling is optional for datasets (1,000–3,600,000 ms); query repeaters refresh every ten seconds. Explicit data/query refresh coalesces pending work. Disconnection or failure makes data unavailable. A successful background refresh retains the previous good dataset only while that same context is still current.

## Nested rows

Named-query repeaters can appear at any of the existing four template levels. A nested read receives declared query parameters from its immediately containing typed form context. Its own child defaults and row mappings are applied after the read. Saved and query ancestors may be mixed; every row's full path identifies its inputs, private state and actions.

`rowsSource.maxRows` is an optional integer from 1 to 100 (default 100). The editor exposes **Maximum query rows**. It is both a complete-result limit and a publication expansion reservation. A query returning more rows fails; it is never silently sliced. Nested reservations multiply, and the existing 10,000-component project cap remains. Set realistic limits, for example 2 outer rows × 10 child rows, before adding multiple query levels.

The gateway walks the captured definition top-down for actions and table edits. It re-executes every query boundary, validates the complete result and selects each row by its published key. A forged child key from another parent, missing ancestor, excess row result or invalid mapped value fails before the script runs. Browser-supplied computed parameters do not establish authority. Database mutations still require their own concurrency guard.

Popup source checking follows every saved/query ancestor and compares captured parameter scopes. A changed or removed ancestor permanently invalidates that opening; closing and reopening establishes a new context. Closing, switching context, republishing or going offline cancels or hides obsolete source checks. Gateway popup actions independently reconstruct the opener again.

## Workshop

The independently authored [Datasets and nested query rows](../../examples/dataset-nested-queries.json) workshop is portable and uses only the built-in production-summary read query. It has two outer query rows, a query repeater inside each row, charts bound to each current line and contextual popups.

Prerequisites: a build containing this increment; bundled Python and operator Operate permission for the read-only context button. No external connection or gateway writes are needed. Import the workshop into a separate project, explicitly publish, then open **Datasets and nested queries**. Compare Line1 and Line2 charts, enter different notes, refresh, and verify unchanged rows retain their drafts. Open each inspection and verify its dataset contains only that line. The context button reports the reconstructed line, product, produced count and that row's note. Export retains the two bounded source definitions and dataset mappings.

Not included: arbitrary dataset expressions, tag-valued datasets, editable datasets, unlimited nesting or historical subscriptions.
