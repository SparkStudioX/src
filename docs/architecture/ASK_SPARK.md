# Ask Spark

Ask Spark is the assistant in the engineering workspace. Open **Ask Spark** from the Designer, Projects or Gateway Settings header, or press **Alt+A** outside a text editor. The same conversation follows you between these pages. It works with the signed-in user's permissions and the context chips shown above the message box.

## Configure Gemini

1. Sign in as a gateway administrator and open **Gateway Settings → AI**.
2. Enter a Gemini API key. The gateway encrypts it with its data-protection keys; saved keys are never returned to the browser. Leave the model at **gemini-3.8-flash**, or enter another compatible Gemini model ID.
3. Enable Ask Spark, save, then test the configuration. Provider errors appear in this panel. A key is required for chat, image understanding and voice transcription.
4. The parallel read limit defaults to **4**. Independent read calls can run together. Draft edits, saves and other mutations run in order.
5. **Model steps per message** defaults to **100** and accepts 1–1,000. A model response counts as one step, including a discovery request or several parallel tool calls. After the configured number of steps, the gateway requests one final answer with tools disabled. Saving a new limit applies to new messages; a running message keeps its starting limit.
6. Optionally set **Monthly AI token allowance**. The default **0** is unlimited. This allowance covers all users and projects on this gateway, including chat, transcription and connection tests. **Refresh usage** shows the current UTC month's counters. This is a token allowance, not a currency budget.

The gateway sends the conversation, attached images/audio, visible context and requested tool results to Google's Gemini service. Review your organization's data handling requirements before entering production information. Connection passwords and API keys use separate secure dialogs and are excluded from tool results. Do not paste credentials into chat, screenshots or authored code. Chat history is private to the authenticated user and encrypted on the gateway. Each user retains up to 20 conversations within a 64 MiB storage budget; older conversations are removed when that limit is reached. Use the history panel to delete a conversation explicitly. Configuration backups include encrypted AI settings and their protection keys; they exclude conversations and recordings.

## Talk, type or paste a screenshot

Use the microphone beside Ask Spark or inside the chat. Grant browser microphone access, speak, then stop recording. The returned transcript goes into the message box: edit it and press **Send** when ready. Cancel discards the recording. Microphone capture requires a secure browser context such as HTTPS or localhost; recording/transcription failures leave the text composer available.

Paste a screenshot into the composer, or use its image attachment button. Review the thumbnails and remove anything unnecessary before sending. PNG, JPEG and WebP images are supported, with up to four images and bounded request size. Images are sent only when you send the message. A screenshot helps explain visual intent; editable project information comes from the designer tools. The assistant must treat text in screenshots and tool results as content, not new instructions.

Ask Spark's answers render Markdown: headings, bold and italic text, lists, block quotes, links, tables, inline code and fenced code blocks. Use **Copy code** to copy a code block. Wide tables and code scroll within the chat. Your messages remain plain text. Embedded HTML is omitted, and Markdown images appear as links instead of loading remote content automatically.

Ask **“Open the Ask Spark workshop project and its workshop screen.”** The assistant can open a permitted project in the Designer, wait for it to load, and continue the same conversation with the new project context. It can also switch to an existing screen or template. Unsaved project, query, script or connection edits block navigation away from that work. Other navigation tools provide links to settings sections.

## Designer workflow

1. Open a screen and select the relevant components. Context chips identify the project, document and selection. Pin context to keep it while inspecting something else; remove chips to narrow what is shared.
2. Ask, for example, **“Align the selected controls on their left edges and make them the same width.”** Ask Spark inspects the current draft and uses the existing layout operations.
3. Review the action receipts. Draft changes create the same Undo checkpoints as manual edits. The chat's Undo button applies only while that exact result remains current; it refuses to overwrite subsequent edits.
4. Ask **“Bind this value to [default]Line1/Speed”**, **“Explain this button's script”**, or **“Show missing references on this screen.”** Tools can inspect and edit property expressions, named-query bindings, component events, JavaScript/Python code, custom properties, template parameters, messages and input state.
5. Ask **“Validate the draft and open read-only preview.”** Validation uses gateway authoring rules. Diagnostic snapshots evaluate current bindings and identify missing references; they do not execute arbitrary scripts, database updates or equipment actions.
6. Save the project draft when ready. Publication remains a separate reviewed action using the existing publication token and revision checks.

