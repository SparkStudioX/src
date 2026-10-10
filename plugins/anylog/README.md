# AnyLog query connector

This plugin lets SparkStudio named queries read an AnyLog query node. Operators enter the node address, REST port and DBMS, then write a `SELECT`. The plugin sends:

```text
sql <dbms> format=json <select>
```

Usage, limits and the build command are in [the AnyLog connector guide](../../docs/architecture/ANYLOG_CONNECTOR.md).

The client is isolated here behind a small host seam. [PLUGIN_SEAM.md](PLUGIN_SEAM.md) lists that seam, which a fork maintaining its own connectors must keep when it takes a SparkStudio update.
