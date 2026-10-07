# AnyLog query connector

This plugin lets SparkStudio named queries read an AnyLog query node. Operators enter the node address, REST port and DBMS, then write a `SELECT`. The plugin sends:

```text
sql <dbms> format=json <select>
```

Usage, limits and the build command are in [the AnyLog connector guide](../../docs/architecture/ANYLOG_CONNECTOR.md).

The client is isolated here so a SparkStudio upgrade is a merge of upstream source plus the small host seam, not a re-merge of the AnyLog HTTP code. Follow [UPGRADE.md](UPGRADE.md) when taking a SparkStudio update.