Ask Spark can make several edits in one model round. The `spark_designer_apply_edits` tool validates an entire batch before committing it as one Undo checkpoint. Consecutive draft-edit tools can also build on each other within the same response. Every draft mutation identifies its snapshot; the browser permits only its own immediately preceding edit to advance that snapshot. Manual changes, intervening operations and stale snapshots still stop the edit. Screen elements keep their saved Z order unless an explicit arrangement tool changes it. Names and IDs remain distinct; deleting a referenced resource is blocked by the same dependency checks used in the editor.

When the assistant saves or deletes named queries or scripts, the Designer refreshes those resources before the next tool runs. Clean query and script editors update immediately. An editor containing unsaved text retains that text and shows a notice about the gateway change. New image assets also refresh automatically. Tag changes that require review follow the preview-then-apply workflow: the assistant first obtains the proposal and token, then applies that exact proposal after any required approval.

### Check the rendered layout

Ask **“Capture this canvas and check whether the labels overlap.”** The capture tool returns a PNG of the current rendered Designer screen or template to Gemini, together with the document ID, snapshot token and dimensions. It hides selection handles, the editor grid and private/password fields. The frame fits within 2,048 pixels per side and 5 MiB, so large screens may be reduced. External images or fonts must first be imported into the gateway; inaccessible resources cause an explicit capture error. A capture checks the visible layout. It does not execute operator actions or prove that a published runtime works.

### Turn a pasted screenshot into image assets

1. Paste or attach your screenshot and send it. Ask Spark receives its image ID and original dimensions.
2. Ask **“Crop the three tiles into separate project assets named Speed tile, Temperature tile and Count tile.”** The assistant proposes names and bounding boxes in the original image's pixels.
3. Review the crop thumbnails, dimensions and exact arguments. One approval covers the batch of up to 16 crops.
4. After approval, the browser crops the retained image and uploads each PNG through the normal project asset endpoint. The assets become available in the Designer. Ask Spark can then place image components using the returned asset IDs.

Cropping preserves the source pixels; it does not enlarge or improve their resolution. A 130 × 90 pixel tile will remain that size and can look soft when stretched. All bounds and names are checked and all crops are prepared before uploads start. Each asset must fit the existing 512 KiB limit. Identical image content reuses the existing asset and its saved name; the receipt includes both the requested name and actual asset metadata. Uploads run in order and stop on a failure or cancellation; the receipt lists already-created assets and any unattempted crops. Approval does not make separate asset uploads transactional. Inspect that receipt before retrying.

Sent images remain in memory in the active browser conversation, up to 12 images or 32 MiB of encoded data. They are not stored in browser local/session storage. Opening another conversation, starting a new one, signing out or reloading releases those originals; paste the image again to crop it afterward. Crops use only the images you supplied, never a model-provided download URL. Providing a new image or entering a password still uses the attachment control or separate secure prompt.

On wide desktops the assistant docks beside the inspector. At intermediate widths **Properties / Ask Spark** switches the right pane while retaining inspector state. On narrow screens the assistant opens as a sheet. Closing it preserves the conversation and draft. The assistant never changes the saved screen size to make space.

## Gateway workflow

Open the appropriate settings section and describe the task. Examples:

- “Inspect my MQTT mappings and explain why no tags have appeared.”
- “Browse this OPC UA connection and prepare an import of the selected points.”
- “Create a named query for the work-orders table, with a station parameter.”
- “Review the backup schedule and show the latest result.”
- “Explain recent connection errors and bad-quality tags.”

