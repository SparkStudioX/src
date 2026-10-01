# Alarms and retained history

Open **Gateway Settings → Alarms** or **History** with the gateway Configuration
capability. Search the list and select a rule to edit its property form. Add a new
alarm or historical tag from the list toolbar; new rules start disabled. The
Alarms tab also contains the shared alarm journal retention setting.

Use **Browse** beside **Tag path** to search configured gateway tags and select
their exact path. The browser shows each tag's value source, data type and enabled
state, with bounded pages for longer lists. Choosing a tag only updates the
selected rule's draft; it does not save configuration or write a tag value.
Manual paths remain available.

Edits stay in one shared draft when you select another rule or switch between
Alarms and History. **Save configuration** applies both tabs together as one
revision; **Cancel changes** discards the draft and retrieves the latest saved
configuration on both tabs. If retrieval fails, the draft remains available.
The pending-change summary identifies which sections have edits. Invalid
rules block saving and can be opened from the validation message. A concurrent
edit is rejected so one administrator cannot silently overwrite another's
changes. Removing a rule from the draft takes effect only after saving.

An alarm names a resolved tag, a high/low/equal condition, setpoint, absolute
deadband and priority 1–4. High activates at or above its setpoint and clears below
setpoint minus deadband; Low is the reverse. Equal activates at the exact setpoint
and remains active within its deadband. Bad-quality samples preserve an existing
active state and show their quality. Disabling a rule clears its active state.

Add **Alarm Status Table**, **Alarm Journal Table** and **Historical Trend** to
operator screens through the component palette. Their properties remain in the
property grid. Status and journal visibility follow the project's tag scope.
Acknowledgement requires Operate permission and identifies the exact occurrence;
an old acknowledgement cannot acknowledge a newer alarm. Acknowledgement and
clearing are separate states. No external notification delivery is configured.
Journal responses include `events` and `truncated`. Both the requested visible-row
limit and the 10,000-entry bounded global scan can make a result incomplete. The
runtime shows that disclosure even when unrelated activity exhausts the scan
before any event visible to the current project is found.
Changing an alarm's source, condition, deadband or enabled state closes the prior
occurrence with a `reconfigured` journal entry; the next active occurrence needs
its own acknowledgement. SQLite stores the applied definition identity, so a
restart or retry after an interrupted configuration save completes reconciliation
before showing healthy state. An enabled numeric condition receiving a nonnumeric
value reports `Bad_TypeMismatch`, preserving an existing active alarm rather than
silently clearing it.

History records value changes beyond the configured absolute deadband, quality
changes and a periodic sample at the maximum interval (250 ms through one day).
Retention is 1–3650 days. Trends query bounded raw samples over at most 31 days,
up to 32 paths and 10,000 points per path, and disclose truncated results. These
are stored samples, without interpolated aggregates, redundant collectors or
store-and-forward to an external historian.

The gateway stores rule configuration in `process-data.json` and operational
state/journal/history in `process-data/journal.sqlite` under its data directory.
Back up operational data through the stopped-gateway recovery procedure; an
online configuration backup does not promise to include retained history.

Changing retention prunes expired samples immediately when configuration is
saved, including disabled rules. Removing a rule stops collection while keeping
its last retention policy until its remaining samples expire. Legacy orphan
paths without a saved policy receive a bounded seven-day policy.

An invalid configuration or unavailable recording database leaves the gateway
running with an explicit diagnostic fault; runtime reads fail instead of
reporting an empty healthy history. The settings editor offers a recovery draft
for invalid configuration. Review it and confirm replacement before saving:
the original bytes are preserved as `process-data.json.invalid-*.json` first.
Database faults require repairing permissions or recovering the database and
restarting the gateway; saving rules never deletes or silently recreates a
corrupt database.

## Synthetic workshop

The source example is [process-data-workshop.json](../../examples/process-data-workshop.json).
It requires gateway setup and therefore is listed separately from the portable
`.sparkproj` collection. It uses one independently authored Double memory tag;
there is no device or external database connection.

1. Use an isolated development gateway. Set `SPARKSTUDIO_ADMIN_AUTH_FILE` to a
   protected local JSON credential file and run
   `node tools/load-process-data-example.mjs http://127.0.0.1:5091`. The loader
   rejects existing project/tag/rule identities before adding anything.
2. Open **Alarms and history workshop**, inspect it and explicitly Publish. The
   loader leaves the draft unpublished unless `--publish` is supplied. Grant
   the operator View, Commands and Operate, and allow `[default]ProcessWorkshop/`
   in any configured project tag scope.
3. In **Gateway Settings → Alarms**, select Workshop high temperature and stage
   a changed deadband. Select Workshop low temperature, then open **History**
   and select the workshop tag. The alarm edit must remain staged. Change the
   history retention, then choose **Cancel changes**: both tabs must restore the
   saved values without changing the revision. Use Save only for the intended
   configuration. Search by name or tag path to locate rules in longer lists.
4. In the operator application, review and confirm temperature **90**. The High
   alarm activates. Acknowledge it and compare a second operator tab.
   The numeric setpoint input and command button use the same reviewed equipment
   command. Committing the numeric input opens confirmation before writing.
5. Set **78**: the five-degree deadband keeps High active. Set **74**: it clears.
   Set **10** to activate Low and **23** to clear it. Inspect the timestamped
   journal and trend samples. Commands change only this synthetic memory tag.
6. Restart only the isolated gateway. Reopen the application and verify retained
   acknowledgement/journal/history. Compare View-only access, which cannot
   acknowledge or issue commands, and a tag scope excluding the workshop.

The setup loader adds configuration and a project in separate guarded requests.
It is not an all-resource transaction. If a request fails, inspect the named
workshop resources before retrying; it never deletes pre-existing resources.
Remove the synthetic project and disable its rules when finished. Generated
packages remain under `artifacts/sparkproj/`; no live gateway export belongs in Git.
