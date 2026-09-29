# Connector verification

- `dotnet run --project src/SparkStudio.Connectors.Tests` runs the local connector invariant checks.
- Add `-- --opc-integration` to start a disposable OPC UA server on an ephemeral loopback port and verify actual monitored-item delivery, reconnect, quality and cancellation.
- Add `-- --gateway http://127.0.0.1:5091` to use that disposable OPC UA server with an already running, isolated test gateway. Only localhost HTTP port 5091 is accepted. This creates uniquely named tag/connection fixtures and tests subscription state and updates, disable, OPC-to-memory conversion, deletion, node remapping, publishing-interval changes, and connection reconfiguration while notifications continue.

The gateway mode deletes all its own test tags in `finally` and waits for its subscriptions to stop. Its uniquely named connection fixture remains because the current gateway has no connection-delete API; it contains no credentials and is confined to the isolated gateway data directory. The running development gateway and installed OPC servers are not modified. Test server certificates use a uniquely named OS temporary directory.
