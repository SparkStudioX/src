# Synthetic gateway load tests

These opt-in tools measure the current source on an isolated gateway. They are
not included in normal CI and do not establish a supported production capacity.
They create synthetic memory tags; no OPC server, SQL Server, installed gateway
data, or existing project is used. Keep results under the ignored `.data/` tree.

## Backend probe

Build `src/SparkStudio.Gateway.Tests` in Release mode using the documented
isolated `.data/test-build` output, then run from the source checkout:

```powershell
.\.tools\dotnet\dotnet.exe .data\test-build\bin\SparkStudio.Gateway.Tests\release\SparkStudio.Gateway.Tests.dll --load-test --seconds 30 --output-dir .data\load-tests\my-backend-run
```

The output directory must be new. `--seconds` accepts 5–120 seconds per stage;
`--load-stages memory` or `history` selects one family. Six default stages cover
100/500/1,000 configured tags with eight saturated writers, then 1,000 historical
tags with zero, one, and four query workers. Use `--tag-counts 1000,5000,10000`
to measure larger memory configurations. The model permits 10,000 expanded
tags, including UDT members; rejection probes verify 10,001 and 20,000 are refused.

History stages seed 120 samples per tag through the production sampling API,
using an explicitly controlled preparation clock. Measurement uses wall time.
Eight paced writers run alongside the production `Sample()` method followed by
a 250 ms delay. This matches the fixed-delay service loop; it does not promise
an exact 4 Hz sampling frequency. Each query worker requests 32 rotating tags
with up to 1,000 points each, serializes the result, and waits 100 ms. The report
separates seeded and measured rows, query-service latency from serialization,
sample-call latency from recorded sample intervals, and requested from achieved
rates. CPU and memory include the in-process load generator.

Checks include write statuses, final values, checkpoint reload, unchanged tag
configuration, SQLite integrity and history reopen. Resource guards stop work
at 2 GiB process working set or 1.5 GiB fixture disk usage. Timing distributions
use bounded histograms; reported quantiles have approximately 1% resolution.

## Operator HTTP and SSE probe

Start a fresh Release gateway in Production mode on loopback port 5091 or 5093,
using a new directory below this checkout's `.data/` directory. Configure the
bundled Python path and disable generated demo tags. Before starting it, write
`load-fixture.json` in that data directory:

```json
{"kind":"sparkstudio-synthetic-load","version":1,"baseUrl":"http://127.0.0.1:5093","syntheticOnly":true}
```

With the isolated gateway ready, run:

```powershell
node tools/test-load-runtime.mjs http://127.0.0.1:5093 .data/load-tests/my-http-run --seconds=30 --clients=1,10,50,100 --tags=10000 --batch-size=100
```

HTTP stages accept 5–90 seconds. Longer single invocations would approach the
existing 1,000-call script budget at this producer's 10 calls/second.

The tool refuses initialized gateways, reused fixtures, existing connections or
tags, non-loopback URLs and data directories outside `.data`. It reads that
directory's one-time setup code, creates disposable credentials in memory, and
creates its own project, tag scope, synthetic tags and bounded Python
producer. Stop only the isolated gateway afterward; keep its data for evidence.

Each operator has an independent authenticated session and uses the real
`/runtime/sessions/{id}/messages` stream. One Python invocation produces batches
of `--batch-size` updates at a target of 10 batches/second; this avoids conflating stream
load with repeated interpreter startup. The harness measures achieved write
rate, 10-tag HTTP reads at 5 requests/second, initial snapshot time, SSE sample
age, bytes, scheduling delay, disconnects and final convergence of all tag values
for every client. Intermediate updates can intentionally coalesce. Integrity
and sustaining at least 95% of the requested update rate are separate results.
All owned streams and login/runtime sessions are closed after each stage.

`--tags` accepts multiples of 100 up to 10,000 (default 1,000). `--batch-size`
accepts multiples of 100 up to 1,000 (default 100), must divide the tag count,
and sets the aggregate target to batch size × 10 updates/second. The stage must
last long enough to update every tag. With 10,000 tags, a batch of 100 updates
each tag every ten seconds; a batch of 1,000 targets one update per tag per
second. The report counts replacement snapshots separately: overflowing the
2,048-path SSE mailbox correctly resets to a full scoped snapshot, with higher
bandwidth. Fresh-value latency includes these resets as well as deltas.

This exercises network protocol consumers, not browser rendering. The operator
stream can wait up to one second before draining tag changes; its behavior is
different from the generic tag-event endpoint. Sample age includes that wait.

## Interpretation

Record the exact source revision, host CPU/RAM, concurrent services, stage
duration and measured workload with each result. A shared desktop with a local
load generator is not equivalent to dedicated gateway hardware and remote
operator clients. Short stages do not test hourly retention, long-term database
growth, memory leaks, storage failure recovery, real OPC traffic or large
historical query results. Production capacity needs those additional tests.

## September 30, 2026 baseline

