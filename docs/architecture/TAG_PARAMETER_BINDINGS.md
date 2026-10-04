# Tag sources for template parameters

Template and repeater parameter **ƒx** supports **Tag**, alongside the existing parent parameter, input, custom-property and state sources. Select Tag, choose an address and use its reference alias in the expression. The result follows the declared Text, Number or Boolean parameter conversion. The editor stages Apply/Cancel and Remove binding; removing restores the saved override/default.

A tag address is either fixed (`[default]BindingWorkshop/A/Count`) or uses up to sixteen parent-parameter placeholders (`[default]BindingWorkshop/{machine}/Count`). The complete authored and resolved address is limited to 1,024 characters. Braces must be paired; every placeholder must name a declared containing parameter. Substitution runs once. Resolved values cannot introduce another placeholder or control characters. There is no general expression evaluation in an address, recursive tag lookup, address writeback or implicit device write.

The containing form supplies address parameters before the child shadows parameter names. A saved/query row or outer template can therefore select a bounded indirect address for its child. The tag value must be bounded text, Boolean or an exact finite number and have Good quality. Missing, denied, disconnected, uncertain or bad-quality sources block the dependent form. Every tag reference is checked even in an unused expression branch and even if a saved/query row later overrides the result. Simulated tags remain marked in runtime diagnostics.

A changed bound value remounts the dependent form, dropping local input/private-state drafts and invalidating pending callbacks. Independent siblings keep their state. Popup source checks compare every captured ancestor scope; a changed tag context invalidates that opening. Reopening obtains current values. Equal tag values do not repeatedly reset the form because timestamps are not form identity.

Published actions reconstruct tag addresses from captured definitions and already validated parent scopes. They read the current gateway tag value, require its quality and apply the caller's project tag-read permission before running Python. Client tag samples and computed parameters are never accepted as an authority source. An action uses the current gateway read at reconstruction time; this is not a transactional lock across device changes. Scripts needing compare-and-set or equipment interlocks must enforce those rules in their actual write path.

## Workshop

The independently authored [Tag-driven template parameters](../../examples/tag-template-parameters.json) fixture needs isolated gateway setup. Create the two synthetic memory tags under `[default]BindingWorkshop/` declared in the fixture; grant the test operator read access to that prefix. Load the screens and templates, explicitly publish, and open **Tag template parameters**. This fixture is classified as setup-required because portable project packages do not provision gateway tags.

Each saved machine row contains a nested form whose numeric `count` comes directly from its own tag. Enter separate notes, then change only A's synthetic memory tag in the workspace's **Tags** editor and verify only A's form resets. Set a source unavailable or remove its read grant and verify its form cannot act. Restore the source and use **Read current gateway context** to inspect the gateway-reconstructed number and local note. The button performs no tag or database writes.

Compatibility: builds containing this increment. Number/Boolean conversion, precedence, expression bounds and sparse parent-input/state snapshots retain the [template parameter contract](TEMPLATE_PARAMETER_BINDINGS.md). Tag sources are not supported as query-parameter expressions.
