# Gateway capabilities and equipment commands

Administrators assign project grants and gateway capabilities under Gateway Settings → Security → Users & access. Effective permissions are rechecked on every request. Account changes invalidate existing sessions; users sign in again to receive their current grants. Administrator accounts retain every capability. Existing accounts load with no new capabilities and no equipment-command grant.

## Project permissions

| Grant | Access |
| --- | --- |
| View | Open published operator screens and read tags inside the project’s allowed tag prefixes. |
| Operate | Ordinary operator actions, including authorized application memory writes; includes View. |
| Equipment commands | Controlled equipment command endpoints for that project; includes Operate and View. Ordinary Operate does not imply this grant. |
| Design | Edit project resources; does not grant operator or equipment-command access. |
| Publish | Publish reviewed project resources; includes Design. |

The command permission is `commands` in project grant JSON and effective session permissions. Command endpoints declare `Access("command", "operator", audit: true)`. The gateway requires the operator audience, the matching project grant, and a valid session CSRF token before invoking the command. Device write validation, target allowlists and approval/acknowledgment behavior are additional command-specific checks. A command grant does not expose arbitrary OPC writes or grant gateway configuration access.

## Gateway capabilities

| Capability | API and UI scope |
| --- | --- |
| Diagnostics | Process/API observations, resource overview and the allowlisted support snapshot. |
| Configuration | Shared tags, UDT definitions/instances, scan groups, default-provider lifecycle, connections and deployment settings. Connection test/browse and SQLite setup remain explicit actions in that workflow. |
| Backups | Backup configuration, manual creation and download. Configuration backups contain account/configuration material described by their coverage; grant this capability to people authorized to handle those archives. |
| Audit | Read the security activity trail. |
| Sessions | Inspect authenticated sessions and revoke selected sessions. |

Capabilities are independent Booleans in `gatewayCapabilities`. A capability-only account can sign in to engineering without a project Design grant. Its Gateway Settings navigation exposes its granted sections. The Configuration capability permits shared connection administration through **Gateway Settings → Data → Connections** and certificate administration through **Data → Public OPC certificates**, independently of project Design grants. The permission is still named Configuration; Data is the navigation label. Tags and Models open only inside a project Designer, so editing them also requires Design access to at least one project. Earlier `/workspace` links open the default project.

The shared overview redacts session identities without Sessions, process metrics without Diagnostics, and resource names without Diagnostics or Configuration. Account administration, project grant/tag-scope administration, project creation/import/archive, draft Python execution and recovery approval remain administrator tasks. Backup access does not grant recovery approval. Project resource publication continues to require the project Publish grant.

API authorization is authoritative. Hidden UI controls do not grant access. Gateway capabilities only authorize engineering sessions; equipment commands only authorize the operator audience. An invalid/missing CSRF token blocks mutations. Audited routes record the signed-in actor, resource, attempted action and outcome, including authorization denials. Editing an account’s grants revokes its existing sessions, and stale account snapshots fail closed.

## Workshop: access boundaries

`examples/access-permissions-workshop.json` and `tools/load-access-permissions-example.mjs` are independently authored. The workshop is **gateway-setup-required**: it creates one synthetic memory tag, one project and that project’s narrow tag-read scope. Users and passwords are created manually. No OPC connection or device command is executed. Use a disposable local gateway compatible with the capabilities/commands schema and with Python available for the ordinary synthetic operator action.

Set `SPARKSTUDIO_ADMIN_AUTH_FILE` to a protected local administrator credential file, then run from the source checkout:

```powershell
node tools/load-access-permissions-example.mjs http://127.0.0.1:5091
```

The loader refuses project/tag collisions and leaves the new project unpublished. Review its script and publish explicitly in Designer, or use `--publish` when deliberately requesting publication. It preserves existing tag-read scopes and adds `[default]AccessPermissionsWorkshop/` only for the new project. The initial value is 0; the synthetic operator action sets it to 1.

As administrator, open **Gateway Settings → Security → Operator settings**.
Search **Project tag access** for the workshop and select it. Its multiline
allowed-paths form should contain `[default]AccessPermissionsWorkshop/`.
Select another project, then return: each project keeps its own draft. Switch
to **Users & access** and back to confirm unsaved scopes remain intact.
Cancel changes before continuing if this was only a navigation exercise.
Blanking the workshop's scope and saving should deny its non-administrator
operator reads; restore its narrow prefix and save to resume the exercise.
Use only the disposable workshop project, and preserve other projects' scopes.

Create separate temporary accounts from the fixture’s `roles` matrix, granting project rights only on this workshop. Sign in as Viewer to read the value and verify the action is unavailable. Sign in as Operator to set the synthetic value to 1. Inspect that Equipment commands remains unchecked for this account. The Command operator role demonstrates the separate grant without issuing a physical command.

Create each capability-only account without project grants. Sign in to engineering and use Settings: a Diagnostic observer sees diagnostics; a Configuration engineer sees Data and Deployment, along with the other settings allowed by that capability; Backup operator, Auditor and Session manager see their respective tasks. None can administer accounts. Use the Session manager to revoke the Viewer session, then verify its next authenticated request requires sign-in. Remove an account’s capability as administrator and verify its existing session expires.

Project packages contain project resources, not users, credentials, gateway capabilities or gateway tags. After importing the workshop package into another gateway, recreate the tag prerequisite and scoped accounts, then publish explicitly. The role matrix is an instructional setup resource, not an identity-store export.

`node tools/test-fine-grained-access.mjs` runs an isolated temporary loopback gateway in-process. It checks command denial for viewers and ordinary operators, project/audience/CSRF boundaries, each independent capability’s actual API, overview redaction, session revocation, actor attribution, persistence, and the workshop project import/publication/re-export lifecycle. It does not contact an existing gateway or device.