The measured host was Windows 11 Pro, Ryzen AI 9 HX 370 (24 logical processors),
approximately 32 GB installed RAM. Normal desktop applications and existing
gateways remained active; about 4.7 GB physical RAM was free at preparation.
Stages ran sequentially for 30 seconds each. Gateway code was based on source
`551eb95`, with the readiness correction described below for the HTTP run.

| In-process memory tags | Successful writes/second | Write p95 | Peak process working set |
| --- | ---: | ---: | ---: |
| 100 | 125,514 | 0.299 ms | 66 MiB |
| 500 | 125,384 | 0.293 ms | 75 MiB |
| 1,000 | 173,620 | 0.195 ms | 82 MiB |

These are saturated internal memory writes, without HTTP clients, OPC or
historian recording. The non-monotonic rates include runtime warm-up and host
variation; they are not a rated capacity or evidence that more tags improve
performance. All final/reloaded values matched, tag configuration was unchanged,
and the definition cache built once per stage. Approximately one memory-value
checkpoint per second replaced persistence on individual writes.

History used 1,000 tags, 120,000 seeded rows per stage, and eight paced writers.
The writers achieved 508–515 updates/second on this host; their nominal pacing
ceiling was 1,000, so this is not a measured 1,000-update/second ingestion result.
Periodic history recording produced additional samples even without a new value.

| Concurrent query workers | Queries/second | Query-service p95 | Sampling-pass p95 | Mean recorded interval | Recorded-interval p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0 | 0 | — | 143 ms | 369 ms | 407 ms |
| 1 | 7.8 | 56 ms | 147 ms | 375 ms | 411 ms |
| 4 | 25.6 | 140 ms | 158 ms | 386 ms | 419 ms |

The three history stages stored 82,000, 80,000 and 78,000 measured rows,
respectively. All 1,000 tags had samples, all recorded quality was Good, database
integrity was `ok`, reopen succeeded, and final/reloaded tag values matched.
Peak working set was 84–107 MiB. Queries returned hundreds of points per tag,
not the maximum 10,000-point query size. The results expose serialization and
fixed-delay sampling overhead; they do not demonstrate an exact 250 ms cadence.

The load-test preparation exposed a real startup regression: readiness used a
`StringIO` wrapper incompatible with the worker's protected OS stdout descriptor.
The correction probes the actual worker through real pipes. Fourteen automated
readiness checks and six HTTP/startup groups passed. No worker protection was
removed. A historian harness casing error and an HTTP harness stream-cleanup
stall were also corrected; incomplete attempts are retained separately and are
not treated as successful load runs.

Local raw evidence is under `.data/load-tests/20260930/`: `backend/report.json`
contains the three completed memory stages followed by the excluded harness
failure; `history/report.json` contains the complete successful historian rerun.

The complete HTTP run used 1,000 tags changing approximately once per second,
for 1,000 aggregate updates/second. Each of four stages produced 30,000 updates
in its requested 30-second window. All final values converged for every client;
there were no unexpected disconnects, invalid values, regressions, failed HTTP
probes or cleanup errors. Clients used independent sessions for one authorized
operator account, not 100 distinct account records.

| Operator sessions | HTTP tag-read p95 / p99 | SSE sample age p95 / p99 | Gateway peak working set | Mean gateway CPU, core equivalents |
| --- | ---: | ---: | ---: | ---: |
| 1 | 4 / 6 ms | 953 / 998 ms | 137 MiB | 0.12 |
| 10 | 5 / 7 ms | 953 / 994 ms | 132 MiB | 0.12 |
| 50 | 4 / 6 ms | 956 / 995 ms | 142 MiB | 0.21 |
| 100 | 6 / 7 ms | 956 / 996 ms | 164 MiB | 0.39 |

Resource measurements are one-second process samples during the producer
request, excluding login ramp and cleanup. Gateway CPU excludes the load
generator and Python child; the latter used about 18 MiB peak working set. At
100 clients, 0.39 core equivalents is approximately 1.6% of this host's 24 logical
processors. Aggregate delta traffic was about 489 MiB over the stage, approximately
16 MiB/second before protocol/network overhead; loopback avoids real LAN limits.

The producer's raw elapsed time ends after its last batch at approximately
29.9 seconds, so its raw active-period rate is about 1,003 updates/second. The
table and conclusion use the full requested 30-second window: exactly 1,000.
This does not establish 1,000 tags at 10 Hz, which would require 10,000 updates
per second, or a supported maximum number of clients.

Raw operator reports and process samples are in `http-final/`; `summary.json`
combines the completed stages and normalizes the requested-window rate. The
temporary gateway was stopped after the run. Existing 5090/6090 gateways and
live OPC values were not used as load targets.

The next performance priorities are event-driven operator tag delivery instead
of the one-second polling wait, historian read/recording separation with durable
ingestion. The follow-up below tests the raised 10,000-tag model limit.

## 10,000-tag capacity follow-up, September 30, 2026

The source now permits 10,000 configured tags, counting direct tags and expanded
UDT members together. This is an application validation limit, not a license
restriction or a throughput guarantee. Individual additions, version-1/version-2
imports, removals and reload use the same ceiling. Preview/apply accept bounded
32 MiB requests; other ordinary routes remain limited to 1 MiB. Import merges
use indexed lookups. OPC watch planning partitions compatible groups into at
most 1,000 distinct nodes per watch, preserving the existing 32-watch limit.