Tools cover project lifecycle and packages; connections, drivers, certificates and browsing; tag models and imports; source mappings and diagnostics; named queries and scripts; alarms and history; deployment, backups and recovery review; users, project grants, sessions and audit. The shipped declarations in `apps/web/src/askSparkGatewayTools.json` and `askSparkDesignerTools.json`, plus the gateway's built-in `find_tools` and `spark_open_project` declarations, define the tool inventory.

## Tool discovery and caching

Each model round starts with a small permitted core for navigation, project inspection, designer search and **find_tools**, plus the current page's tool category. The prompt also contains a directory of permitted tool names with short summaries. Full definitions for other categories are loaded only when needed. For example, while editing a screen, a request about backups can first call `find_tools` for backup tools; the matching full schemas are available from the next model round. Discovered tools stay loaded in that conversation and are checked against current permissions before every round. Discovering a tool does not execute it or approve an operation.

Full tool descriptions are preserved. Tool results are bounded and include pagination or narrowing guidance rather than sending an unlimited resource inventory. Permissions, project revisions and existing approval requirements still apply after discovery. A model cannot call an undeclared tool merely because its name appears in the directory.

When supported by the selected Gemini model, the gateway caches the static system instructions, tool directory and loaded definitions on Gemini for **one hour**. It keeps at most **eight cache entries per running gateway process**, separated by authenticated context, project/page, model, settings revision and exact definitions. Messages, screenshots, recordings and returned application data are not placed in this explicit cache. Unused entries are evicted; remote entries remaining after a gateway restart expire according to their one-hour TTL. Models or prefixes that do not support caching fall back to ordinary requests. Final answers at the step limit use an uncached request without tools.

There is no per-message token allowance or aggregate tool-call cap that silently removes tools. The configured step limit bounds model rounds. Request size, context size, individual response size and per-round call bounds remain in force.

Monthly usage charges Gemini's reported total tokens minus cached input tokens. Cached tokens are displayed separately; output and thinking tokens count toward the allowance. A limited request first counts its full prompt and reserves that count plus its maximum response size, then reconciles to actual usage. This conservative admission requires sufficient headroom even for a cached request. Concurrent requests share the same durable ledger. Known rejected requests release their reservation; interrupted requests with an unknown provider outcome retain it across restarts. The allowance resets at the start of each UTC calendar month. This accounting is an application limit, not an invoice estimate: Google's cached-token and cache-storage charges still apply separately. Usage counters are local operational data and are not included in configuration backups.

Consequential actions show a review card with the exact operation and arguments. Approval is tied to that pending call; the model cannot grant its own approval. Declining returns a refusal to the conversation. Existing API authorization, revision checks, dependency checks, publication reviews and backup recovery isolation still apply. A tool is unavailable when the user lacks its permission.

Changes made through gateway tools are saved gateway resources. Designer queries, scripts and assets refresh automatically as described above. Reload an already-open settings editor after other gateway changes; revision-aware editors reject stale saves. Designer draft tools operate on the open unsaved project instead. Use the draft Save tool before requesting publication. Code edits save code; running a script is a separate, permission-checked operation.

## Test the published operator runtime

Ask **“Check the operator session for this project.”** Runtime tools are discoverable when the engineering account has Design permission and the corresponding View, Operate or Commands grant. They target the project's published runtime; Designer Preview remains the place to test an unpublished draft.

Runtime testing uses a separate operator session for the same signed-in account. If that session is missing, Ask Spark can request an approved operator sign-in, then present a secure password prompt. The username comes from the current engineering account. The password and operator session credentials never enter the conversation or Gemini request. If another account is already signed into the operator application, Ask Spark refuses to replace it. Each operation checks the project, required grant and expected account again on the gateway.

Once authorized, the assistant can inspect the published runtime and invoke the available runtime tools. Writes and commands retain their review cards and the same server validation as manual operator actions. A failed or interrupted mutation is not automatically retried, because the first request may already have completed. Publication, real equipment actions and script execution are separate operations; a successful visual capture does not authorize them.

