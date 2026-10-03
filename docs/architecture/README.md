# Architecture and feature documentation

These guides describe the current SparkStudio source, including development work that may be newer than the downloadable installer. The preview.13 release-guide and navigation review date is **October 3, 2026**; the broader source/documentation audit remains dated September 30. A documented implementation is not a claim that every browser, deployment, integration or failure condition has passed acceptance.

Start with [Product and architecture](PRODUCT.md), then [Projects](PROJECTS.md). For installation, use the guide attached to your exact release; [Windows installation](WINDOWS_INSTALLER.md) describes preview.13. [Verification and roadmap](PARITY.md) records package verification and release status, separating dated observations from current capability summaries and remaining gates. Earlier ledger entries retain the facts and limitations of their original checks; they are not instructions to start an old development package or assertions about the currently running gateway.

Preview.13 adds [Ask Spark](ASK_SPARK.md) and the [MQTT](MQTT_SETUP.md), [MTConnect](MTCONNECT_SETUP.md) and [i3X](I3X_SETUP.md) source clients. The source walkthroughs explain creating tags from a connection's reviewed import or later in Tags. Windows preview.12 and Docker preview.11-docker.1 do not include these features; this Windows release does not update the published Docker image. Consult the ledger for the candidate's publication and acceptance status.

## Overview and installation

- [Product and architecture](PRODUCT.md)
- [Projects and portable packages](PROJECTS.md)
- [Alarms, retained history and synthetic workshop](PROCESS_DATA.md)
- [Windows installer](WINDOWS_INSTALLER.md)
- [Docker deployment](DOCKER_RELEASE.md)
- [Preview release cycle](RELEASE_PROCESS.md)
- [Build process and quality checks](BUILD_PROCESS.md)
- [Security and accounts](SECURITY.md)
- [Verification and roadmap](PARITY.md)
- [Synthetic gateway load testing](LOAD_TESTING.md)

## Designer and presentation

- [Component coverage](COMPONENTS.md)
- [Validated inputs and barcode entry](VALIDATED_INPUTS.md)
- [Embedded, tab, split and dock containers](VIEW_CONTAINERS.md)
- [Atomic table batch editing](TABLE_BATCH_EDITING.md)
- [Property sheet, input events and groups](PROPERTY_SHEET_EVENTS.md)
- [Canvas precision](CANVAS_PRECISION.md)
- [Authoring defaults](AUTHORING_DEFAULTS.md)
- [Images and popups](ASSETS_POPUPS.md)
- [Asset library](ASSET_LIBRARY.md)
- [Drawing and symbols](DRAWING.md)
- [Visual styles](VISUAL_STYLES.md)
- [Caption translations](LOCALIZATION.md)

## Bindings, state and reusable forms

- [Property bindings](PROPERTY_BINDINGS.md)
- [Component runtime property bindings](RUNTIME_PROPERTY_BINDINGS.md)
- [Application state](APPLICATION_STATE.md)
- [Input-state bindings](INPUT_STATE_BINDINGS.md)
- [Private instance state](INSTANCE_STATE.md)
- [Templates and repeaters](TEMPLATES.md)
- [Nested forms](NESTED_FORMS.md)
- [Template parameter bindings](TEMPLATE_PARAMETER_BINDINGS.md)
- [State-driven template parameters](TEMPLATE_PARAMETER_STATE.md)
- [Query controls and tables](QUERY_CONTROLS.md)
- [Query-backed properties](QUERY_PROPERTIES.md)
- [Read-query testing](QUERY_TESTING.md)

## Scripting and events

- [Scripting workspace](SCRIPTING.md)
- [Gateway events](GATEWAY_EVENTS.md)
- [Component property/lifecycle events](COMPONENT_LIFECYCLE.md)
- [Focus, keyboard and pointer interactions](COMPONENT_INTERACTIONS.md)
- [Component messages](COMPONENT_MESSAGING.md)
- [Python UI actions](PYTHON_UI.md)
- [Python component events](PYTHON_COMPONENT_EVENTS.md)
- [Lifecycle and session messaging workshop](LIFECYCLE_SESSION_WORKSHOP.md)

