# SparkStudio source boundary

This checkout contains independently authored SparkStudio application source only.

- NEVER copy private reference material into this checkout, even temporarily or under an ignored directory.
- Do not commit runtime data, connection credentials, certificates, private keys, downloaded runtimes, package caches, installers, or generated output.
- The marketing website and downloadable releases have separate repositories. Do not embed either repository here.
- Add new authored source files deliberately. Update the source policy only after reviewing why the file belongs here; do not relax it to accommodate a reference artifact.
- Before committing, run the source-boundary checks against the entire staged index, inspect every staged path, and inspect the staged diff. Ignore rules alone are insufficient.
- Keep the local hooks installed and the source-boundary CI check enabled. A passing automated check supplements human review; it does not establish provenance by itself.

Build and test commands are documented in README.md. Existing source-relative paths must remain portable to a fresh clone.

## Standard release cycle

Follow [the preview release process](docs/architecture/RELEASE_PROCESS.md) for every request to ship or publish an application release. Completion includes a new preview version, a clean-source Windows installer build, matching verified workshops/checksums, GitHub prerelease publication, updated WWW download links, reviewed hosted docs and successful live verification. A source push alone is not a completed release. Requests explicitly limited to docs or website maintenance can publish independently. Preserve unrelated ongoing changes and report any unfinished release stage accurately.

For each substantial user-facing feature, add or update an independently authored workshop and its entry in `examples/catalog.json`. Include a short walkthrough, expected behavior, prerequisites and compatibility. Validate portable `.sparkproj` workshops through import, explicit publication and re-export before release; classify examples that need gateway setup separately. Never build distributable examples from development project exports, private reference projects or live gateway data. `artifacts/sparkproj/` is the ONLY maintained location for loose `.sparkproj` files: add and update packages there, never under versioned workshop or example folders. Their guides and current index live alongside them. Immutable release ZIPs, manifests and checksums belong under ignored `artifacts/workshops/<version>/`; verification reads the frozen ZIP instead of the current packages. Generated packages and bundles ship as release assets, not source commits.