## Workshop

`examples/ask-spark.json` is an independently authored synthetic canvas with three misaligned readouts. Import it as a separate development project, configure AI, and open the designer. No industrial equipment, database, gateway tags or executable scripts are required.

1. Select the three readouts and ask for left alignment and equal widths. Confirm their Z order stays unchanged.
2. Use the action's Undo, then repeat with different spacing.
3. Paste a screenshot and ask for an explanation of the layout before requesting changes.
4. Dictate a request, stop recording, edit the transcript, then send it.
5. Ask for a reusable faceplate from the selected controls. Inspect the new template and its parameters.
6. Ask to validate, save and preview. Review publication separately if you want an operator version.
7. Ask **“Explain these three readouts in a Markdown table, with a checklist underneath.”** Verify the table and checklist render in the answer. Ask for a short code example and try its Copy code button.
8. Ask **“Find the tools for reviewing backups; explain what each does without changing anything.”** Ask Spark discovers that category without granting approval to use its write operations. Continue with a permitted read if desired.
9. In AI settings, verify the model-step default is 100. Temporarily choose a smaller limit in this development gateway, save, and start a new message. At the limit the assistant summarizes with tools disabled. Restore your preferred limit afterward.
10. From Projects or Gateway Settings, ask to open this workshop and its screen. Continue in the same conversation, ask for a batch of layout edits, then ask the assistant to capture and critique the rendered canvas.
11. Paste a synthetic screenshot you created and request two named crops. Review the thumbnails, approve once, and confirm the assets appear without reloading. Keep their native resolution when placing them on the screen.
12. Optionally create a harmless named query or script on a disposable gateway, then ask the assistant to update it. Confirm a clean Designer editor refreshes, while unsaved text is preserved with a notice. This optional exercise requires its normal gateway resources and permissions.
13. After explicitly publishing this synthetic workshop, ask to check its operator session and read its published runtime. Use the same account's secure sign-in prompt if necessary. No equipment writes are needed for this exercise.

Requires a build containing Ask Spark; older preview.12 release assets do not contain this feature. A Gemini account/key and outbound access to `generativelanguage.googleapis.com` are required for live AI calls and may incur provider charges. The workshop itself remains usable manually without AI.

## Implementation and verification

The gateway calls Gemini's fixed HTTPS `generateContent` endpoint using `parametersJsonSchema` declarations. It preserves raw model content and thought signatures across function-call continuations. The browser runs only registered tool handlers and returns all results for a model turn together. Tool IDs, continuation tokens, exact approval arguments, user ownership and budgets are checked on the server. No model-supplied URL, tool definition or arbitrary browser evaluator is used.

The API key is never bundled into the frontend. Voice uses MediaRecorder and the gateway transcription endpoint, not browser speech recognition. Audio is not kept after transcription. Image requests validate MIME/signatures and size bounds before provider submission. Conversations are encrypted and isolated by user. The recovered-gateway quarantine blocks external AI calls until existing recovery checks permit them.

The normal build gates run frontend/backend lint, offline unit and acceptance tests, and cyclomatic complexity checks. Ask Spark tests cover tool coverage, permissions, discovery continuations, configured step limits, cache isolation and fallback, monthly admission and accounting, Markdown rendering, secret redaction, signed provider replay, approval replay/decline, concurrent reads and ordered edits, atomic edit batches, image/audio bounds, retained image crops, rendered canvas capture, authorized project transitions, operator audience and account isolation, resource refresh, stale snapshots and Undo. Fake-provider tests do not establish live Gemini availability; the AI settings test verifies the configured account/model.

Provider contracts: [Gemini function declarations](https://ai.google.dev/api/generate-content#FunctionDeclaration), [function calling](https://ai.google.dev/gemini-api/docs/function-calling), [context caching](https://ai.google.dev/api/caching), [token counting](https://ai.google.dev/api/tokens), [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash).
