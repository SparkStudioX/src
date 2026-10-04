#!/usr/bin/env node
// This guard is a source-boundary check, not a complete secret scanner or proof
// of authorship. Review changes to this file and the allowed paths themselves.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const maxBlobBytes = 1024 * 1024;
const maxBatchBytes = 64 * 1024 * 1024;
const binaryAsset = 'examples/assets/assembly-cell.png';
const binaryHash = '0df6492ea1fd39c00f5a4a8b6f96e39c5a6729f211ded9f904be96b18dc4600c';
const rootFiles = new Set([
  '.gitignore', '.gitattributes', '.dockerignore', 'AGENTS.md', 'README.md', 'SECURITY.md',
  'CONTRIBUTING.md', 'NOTICE.md', 'LICENSE', 'LICENSE.md', 'LICENSE.txt',
  'Dockerfile', 'compose.yaml', 'Directory.Build.props', 'Directory.Build.targets', '.editorconfig', 'ruff.toml', 'global.json', 'NuGet.Config',
]);
const webFiles = new Set([
  'apps/web/check-model-readiness.mjs', 'apps/web/check-model-operations-ui.mjs',
  'apps/web/check-designer-model.mjs', 'apps/web/check-model-workspace.mjs', 'apps/web/check-model-builder.mjs', 'apps/web/check-model-builder-ui.mjs', 'apps/web/check-model-navigation.mjs',
  'apps/web/check-source-connections.mjs',
  'apps/web/src/bindingDiagnostics.tsx',
  'apps/web/check-visitor-checkin.mjs',
  'apps/web/check-component-message-receivers.mjs',
  'apps/web/src/componentMessageReceivers.ts', 'apps/web/src/MessageReceiverList.tsx',
  'apps/web/src/imageSource.ts',
  'apps/web/src/ComputerCamera.tsx', 'apps/web/src/computerCameraModel.ts', 'apps/web/src/computerCamera.css',
  'apps/web/check-gateway-configuration.mjs',
  'apps/web/check-device-connections.mjs',
  'apps/web/check-gateway-deployment.mjs',
  'apps/web/check-native-tag-actions.mjs',
  'apps/web/check-security-settings.mjs',
  'apps/web/test-module-files.mjs',
  'apps/web/src/runtimeProperties.json',
  'apps/web/src/modelParameterContract.json',
  'apps/web/check-runtime-properties.mjs',
  'apps/web/check-resilience.mjs', 'apps/web/check-process-data-settings.mjs', 'apps/web/check-opc-certificates.mjs',
  'apps/web/check-input-validation.mjs', 'apps/web/check-table-batch-editor.mjs', 'apps/web/check-view-containers.mjs',
  'apps/web/check-chart-renderer.mjs', 'apps/web/check-chart-authoring.mjs', 'apps/web/check-equipment-command-ui.mjs', 'apps/web/check-application-publication.mjs', 'apps/web/check-binding-data.mjs',
  'apps/web/package.json', 'apps/web/package-lock.json', 'apps/web/tsconfig.json',
  'apps/web/eslint.config.mjs',
  'apps/web/vite.config.ts', 'apps/web/index.html', 'apps/web/check-template-model.mjs',
  'apps/web/check-popup-model.mjs', 'apps/web/public/spark.svg',
  'apps/web/check-popup-source.mjs',
  'apps/web/check-input-model.mjs', 'apps/web/check-canvas-model.mjs',
  'apps/web/check-browser-scripts.mjs',
  'apps/web/check-table-selection.mjs',
  'apps/web/check-property-bindings.mjs', 'apps/web/check-bound-components.mjs',
  'apps/web/check-input-events.mjs',
  'apps/web/check-project-routing.mjs',
  'apps/web/check-query-options.mjs',
  'apps/web/check-designer-documents.mjs',
  'apps/web/check-project-panes.mjs',
  'apps/web/check-preview-communication.mjs', 'apps/web/check-designer-diagnostics.mjs',
  'apps/web/check-runtime-quality.mjs',
  'apps/web/check-runtime-navigation.mjs',
  'apps/web/check-query-repeater.mjs',
  'apps/web/check-property-authoring.mjs',
  'apps/web/check-query-property-authoring.mjs',
  'apps/web/check-query-properties.mjs',
  'apps/web/check-template-parameter-authoring.mjs',
  'apps/web/check-template-parameter-bindings.mjs',
  'apps/web/check-template-parameter-state.mjs', 'apps/web/check-template-parameter-state-authoring.mjs',
  'apps/web/check-instance-state.mjs', 'apps/web/check-instance-state-authoring.mjs',
  'apps/web/check-component-events.mjs', 'apps/web/check-component-events-authoring.mjs',
  'apps/web/check-component-messages.mjs', 'apps/web/check-component-message-helpers.mjs',
  'apps/web/check-component-actions-authoring.mjs', 'apps/web/check-runtime-session-messaging.mjs',
  'apps/web/check-script-syntax.mjs',
  'apps/web/check-python-ui.mjs',
  'apps/web/check-python-component-events.mjs',
  'apps/web/check-state-controls.mjs',
  'apps/web/check-state-control-authoring.mjs',
  'apps/web/check-process-displays.mjs',
  'apps/web/check-process-display-authoring.mjs',
  'apps/web/check-list-tree-authoring.mjs',
  'apps/web/check-list-tree.mjs',
  'apps/web/check-table-paging.mjs', 'apps/web/check-tag-manager-scaling.mjs',
  'apps/web/check-table-columns.mjs',
  'apps/web/check-table-columns-authoring.mjs',
  'apps/web/check-table-editing.mjs',
  'apps/web/check-table-editing-renderer.mjs',
  'apps/web/check-table-editing-authoring.mjs',
  'apps/web/check-table-editing-contexts.mjs',
  'apps/web/check-drawing-components.mjs', 'apps/web/check-drawing-renderer.mjs', 'apps/web/check-drawing-authoring.mjs',
  'apps/web/check-auth-session.mjs',
  'apps/web/check-auth-ui.mjs',
  'apps/web/check-gateway-backups.mjs',
  'apps/web/check-account-settings.mjs',
  'apps/web/check-state-authoring.mjs', 'apps/web/check-application-state.mjs',
  'apps/web/check-nested-templates.mjs', 'apps/web/check-nested-popups.mjs',
  'apps/web/check-input-state-bindings.mjs', 'apps/web/check-input-state-authoring.mjs',
]);
const toolFiles = new Set([
  'test-model-operations-workshop.mjs',
  // Independently authored mandatory build gates, orchestration and analyzer policy.
  'build-context.mjs', 'build-quality.mjs', 'build-quality.test.mjs', 'quality-gates.mjs', 'dotnet-environment.mjs', 'lint-backend.mjs', 'test-build-hooks.mjs',
  'lint-python.py', 'ruff-runtime.json', 'analyze-python-complexity.py', 'test-backend-lint.mjs',
  'check-complexity.mjs', 'complexity-policy.mjs', 'complexity.test.mjs', 'complexity-baseline.json',
  'complexity/SparkStudio.Complexity.csproj', 'complexity/Program.cs',
  'run-data-source-simulators.mjs', 'load-data-sources-example.mjs', 'test-data-sources-workshop.mjs',
  'uns-model-fixture.mjs', 'test-uns-model-workshop.mjs',
  // Authored Linux container packaging, local administration and release checks.
  'docker-entrypoint.py', 'test-docker-entrypoint.py', 'container-admin.py', 'test-container-admin.py',
  'package-notice-supplements.mjs', 'collect-docker-runtime.py', 'write-docker-notices.mjs', 'test-docker-notices.mjs',
  'test-docker-deployment.mjs',
  'analyze-web-complexity.mjs', 'test-web-complexity.mjs',
  'test-computer-camera.mjs',
  'web-model-module.mjs',
  'load-process-data-example.mjs', 'test-all.mjs', 'test-load-runtime.mjs', 'test-engineering-policy.mjs', 'test-environment.mjs', 'version.mjs', 'write-sbom.mjs', 'fixtures/TestReport.cs',
  'load-table-batch-example.mjs', 'test-application-workflows.mjs', 'test-view-containers.mjs',
  'test-equipment-commands.mjs', 'test-tag-parameter-workshop.mjs', 'test-fine-grained-access.mjs', 'load-access-permissions-example.mjs', 'test-charts.mjs', 'test-tag-model.mjs', 'test-unified-publication-workshop.mjs',
  'load-unit-model-example.mjs', 'load-equipment-commands-example.mjs',
  'load-industrial-devices-example.mjs',
  'bootstrap.ps1', 'build.ps1', 'dev.ps1', 'publish-windows.ps1', 'install-service.ps1',
  'build-installer.ps1', 'test-installer.ps1', 'test-installer-auth.mjs', 'test-gateway-readiness.mjs', 'generate-example-assets.ps1',
  'load-example.mjs', 'test-assets-popups.mjs', 'test-gateway.mjs', 'test-runtime-actions.mjs',
  'workshop-packages.mjs', 'build-workshops.mjs', 'test-workshop-build.mjs', 'test-workshop-packages.mjs',
  'test-project-search.mjs',
  'test-resource-changes.mjs',
  'test-bulk-replacement.mjs',
  'test-authoring-assets.mjs',
  'test-preview-communication.mjs', 'test-preview-session-store.mjs',
  'test-publication-history.mjs', 'test-publication-history-store.mjs',
  'test-gateway-console.mjs', 'test-gateway-deployment.mjs',
  'test-deployment-settings.mjs', 'test-gateway-connections.mjs', 'test-query-cancellation.mjs', 'load-query-testing-example.mjs',
  'test-gateway-recovery.mjs', 'test-recovery-quarantine.mjs', 'test-recovery-integration.mjs',
  'test-tag-engineering.mjs', 'load-tag-engineering-example.mjs',
  'load-network-example.mjs', 'load-backup-example.mjs',
  'test-backup-destinations.mjs', 'test-backup-schedule.mjs', 'test-backups-api.mjs', 'test-configuration-backup.mjs',
  'fixtures/BackupDestinationChecks.cs', 'fixtures/BackupS3Checks.cs',
  'test-visual-styles.mjs', 'test-visual-styles-rendering.mjs', 'test-visual-styles-api.mjs',
  'test-localization.mjs', 'test-localization-rendering.mjs', 'test-localization-api.mjs',
  'test-runtime.mjs', 'test-tag-definitions.mjs', 'test-template-runtime.mjs',
  'check-source.mjs', 'test-source-boundary.mjs', 'install-source-hooks.ps1',
  'test-input-controls.mjs',
  'load-sqlite-example.mjs', 'test-sqlite-application.mjs', 'test-script-resources.mjs',
  'test-gateway-events.mjs', 'test-gateway-events-workshop.mjs',
  'test-component-messaging-workshop.mjs',
  'test-python-ui-workshop.mjs',
  'test-python-component-events-workshop.mjs',
  'test-lifecycle-session-workshop.mjs',
  'test-sqlite-example.mjs',
  'test-property-bindings.mjs',
  'test-query-property-bindings.mjs',
  'test-component-events.mjs',
  'test-project-management.mjs', 'test-project-packages.mjs',
  'test-query-controls.mjs', 'load-equipment-example.mjs', 'test-equipment-example.mjs',
  'test-equipment-application.mjs',
  'test-runtime-navigation.mjs',
  'test-query-repeaters.mjs',
  'test-query-popup-actions.mjs',
  'test-template-properties.mjs',
  'test-template-parameters.mjs',
  'test-template-parameter-bindings.mjs',
  'test-template-parameter-state.mjs',
  'test-instance-state.mjs',
  'test-component-lifecycle.mjs',
  'test-state-controls.mjs',
  'test-process-displays.mjs',
  'test-selection-controls.mjs',
  'test-table-columns.mjs',
  'test-table-editing.mjs', 'test-drawing-components.mjs',
  'load-data-controls-example.mjs',
  'test-security.mjs', 'test-auth-session.mjs',
  'test-account-password.mjs',
  'test-application-state.mjs',
  'test-nested-templates.mjs',
  'test-input-state-bindings.mjs',
]);
const architectureDocs = new Set([
  'UNS_MODEL.md', 'UNS_MODEL_SETUP.md', 'UNS_MODEL_WORKSPACE.md',
  'BUILD_PROCESS.md',
  'MQTT_SETUP.md', 'MTCONNECT_SETUP.md', 'I3X_SETUP.md',
  'DOCKER_RELEASE.md',
  'VISITOR_CHECKIN.md',
  'RUNTIME_PROPERTY_BINDINGS.md',
  'PROCESS_DATA.md', 'LOAD_TESTING.md',
  'VALIDATED_INPUTS.md', 'COMPONENT_INTERACTIONS.md', 'TABLE_BATCH_EDITING.md', 'VIEW_CONTAINERS.md',
  'CHARTS.md', 'DATASETS_NESTED_QUERIES.md', 'TAG_PARAMETER_BINDINGS.md', 'TAG_MODELS.md',
  'FINE_GRAINED_ACCESS.md', 'UNIFIED_PUBLICATION.md', 'EQUIPMENT_COMMANDS.md',
  'RELEASE_PROCESS.md',
  'README.md',
  'ASSETS_POPUPS.md', 'COMPONENTS.md', 'PARITY.md', 'PRODUCT.md', 'TEMPLATES.md',
  'WINDOWS_INSTALLER.md', 'SOURCE_BOUNDARY.md',
  'SCRIPTING.md',
  'GATEWAY_EVENTS.md', 'COMPONENT_MESSAGING.md', 'PYTHON_UI.md',
  'PYTHON_COMPONENT_EVENTS.md',
  'LIFECYCLE_SESSION_WORKSHOP.md',
  'APPLICATION_STATE.md',
  'NESTED_FORMS.md',
  'INPUT_STATE_BINDINGS.md',
  'TEMPLATE_PARAMETER_BINDINGS.md',
  'TEMPLATE_PARAMETER_STATE.md',
  'INSTANCE_STATE.md',
  'COMPONENT_LIFECYCLE.md',
  'PROPERTY_BINDINGS.md',
  'QUERY_PROPERTIES.md',
  'PROPERTY_SHEET_EVENTS.md',
  'PROJECTS.md',
  'PROJECT_SEARCH.md',
  'RESOURCE_CHANGES.md',
  'BULK_REPLACEMENT.md',
  'CANVAS_PRECISION.md', 'VISUAL_STYLES.md', 'PREVIEW_COMMUNICATION.md',
  'PUBLICATION_HISTORY.md', 'ASSET_LIBRARY.md', 'DESIGNER_DIAGNOSTICS.md',
  'LOCALIZATION.md', 'AUTHORING_DEFAULTS.md', 'GATEWAY_CONSOLE.md',
  'QUERY_CONTROLS.md', 'DRAWING.md',
  'SECURITY.md',
  'DEPLOYMENT_SETTINGS.md', 'CONNECTION_OPERATIONS.md', 'QUERY_TESTING.md',
  'INDUSTRIAL_PROTOCOLS.md', 'INDUSTRIAL_CONNECTOR_SPECIFICATION.md',
  'INDUSTRIAL_DEVICE_CONNECTIONS.md',
  'GATEWAY_RECOVERY.md', 'SCHEDULED_BACKUPS.md',
  'TAG_ENGINEERING.md', 'NETWORK_ACCESS.md',
]);
const explicitFiles = new Set([
  // Independently authored model contracts, source mappings, publishing and their synthetic regression fixtures.
  'src/SparkStudio.Gateway.Tests/ModelContractChecks.cs', 'src/SparkStudio.Gateway.Tests/ModelManagementChecks.cs',
  'src/SparkStudio.Gateway.Tests/ModelPublishingChecks.cs', 'src/SparkStudio.Gateway.Tests/ModelPublishingBroker.cs',
  'examples/model-operations.json', 'docs/architecture/UNS_MODEL_OPERATIONS.md', 'docs/architecture/MODEL_PUBLISHING.md',
  // Authored UNS read scopes, v3 engine migration and portable Designer model tests.
  'src/SparkStudio.Gateway.Tests/UnsModelChecks.cs', 'src/SparkStudio.Gateway.Tests/ModelReadChecks.cs',
  'src/SparkStudio.Gateway.Tests/ModelReadApiChecks.cs',
  'src/SparkStudio.Gateway.Tests/ModelTemplateParameterChecks.cs',
  'examples/uns-model.json', 'examples/uns-faceplates.json',
  'src/SparkStudio.Gateway.Tests/ContainerHttpsRedirectChecks.cs',
  'src/SparkStudio.Gateway/packages.linux-x64.lock.json', 'src/SparkStudio.Gateway/packages.linux-arm64.lock.json',
  'src/SparkStudio.Connectors/packages.linux-x64.lock.json', 'src/SparkStudio.Connectors/packages.linux-arm64.lock.json',
  'src/SparkStudio.Gateway.Tests/NativeTagActionChecks.cs',
  'src/SparkStudio.Gateway.Tests/DeviceGatewayChecks.cs',
  'examples/runtime-property-bindings.json', 'examples/visitor-checkin.json',
  'src/SparkStudio.Gateway.Tests/RuntimePropertyBindingChecks.cs',
  'examples/validated-inputs.json', 'examples/component-interactions.json', 'examples/table-batch-workflow.json', 'examples/view-containers.json',
  'src/SparkStudio.Gateway.Tests/InputConstraintChecks.cs', 'src/SparkStudio.Gateway.Tests/InteractionEventChecks.cs', 'src/SparkStudio.Gateway.Tests/TableBatchChecks.cs',
  'examples/unified-publication.json', 'examples/dataset-nested-queries.json', 'examples/supplied-data-charts.json',
  'examples/tag-template-parameters.json', 'examples/unit-model-workshop.json', 'examples/access-permissions-workshop.json', 'examples/equipment-commands.json',
  'src/SparkStudio.Gateway.Tests/EquipmentCommandChecks.cs', 'src/SparkStudio.Gateway.Tests/ChartChecks.cs', 'src/SparkStudio.Gateway.Tests/BindingDataChecks.cs',
  'src/SparkStudio.Gateway.Tests/UnifiedPublicationChecks.cs',
  '.githooks/pre-commit', '.githooks/pre-push', '.github/workflows/source-boundary.yml', '.github/workflows/product.yml',
  'src/SparkStudio.Gateway.Tests/TestEnvironment.cs', 'src/SparkStudio.Gateway.Tests/ProcessDataChecks.cs',
  'src/SparkStudio.Gateway.Tests/DataMigrationChecks.cs', 'src/SparkStudio.Gateway.Tests/LiveOpcAcceptance.cs', 'src/SparkStudio.Gateway.Tests/ScriptScopePropagationChecks.cs',
  'src/SparkStudio.Gateway.Tests/SecurityHardeningChecks.cs', 'src/SparkStudio.Gateway.Tests/BackendReliabilityChecks.cs', 'src/SparkStudio.Gateway.Tests/GatewayLoadProbe.cs', 'src/SparkStudio.Gateway.Tests/ReadinessChecks.cs', 'src/SparkStudio.Gateway.Tests/TagCapacityChecks.cs',
  'src/SparkStudio.Gateway.Tests/TagNamespaceChecks.cs',
  'runtimes/python/worker.py', 'installer/SparkStudio.iss', 'installer/INSTALL-NOTES.txt',
  'examples/application-form.json', 'examples/reusable-applications.json', 'examples/assets-popups.json',
  'examples/catalog.json', 'examples/README.md',
  'examples/industrial-devices-workshop.json',
  'examples/project-search.json',
  'examples/resource-changes.json',
  'examples/bulk-replacement.json',
  'examples/canvas-precision.json', 'examples/visual-styles.json',
  'examples/process-data-workshop.json', 'examples/preview-communication.json', 'examples/publication-history.json',
  'examples/asset-library.json', 'examples/designer-diagnostics.json',
  'examples/localization.json', 'examples/authoring-defaults.json', 'examples/gateway-operations.json',
  'examples/operator-inputs.json',
  'examples/property-bindings.json',
  'examples/query-properties.json',
  'examples/component-workshop.json',
  'examples/template-properties.json',
  'examples/state-controls.json',
  'examples/process-displays.json', 'examples/process-graphics.json',
  'examples/data-controls.json',
  'examples/query-testing.json',
  'examples/gateway-recovery.json', 'examples/scheduled-backups.json',
  'examples/tag-engineering.json', 'examples/gateway-network.json',
  'examples/gateway-events.json', 'examples/component-messaging.json',
  'examples/python-ui.json',
  'examples/python-component-events.json',
  'examples/lifecycle-session-messaging.json',
  'src/SparkStudio.Gateway.Tests/PythonUiChecks.cs',
  'src/SparkStudio.Gateway.Tests/PythonComponentEventChecks.cs',
  'src/SparkStudio.Gateway.Tests/RuntimeSessionMessagingChecks.cs',
  'src/SparkStudio.Gateway.Tests/ComponentMessagingChecks.cs',
  'src/SparkStudio.Gateway.Tests/Program.cs', 'src/SparkStudio.Gateway.Tests/SparkStudio.Gateway.Tests.csproj',
  'examples/application-state.json',
  'examples/nested-forms.json',
  'examples/input-state-bindings.json',
  'examples/template-parameter-bindings.json',
  'examples/template-parameter-state.json',
  'examples/instance-state.json',
  'examples/component-events.json',
  'docs/SOURCE_BOUNDARY.md',
  'src/SparkStudio.Connectors/README.md', 'src/SparkStudio.Connectors/NuGet.Config',
  'src/SparkStudio.Connectors.Tests/README.md', 'src/SparkStudio.Gateway/appsettings.json',
  'src/SparkStudio.Connectors/packages.lock.json', 'src/SparkStudio.Connectors/packages.win-x64.lock.json',
  'src/SparkStudio.Connectors.Tests/packages.lock.json', 'src/SparkStudio.Connectors.Tests/packages.win-x64.lock.json',
  'src/SparkStudio.Gateway/packages.lock.json', 'src/SparkStudio.Gateway/packages.win-x64.lock.json',
  'installer/ServiceHelper/packages.win-x64.lock.json',
]);
const deniedSegments = new Set([
  '.git', '.data', '.tools', '.cache', '.npm-cache', '.nuget', 'node_modules',
  'bin', 'obj', 'dist', 'wwwroot', 'artifacts', 'gwbk', 'java', 'decompiled',
  'decompilation', 'downloads', 'pki', 'certs', 'certificates', '__pycache__',
]);
const deniedExtensions = /\.(?:java|class|jar|war|ear|modl|gwbk|zip|7z|rar|tar|tgz|gz|bz2|xz|exe|dll|msi|msix|pdb|so|dylib|a|lib|o|nupkg|whl|pyc|pyo|pfx|p12|pem|key|crt|cer|der|p7b|jks|keystore|db|sqlite|sqlite3|bak|log|cache|tsbuildinfo)$/i;
const contentRules = [
  ['proprietary Java namespace', /\bcom[.]inductiveautomation(?:[.]|\b)/i],
  ['decompiler output marker', /\bDecompiled\s+(?:with|by)\s+(?:CFR|Procyon|Fernflower|Vineflower|JADX)\b/i],
  ['decompiler output marker', /\b(?:Vineflower|Fernflower|Procyon|CFR)\s+decompiler\b/i],
  ['copied vendor documentation origin', /https?:\/\/(?:www[.])?docs[.]inductiveautomation[.]com(?:\/|\b)/i],
  ['vendor copyright marker', /Copyright[^\r\n]{0,90}Inductive\s+Automation/i],
  ['private key material', /-----BEGIN\s+(?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED)\s+)?PRIVATE\s+KEY-----/],
  ['certificate material', /-----BEGIN\s+CERTIFICATE-----/],
  ['credential-shaped token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|AKIA[A-Z0-9]{16})\b/],
];

