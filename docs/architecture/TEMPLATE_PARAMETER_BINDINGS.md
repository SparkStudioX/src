# Template parameter expressions

Select a template instance or repeater, then choose **Property sheet → Template parameters → ƒx** beside a declared parameter. The same expression editor used by component properties provides named references, a live typed result, Apply, Cancel and Remove binding. Applying a binding creates a normal Designer history step. Removing it restores the instance's saved literal override or shared default; unfinished literal edits are discarded when binding mode changes.

## Sources and types

Parameter expressions support **Parameter**, **Form input**, **Custom property**, **Session state**, **Screen state** and **Private instance state** references in the containing context. Custom sources may belong to the wrapper itself or a sibling in that same document. Inputs must be non-password controls. Private state belongs to the immediately containing template, never the child being created. The [state-source guide](TEMPLATE_PARAMETER_STATE.md) defines direct state scopes, snapshots and validation. Direct tag sources remain planned.

Every expression reads the parent context before the child shadows parameter names. It cannot read the child's inputs or another computed child parameter. Thus a child `quantity` expression may read a declared parent `quantity`, but there is no dependency graph between child parameters or an expression writeback path. An intermediate template must declare parameters it wants its nested instances to reference. This top-down rule prevents parameter cycles.

Expressions use the existing bounded primitive grammar: arithmetic, comparisons, Boolean operators and conditional expressions. There are no function calls, member access, JavaScript evaluation or Python execution. Each parameter expression permits 2,048 characters, 256 tokens, 32 expression levels and 32 named references. An instance may bind up to 64 declared parameters. Expression values are bounded scalars; text results are at most 4,096 characters.

Results use the referenced template's existing Text, Number or Boolean conversion rules. Numeric values must be finite and whole values must fit JavaScript's exact integer range; numeric text must use JSON number syntax. Boolean values accept native Booleans or exactly `true`/`false` text. Text accepts scalar values. A computed string is literal data: braces in its result do not trigger another parameter-substitution pass.

## Precedence and failures

At each instance boundary the order is:

1. Template defaults and saved instance overrides, substituted once against the parent context.
2. Computed parameter-binding results.
3. Saved-row overrides or literal mapped query-row values.
4. Final declared parameter conversion.

Row values keep their existing precedence. A shared binding can therefore drive quantity or permissions across a repeater while each row retains its own machine identifier. All bindings are still evaluated and checked before rows are displayed; an invalid binding never hides behind a row override or silently falls back to an authored value.

Each referenced parent input must be available and valid under its own input definition, even if a conditional expression currently does not consume that reference. Direct state references must also be available bounded scalars. Invalid or unavailable parent values show **Parameters unavailable** or **Rows unavailable** and prevent dependent controls from acting. Unrelated invalid inputs do not block that child. A changed binding context remounts the dependent forms, discarding old local edits and invalidating pending callbacks so a note or late action result cannot be reused for another machine. Browser session/screen state retains its separately declared lifetime.

## Publication and gateway actions

Bindings are saved with their instance in `props.parameterBindings` and travel in `.sparkproj` packages:

```json
{
  "parameterBindings": {
    "quantity": {
      "expression": "amount * factor",
      "references": {
        "amount": { "kind": "input", "key": "batchSize" },
        "factor": { "kind": "custom", "key": "multiplier" }
      }
    }
  }
}
```

The gateway captures the expression and its authored custom/input definitions from the same immutable publication as the action. Action and table-edit requests may carry `bindingInputs`, an outer-to-inner array of referenced parent input maps aligned with the instance path. Empty maps preserve alignment at boundaries without input references. Extra keys, missing required values, invalid shapes and wrong-depth arrays fail. Parent fields unrelated to bindings, including passwords, are not sent. Popup origins capture their own independent parent-input snapshots at opening; popup descendants use a separate action array.

These snapshots are explicit, validated user input, not trusted computed parameters. The gateway reconstructs every expression top-down, validates input types and bounds, and rechecks query-backed choices and repeater membership using the captured query definitions. It then derives the final leaf's parameters and separately validates that leaf's submitted form. Unknown action-request fields, including client-supplied computed template values or code, are rejected. Stale publications fail through the existing revision boundary. A binding adds no permission or implicit database/device write; authored scripts must still enforce their business rules.

Direct state references use a separate sparse `bindingState` array at the same instance boundaries. The gateway validates referenced values against captured published declaration types and recomputes expressions. It rejects extra/missing sources and inconsistent shared values within one path. Popup opening snapshots remain separate from the popup's later action values. No raw state map is exposed to Python; see [TEMPLATE_PARAMETER_STATE.md](TEMPLATE_PARAMETER_STATE.md#gateway-request-boundary).

## Workshop and verification

The synthetic [template parameter workshop](../../examples/template-parameter-bindings.json) contains two templates, a regular screen and an inspection popup. It needs no tags, database or external equipment. Import the generated local-only `artifacts/examples/template-parameter-bindings.sparkproj`, or add its resources with the existing authenticated example loader:

```powershell
node tools/load-example.mjs template-parameter-bindings
```

Choose Assembly or Packaging, edit the batch quantity, and preview the nested form. The standalone card doubles the parent batch through its custom multiplier, then its inner form adds that card's extra quantity. The saved repeater preserves its A/B machine identities with a shared batch and independent notes. Change machine to observe draft invalidation, enter `21` to observe the parent bound, toggle the Boolean permission, and open an inspection from each row. Preview scripts return their reconstructed parameters and leaf inputs without writing any data.

Model, authoring, runtime, API and observed browser results are recorded in [PARITY.md](PARITY.md). Private template state and property/lifecycle events are covered by their own guides. Nested query sources, direct tag parameter references, parameter writeback and atomic multi-resource releases remain separate roadmap work.
