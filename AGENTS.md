# SparkStudio source boundary

This checkout contains independently authored SparkStudio application source only.

- NEVER copy private reference material into this checkout, even temporarily or under an ignored directory.
- Do not commit runtime data, connection credentials, certificates, private keys, downloaded runtimes, package caches, installers, or generated output.
- The marketing website and downloadable releases have separate repositories. Do not embed either repository here.
- Add new authored source files deliberately. Update the source policy only after reviewing why the file belongs here; do not relax it to accommodate a reference artifact.
- Before committing, run the source-boundary checks against the entire staged index, inspect every staged path, and inspect the staged diff. Ignore rules alone are insufficient.
- Keep the local hooks installed and the source-boundary CI check enabled. A passing automated check supplements human review; it does not establish provenance by itself.

Build and test commands are documented in README.md. Existing source-relative paths must remain portable to a fresh clone.