Thirty capacity checks passed, including 10,000 direct tags, a mixed direct/UDT
model at exactly 10,000, unchanged persisted configuration after over-limit
attempts, editing at capacity, bulk removal, reload, and actual Kestrel requests
above 1 MiB. Known-length and streaming bodies above 32 MiB were rejected. OPC
planning checks cover 10,000 nodes, aliases, order stability and settings; they
do not connect to an OPC server. Forty backend reliability checks also passed.
The final Release build passed all 19 gateway suites (1,006 checks), five tag-model
groups and seven tag-engineering groups, including real bundled CPython and
SQLite checks. Old model fixtures were corrected to reflect the existing
separate memory checkpoint: unchanged imports retain runtime values, while
changed authored definitions supersede checkpoints tied to the old definition.
Configuration edits, changed import content and connection edits still invalidate
review tokens. No production checkpoint semantics changed in this increment.

The tag manager renders 100 rows per page and indexes live values by path.
Import/model review lists are paged; Designer tag search and binding suggestions
render at most 200 matches and let users refine their search. Six component
checks cover pagination, preserved selection, filtered-result clamping and large
import previews. These checks do not measure browser rendering speed or the
case where every tag occupies a different folder.
The browser production build, 39 property-binding checks, 16 query-authoring
checks and 38 source-boundary checks passed. The build retains its existing
large-chunk warning. Independent review also corrected OS-specific path
containment in the opt-in load probe.

Fresh 30-second memory-only stages used the same host and eight saturated
writers. The production tag engine and checkpoint storage were exercised:

| Configured tags | Writes/second | Write p95 | Peak process memory |
| ---: | ---: | ---: | ---: |
| 1,000 | 130,985 | 0.253 ms | 66 MiB |
| 5,000 | 92,488 | 0.293 ms | 120 MiB |
| 10,000 | 85,152 | 0.291 ms | 159 MiB |

All stages had zero write errors, zero final/reloaded value mismatches and
unchanged tag definitions. The 10,001/20,000-tag rejection probes both passed.
These in-process rates exclude network, Python RPC, OPC and historian work.
Raw evidence is in `.data/load-tests/20260930/capacity-memory/report.json`;
capacity and regression results are alongside it in `tag-capacity-regression.json`
and `capacity-backend-regression.json`.

The real operator transport was then measured with 10,000 configured tags.
All stages lasted 30 producer seconds. A 1,000-update/second workload changes
each tag once every ten seconds; 10,000 updates/second changes each once per
second. Every stage sustained its requested producer rate, had zero read errors
or disconnects, and converged to the correct final value for all tags/clients.

| Updates/second | Sessions | HTTP read p95 | SSE fresh-value age p95 | Peak gateway memory |
| ---: | ---: | ---: | ---: | ---: |
| 1,000 | 100 | 8 ms | 970 ms | 360 MiB |
| 10,000 | 1 | 14 ms | 1,036 ms | 360 MiB |
| 10,000 | 10 | 42 ms | 1,041 ms | 403 MiB |
| 10,000 | 50 | 3,258 ms | 4,391 ms | 542 MiB |
| 10,000 | 100 | 6,199 ms | 22,918 ms | 671 MiB |

The high-rate 50/100-session runs are **not acceptable live-delivery results**
despite integrity and producer-rate checks passing. At 10,000 updates/second,
the 2,048-path stream mailbox commonly overflows into full snapshot resets.
The 100-session run received 991 replacement snapshots (about 1,808 MiB including
initial snapshots) and about 7 MiB of deltas. Its producer response was observed
after 39.1 seconds although production itself ran for 30 seconds. The single
Node load generator used about one full core at both 50 and 100 sessions;
the gateway averaged about 1.75/1.87 core equivalents. This measurement therefore
includes a saturated consumer and backpressure, and cannot attribute all delay
to the gateway or predict independent remote browsers. Distributed load
generators and narrower per-session subscriptions are needed to isolate that
limit; full-snapshot bandwidth is also a material constraint.

At 1,000 updates/second, the 100-session run used deltas without replacement
snapshots, transferred about 497 MiB of deltas and averaged 0.39 gateway core
equivalents. Its generator averaged 0.21 cores. Initial snapshots transferred a
further 154 MiB during connection ramp. These are same-host synthetic protocol
clients, not rendering browsers; the 970 ms p95 is consistent with the operator
stream's existing one-second drain wait.

Raw reports and process samples are in `capacity-http-10k/` and
`capacity-http-1k/`; `capacity-summary.json` combines results and normalizes
throughput to the full requested 30 seconds. Temporary gateways were stopped
after each run. Existing 5090/6090 services were not load targets.

Historian recording remains limited to 5,000 configured history paths and 2,000
alarms. The capacity change does not establish 10,000-tag historian support,
real-device OPC throughput, remote-network performance, browser rendering
capacity or long-term soak acceptance.