function git(args, options = {}) {
  const result = spawnSync('git', ['--no-replace-objects', ...args], { cwd: process.cwd(), maxBuffer: maxBatchBytes, ...options });
  if (result.error) throw new Error(`Git could not run: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Git command failed (${args[0]}). ${result.stderr?.toString().trim().slice(0, 300) || ''}`);
  return result.stdout;
}
function records(buffer) { return buffer.toString('utf8').split('\0').filter(Boolean); }
function canonicalPath(file) {
  if (!file || /[\\\x00-\x1f\x7f:]/.test(file) || file.startsWith('/') || file.split('/').some(part => !part || part === '.' || part === '..')) return 'noncanonical or unsafe path';
  const parts = file.toLowerCase().split('/');
  if (parts.some(part => deniedSegments.has(part))) return 'generated, downloaded, runtime, or third-party directory';
  if (parts.some(part => part.startsWith('.env') || /[.]env(?:[.]|$)/.test(part))) return 'environment file';
  if (deniedExtensions.test(file)) return 'forbidden archive, binary, key, certificate, or generated extension';
  return null;
}
function allowedPath(file) {
  if (['apps/web/src/askSparkDesignerTools.json', 'apps/web/src/askSparkGatewayTools.json',
    'apps/web/check-ask-spark.mjs', 'apps/web/check-ask-spark-markdown.mjs', 'apps/web/check-ask-spark-designer.mjs', 'apps/web/check-ask-spark-gateway-tools.mjs',
    'apps/web/check-ask-spark-designer-ui.mjs', 'apps/web/check-ask-spark-runtime-tools.mjs', 'apps/web/check-ask-spark-visual.mjs',
    'src/SparkStudio.Gateway.Tests/AskSparkChecks.cs', 'src/SparkStudio.Gateway.Tests/AskSparkToolSearchChecks.cs',
    'src/SparkStudio.Gateway.Tests/AskSparkGenerationChecks.cs',
    'src/SparkStudio.Gateway.Tests/AskSparkProviderErrorChecks.cs',
    'src/SparkStudio.Gateway.Tests/AskSparkCacheChecks.cs', 'src/SparkStudio.Gateway.Tests/AskSparkUsageChecks.cs', 'src/SparkStudio.Gateway.Tests/AskSparkWorkspaceChecks.cs',
    'examples/ask-spark.json', 'docs/architecture/ASK_SPARK.md'].includes(file)) return true;
  if (['examples/data-sources.json', 'docs/architecture/DATA_SOURCES.md'].includes(file)) return true;
  if (rootFiles.has(file) || webFiles.has(file) || explicitFiles.has(file) || file === binaryAsset) return true;
  if (/^apps\/web\/src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:ts|tsx|css|svg)$/.test(file)) return true;
  if (/^src\/SparkStudio\.(?:Gateway|Connectors|Connectors[.]Tests|SourceWorker)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:cs|csproj)$/.test(file)) return true;
  if (/^src\/SparkStudio[.]SourceWorker\/packages(?:[.](?:win-x64|linux-x64|linux-arm64))?[.]lock[.]json$/.test(file)) return true;
  if (['src/SparkStudio.Gateway.Tests/GatewaySourceChecks.cs', 'src/SparkStudio.Gateway.Tests/SourceAdversarialChecks.cs', 'src/SparkStudio.Gateway.Tests/SourceLoadProbe.cs'].includes(file)) return true;
  if (/^installer\/ServiceHelper\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:cs|csproj)$/.test(file)) return true;
  if (file.startsWith('tools/') && toolFiles.has(file.slice(6))) return true;
  if (file.startsWith('docs/architecture/') && architectureDocs.has(file.slice(18))) return true;
  return false;
}
function contentIssues(file, buffer) {
  if (buffer.length > maxBlobBytes) return ['blob exceeds the 1 MiB source limit'];
  if (file === binaryAsset) return createHash('sha256').update(buffer).digest('hex') === binaryHash ? [] : ['binary asset does not match the approved SHA-256'];
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { return ['non-UTF-8 or binary content outside the approved asset']; }
  if (text.includes('\0') || /[\x01-\x08\x0b\x0c\x0e-\x1f]/.test(text)) return ['binary control bytes in a source file'];
  return contentRules.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}
