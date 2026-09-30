# Publication history workshop

Open **Project tools → Publication history** in the Designer's Project pane.

Designer **Publication history** lists the most recent 20 locally recorded operator snapshots. Each explicit publication records the project, referenced read queries, query definitions available to button scripts and saved button code. Previous applications remain available for a reviewed restore. History is checksummed and stored with the current snapshot in the project's `published.json` file, using one atomic file replacement. It survives restart.

Choose **Review restore** on a previous snapshot, inspect its revision and scope, then explicitly choose **Restore operator publication**. The gateway requires Publish permission, CSRF and the exact current publication timestamp. A concurrent publication rejects the stale restore. Restoration creates a fresh publication token, so existing operator sessions must load the new version before subsequent server actions. Saved and unsaved Designer drafts are unchanged; the restored operator revision may differ from the current draft.

**This is application snapshot history, not a full gateway backup or an atomic screen/query/library release.** Separately published script libraries and gateway/client event scripts are not rolled back. Tags, connections, accounts, database records and transient operator values are not included. Review compatibility with current libraries before restoring. Project exports contain saved drafts and omit local history. Referenced immutable images remain in the project's asset store. Corrupt or incompatible history fails explicitly instead of silently restoring a partial application.

## Try it

Import **Publication history** from the workshop bundle. It uses synthetic labels and one local input; no Python runtime, tags or database is needed.

1. Save and publish the original title, `Release A · Packing desk`. Open the operator application and verify it.
2. Change the title to `Release B · Packing desk`, save and publish. Refresh the operator application and inspect both history entries.
3. Change the Designer title to `Release C draft` without publishing. Open Publication history, review Release A and confirm restore.
4. Reload the operator application: Release A is visible. The Designer still contains Release C; restoring did not overwrite the draft. The history lists a fresh current snapshot of Release A.
5. In a second Designer tab, publish another saved revision. A restore review still open in the first tab must reject its stale publication timestamp; refresh history before deciding again.
6. Save/reopen the project and inspect history again. Export/import a `.sparkproj`: the imported project has its draft and no operator publication or history. It begins a separate history when explicitly published.

History begins with this feature. On the next publication, an existing legacy publication is archived before replacement when it fits the history limit. Snapshot size and checksums are validated before persistence. A failed write leaves both the current application and its history intact. Each record is limited to 16 MiB; current publication and history together are bounded to 32 MiB, so large projects may retain fewer than 20 snapshots.

A pre-feature publication can already exceed 16 MiB. History shows a retention notice before it is replaced. A new, smaller valid publication is still permitted: the oversized legacy application stays active until the single-file replacement succeeds, then only the valid new snapshot enters history. The publish result and automatically opened History dialog explicitly report that the oversized legacy version could not be retained for rollback. This notice persists across restart and later publications. Failed writes preserve the legacy application and do not commit a notice or incomplete new snapshot. New oversized publications are always rejected before writing; this exception applies only to pre-feature snapshots with no history field.

Offline full-data recovery and online/scheduled configuration backups now have separate implemented contracts in [Gateway recovery](GATEWAY_RECOVERY.md) and [Scheduled backups](SCHEDULED_BACKUPS.md). They do not make operator history an atomic script-library release. Service switching, cross-version migrations and upgrade recovery remain separate G03/G04 gates. `node tools/test-publication-history-store.mjs` exercises failed writes, oversized snapshots, byte-budget retention, checksum corruption, restart and oversized legacy migration against the real store in isolated local fixtures.