## Project tools and diagnostics

- [Ask Spark: setup, voice, tools and workshop](ASK_SPARK.md)
- [Project search](PROJECT_SEARCH.md)
- [Resource changes](RESOURCE_CHANGES.md)
- [Bulk replacement](BULK_REPLACEMENT.md)
- [Publication history](PUBLICATION_HISTORY.md)
- [Preview communication](PREVIEW_COMMUNICATION.md)
- [Designer diagnostics](DESIGNER_DIAGNOSTICS.md)

## Data source setup

- [MQTT setup walkthrough](MQTT_SETUP.md)
- [MTConnect setup walkthrough](MTCONNECT_SETUP.md)
- [i3X setup walkthrough](I3X_SETUP.md)

## Gateway and operations

- [Gateway console](GATEWAY_CONSOLE.md)
- [Connection operations](CONNECTION_OPERATIONS.md)
- [Industrial protocol support plan](INDUSTRIAL_PROTOCOLS.md)
- [Industrial device setup and workshop](INDUSTRIAL_DEVICE_CONNECTIONS.md)
- [Industrial connector technical specification](INDUSTRIAL_CONNECTOR_SPECIFICATION.md)
- [Tag engineering](TAG_ENGINEERING.md)
- [Deployment settings](DEPLOYMENT_SETTINGS.md)
- [Network access](NETWORK_ACCESS.md)
- [Offline gateway recovery](GATEWAY_RECOVERY.md)
- [Scheduled configuration backups](SCHEDULED_BACKUPS.md)

## Workshops and verification

Use [the example catalog and build instructions](../../examples/README.md) for independently authored workshops. Portable examples import as unpublished projects; setup-required examples also need the documented gateway resources. Match a workshop to its companion build. The preview.13 collection retains 37 portable projects, including runtime property bindings and [visitor check-in with camera capture](VISITOR_CHECKIN.md). Ask Spark and read-only data sources are setup-required exercises with their own prerequisites. Visitor check-in additionally needs a webcam and Labelary access. Preview.10's earlier bundle has 35 portable projects and lacks these two additions. Python component events and lifecycle/session messaging require preview.9 or newer; preview.8 and earlier do not include those features.

`artifacts/sparkproj/` is the only maintained location for loose `.sparkproj` packages, with guides and provenance in `index.json`. It is ignored by Git. `node tools/build-workshops.mjs --version <version>` updates this directory and creates an immutable ZIP, manifest and checksums under `artifacts/workshops/<version>/`, without duplicate loose packages. Example loaders import authored JSON directly. Historical artifact paths in dated verification records may have been archived or removed; use the current package directory or the frozen release ZIP.

The September 30 documentation audit reconciled the overview, reusable forms, bindings, state, events, recovery and roadmap summaries against current frontend models/editors, gateway validators/services, Python helpers and existing verification records. It also checked documentation navigation, local links and referenced tool paths. It did not rerun all runtime, installer, network or database acceptance suites. Current source behavior, recorded verification and released binary coverage remain distinct.

## Latest roadmap workshops

- [Visitor check-in, camera capture and Labelary badges](VISITOR_CHECKIN.md)
- [Unified application publication](UNIFIED_PUBLICATION.md)
- [Tag parameter and indirect bindings](TAG_PARAMETER_BINDINGS.md)
- [Datasets and nested query rows](DATASETS_NESTED_QUERIES.md)
- [Supplied-data charts](CHARTS.md)
- [Versioned tag models](TAG_MODELS.md)
- [Delegated access boundaries](FINE_GRAINED_ACCESS.md)
- [Equipment command confirmation and readback](EQUIPMENT_COMMANDS.md)