function indexEntries() {
  return records(git(['ls-files', '--stage', '-z'])).map(record => {
    const match = /^(\d{6}) ([0-9a-f]{40,64}) ([0-3])\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error('Cannot parse Git index entry.');
    return { mode: match[1], oid: match[2], stage: Number(match[3]), file: match[4] };
  });
}
function treeEntries(ref) {
  const tree = git(['rev-parse', '--verify', '--end-of-options', `${ref}^{tree}`]).toString().trim();
  return records(git(['ls-tree', '-r', '-z', '--full-tree', tree])).map(record => {
    const match = /^(\d{6}) (blob|commit) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error('Cannot parse Git tree entry.');
    return { mode: match[1], oid: match[3], stage: 0, file: match[4] };
  });
}
const blobCache = new Map();
function readBlobs(entries) {
  const ids = [...new Set(entries.map(entry => entry.oid).filter(oid => !blobCache.has(oid)))];
  if (!ids.length) return;
  const metadata = git(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { input: `${ids.join('\n')}\n` }).toString().trim().split('\n');
  const selected = [];
  let bytes = 0;
  for (const line of metadata) {
    const [oid, type, sizeText] = line.trim().split(' ');
    const size = Number(sizeText);
    if (type !== 'blob' || !Number.isSafeInteger(size) || size < 0) throw new Error('An index object is not a readable blob.');
    if (size > maxBlobBytes) { blobCache.set(oid, { tooLarge: true }); continue; }
    selected.push(oid); bytes += size + 100;
  }
  if (bytes > maxBatchBytes - 1024) throw new Error('Source scan exceeds the 64 MiB batch safety limit.');
  if (!selected.length) return;
  const output = git(['cat-file', '--batch'], { input: `${selected.join('\n')}\n` });
  let offset = 0;
  for (const expected of selected) {
    const newline = output.indexOf(10, offset);
    const [oid, type, sizeText] = output.subarray(offset, newline).toString().split(' ');
    const size = Number(sizeText);
    if (newline < 0 || oid !== expected || type !== 'blob' || !Number.isSafeInteger(size) || output.length < newline + size + 2) throw new Error('Malformed Git blob stream.');
    blobCache.set(oid, output.subarray(newline + 1, newline + 1 + size));
    offset = newline + size + 2;
  }
}
const failures = new Set();
let examinedFiles = 0;
function fail(label, file, reason) { failures.add(`${label}: ${JSON.stringify(file)} — ${reason}`); }
function scanEntries(entries, label, worktree = false) {
  const accepted = [];
  for (const entry of entries) {
    examinedFiles++;
    if (!['100644', '100755'].includes(entry.mode)) { fail(label, entry.file, 'symlinks, gitlinks, and nonregular modes are forbidden'); continue; }
    if (entry.stage) { fail(label, entry.file, 'unresolved merge entry'); continue; }
    const invalid = canonicalPath(entry.file);
    if (invalid || !allowedPath(entry.file)) { fail(label, entry.file, invalid || 'path is outside the explicit source allowlist'); continue; }
    accepted.push(entry);
  }
  if (!worktree) readBlobs(accepted);
  for (const entry of accepted) {
    let buffer;
    if (worktree) {
      const absolute = path.resolve(process.cwd(), entry.file);
      const relative = path.relative(process.cwd(), absolute);
      if (relative.startsWith('..') || path.isAbsolute(relative)) { fail(label, entry.file, 'path escapes repository'); continue; }
      try {
        const info = fs.lstatSync(absolute);
        if (!info.isFile() || info.isSymbolicLink()) { fail(label, entry.file, 'not a regular worktree file'); continue; }
        if (info.size > maxBlobBytes) { fail(label, entry.file, 'blob exceeds the 1 MiB source limit'); continue; }
        // Do not follow a symlink in any parent path.
        let parent = path.dirname(absolute);
        let unsafeParent = false;
        while (parent !== process.cwd()) { if (fs.lstatSync(parent).isSymbolicLink()) { unsafeParent = true; break; } parent = path.dirname(parent); }
        if (unsafeParent) { fail(label, entry.file, 'symlinked parent directory'); continue; }
        buffer = fs.readFileSync(absolute);
      } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    } else {
      buffer = blobCache.get(entry.oid);
      if (buffer?.tooLarge) { fail(label, entry.file, 'blob exceeds the 1 MiB source limit'); continue; }
    }
    for (const reason of contentIssues(entry.file, buffer)) fail(label, entry.file, reason);
  }
}
function commitsFor(refs) {
  if (git(['rev-parse', '--is-shallow-repository']).toString().trim() === 'true') throw new Error('History checks require a full clone; fetch complete history first.');
  const tips = refs.map(ref => git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).toString().trim());
  if (!tips.length) return [];
  return git(['rev-list', '--topo-order', '--reverse', ...tips]).toString().trim().split('\n').filter(Boolean);
}
function main() {
  const args = process.argv.slice(2);
  const mode = args[0] || '--staged';
  if (!['--staged', '--tree', '--worktree', '--history', '--pre-push'].includes(mode) || args.length > (['--tree', '--history'].includes(mode) ? 2 : 1)) throw new Error('Usage: check-source.mjs [--staged | --tree REF | --worktree | --history REF | --pre-push]');
  const root = git(['rev-parse', '--show-toplevel']).toString().trim();
  process.chdir(fs.realpathSync(root));
  let commits = 0;
  if (mode === '--staged') scanEntries(indexEntries(), 'index');
  else if (mode === '--tree') scanEntries(treeEntries(args[1] || 'HEAD'), 'tree');
  else if (mode === '--worktree') {
    const tracked = new Map(indexEntries().map(entry => [entry.file, entry]));
    const files = records(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']));
    scanEntries([...new Set(files)].map(file => tracked.get(file) || { file, mode: '100644', stage: 0 }), 'worktree', true);
  } else {
    let refs;
    if (mode === '--history') refs = [args[1] || 'HEAD'];
    else {
      refs = fs.readFileSync(0, 'utf8').split(/\r?\n/).filter(Boolean).map(line => {
        const fields = line.trim().split(/\s+/);
        if (fields.length !== 4 || !/^[0-9a-f]{40,64}$/i.test(fields[1]) || !/^[0-9a-f]{40,64}$/i.test(fields[3])) throw new Error('Invalid pre-push ref input.');
        return /^0+$/.test(fields[1]) ? null : fields[1];
      }).filter(Boolean);
    }
    const history = commitsFor(refs);
    commits = history.length;
    for (const commit of history) scanEntries(treeEntries(commit), `commit ${commit.slice(0, 12)}`);
  }
  if (failures.size) {
    console.error(`Source boundary rejected ${failures.size} finding(s):`);
    for (const failure of [...failures].slice(0, 100)) console.error(`  ${failure}`);
    if (failures.size > 100) console.error(`  … ${failures.size - 100} more findings omitted.`);
    console.error('Remove forbidden content from the index and, for pushes, from every affected commit. This check does not establish ownership or replace secret review.');
    process.exitCode = 1;
  } else console.log(`Source boundary passed: ${mode}, ${examinedFiles} file entries${commits ? ` across ${commits} commits` : ''}, ${blobCache.size} unique Git blobs.`);
}
try { main(); }
catch (error) { console.error(`Source boundary could not complete: ${error.message}`); process.exitCode = 2; }
