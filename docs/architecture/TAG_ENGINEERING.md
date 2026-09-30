# Gateway tag engineering

The Tags workspace creates memory values, OPC UA bindings and gateway expression tags. Expressions execute on the gateway, independently of browser sessions. All configuration, import and export operations require a gateway administrator in an engineering session; imports also require the normal CSRF token and are audited.

## Expression tags

An expression declares named inputs mapped to concrete existing tag paths. For example, a Double tag can use `count * 60 / seconds`, with inputs `count` and `seconds` pointing to two memory or OPC UA tags. Another Boolean expression can depend on that expression using `rate >= 0 && rate <= 25`.

Supported syntax includes numbers, JSON quoted strings, `true`, `false`, named inputs, parentheses, arithmetic `+ - * / %`, comparisons `< <= > >= == !=`, Boolean `&& || !`, and unary `+ -`. There are no function calls, scripts, assignments, network operations or dynamic property access. String concatenation is not supported. Equality requires matching scalar types; arithmetic requires numeric operands and Boolean operators require Boolean operands. The declared output type is checked without coercing a fraction to an integer or a number to a Boolean.

Numbers use IEEE-754 doubles. Integer inputs and literals outside ±9,007,199,254,740,991 are rejected rather than rounded; memory and OPC UA tags retain their existing original types. Each expression is limited to 2,048 characters, 256 tokens, 64 nesting levels and 32 named inputs. A gateway supports at most 1,000 configured tags, with at most 64 expression tags in a dependency chain. Self-references, cycles, missing input paths and deletion of a referenced tag are rejected before saving. The checks include disabled definitions, so enabling them cannot introduce a previously hidden cycle.

The publishing interval is also the expression evaluation interval, from 100 to 60,000 ms, on a 100 ms scheduler. This is not a real-time guarantee. Dependency ordering applies when expressions are due in the same scheduler pass; a slower dependency retains its prior result until its own next evaluation. Every declared input must have good quality, even when a Boolean branch would short-circuit. A bad input propagates its quality and a null result, division by zero produces `Bad_ExpressionError`, and invalid operand or output types produce `Bad_TypeMismatch`. Disabled expressions produce `Bad_Disabled`.

Derived timestamps use the newest contributing source timestamp. Re-evaluation alone does not advance them. Constants retain their timestamp until their result or quality changes. These timestamps describe source data, not evaluation duration or receipt time. The Tag editor exposes the result and quality; all tag consumers receive the same path, data type, value, quality and timestamp contract.

## Reviewed bulk import and export

Choose **Tags → Import / export**. Export downloads a `sparkstudio.tags` version 1 JSON envelope containing configured definitions, including their saved memory values. It contains no connector credentials or connection definitions. Treat memory values as application data when storing or sharing exports.

Import previews each path as add, update or unchanged, and the total tag count after applying. It merges matching paths and retains existing tags not in the import. It does not delete tags. A package can refer to another tag defined later in that same package. All rows, connection references, input paths and the complete resulting dependency graph are validated together.

Apply revalidates under the store lock, checks the preview against both the current tag content and connection configuration, and atomically replaces `tags.json` once. No partial rows are saved when validation or conflict checks fail. A concurrent memory write, configuration edit, connection change or edited file invalidates the preview; preview again before applying. An older reviewed file cannot overwrite a newer value silently. Changing a gateway tag affects every project that uses it immediately; project publication does not create a private copy of gateway tag configuration.

The envelope is `{ "format": "sparkstudio.tags", "version": 1, "tags": [...] }`. Imports require 1–1,000 rows and supported fields only; the browser limits files to 900 KB. Fields must match the chosen source. Unsupported versions, provider configuration, UDTs, alarm definitions and unknown fields are rejected explicitly. OPC UA connections must already exist and match the referenced IDs.

Endpoints under `/api` or a project API scope are `GET /tag-engineering/export`, `POST /tag-engineering/preview` with the envelope, and `POST /tag-engineering/apply` with `{ package, revision, previewToken }`. The preview token is an optimistic concurrency fingerprint, not an authorization credential. The authenticated apply endpoint performs all validation again.

## Workshop: production rate

`examples/tag-engineering.json` is independently authored synthetic source for a separate **Tag engineering workshop** project. It is **setup-required** because four gateway tags are deliberately excluded from `.sparkproj` packages. The example creates no external connection and does not command equipment. It requires the expression-tag build, an engineering administrator for setup, the bundled Python worker for the save action, and an operator with Operate permission for that project.

1. On a disposable development gateway, provide a protected local JSON credential file with `username` and `password`, or use an existing disposable test-account file with an `admin` entry. Set its path in `SPARKSTUDIO_ADMIN_AUTH_FILE`. Never add this file to a repository or release.
2. Run `node tools/load-tag-engineering-example.mjs http://127.0.0.1:5091`. Add `--publish` only when you want to publish the newly created project immediately. The loader refuses an existing project name or any of the reserved `[default]TagWorkshop` paths. Tag import is atomic; creating the project is a separate operation. If project creation fails, the four newly created tags remain available for inspection.
3. Open the new project in Designer, inspect the expressions in Tags, publish the project and open its operator link. Initial readings are 12 counts in 30 seconds: the rate is 24 per minute and Within limit is true.
4. Save 20 counts in 30 seconds. The rate becomes 40 and Within limit becomes false. The button writes only synthetic memory values; both derived tags are read-only.
5. Save zero seconds. The derived values become unavailable with `Bad_ExpressionError`; restore 30 seconds to recover. Disable Count in Tags and save to propagate `Bad_Disabled`; re-enable it to recover.
6. Export the configured tags. Choose that file in Import / export, preview it and review the unchanged rows. Edit Count in another session after preview, then try Apply; the server refuses the stale review. Preview again to proceed.
7. Try changing Rate to depend on WithinLimit while WithinLimit depends on Rate. The editor refuses the cycle and retains the prior definitions.

You may export the project as `.sparkproj` and distribute it separately from a reviewed tag JSON package. Import the gateway tags before publishing its screens on another gateway. The project package does not carry users, grants or gateway tags.

## Current scope and verification

G10 now has bounded expression tags, dependency validation, source quality/timestamp propagation and reviewed atomic bulk import/export. Provider lifecycle, reusable named scan groups, versioned UDT definitions/instances and their migration workflow remain future work. Existing OPC UA subscriptions continue to group by connection and publishing interval.

Run `node tools/test-tag-engineering.mjs --model` for isolated filesystem, graph, parser, live engine and concurrency tests. Run `node tools/test-tag-engineering.mjs` with `SPARKSTUDIO_TEST_AUTH_FILE` pointing to an isolated authenticated port 5091 test-account fixture to check HTTP authorization, audience separation, CSRF, import conflicts and live expression results. Neither test targets the installed gateway on port 5090.

## Live values and write durability

Runtime tag definitions are cached per configuration generation. Memory writes
update the shared in-memory value set immediately and checkpoint `tag-values.json`
in a coalesced batch about once per second. `tags.json` retains definitions and
configured defaults. Clean shutdown and scheduled configuration backups flush the
value checkpoint. Abrupt power loss can lose approximately the latest second of
memory updates; use a transactional database for records that need stronger
commit guarantees. Multi-path memory writes do not rewrite tag configuration once
per path.

Synthetic `[default]Line/*` demonstration values are disabled by default. Enable
`SparkStudio:EnableDemoTags` explicitly only for a development/demo gateway.
Operator event streams send an initial snapshot, then bounded `tags-delta`
upserts/removals and heartbeats. Each authenticated sign-in is limited to 32 tag
streams; overflow causes a fresh snapshot rather than silent permanent drift.
