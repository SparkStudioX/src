// An MSBuild Exec inherits the parent's resolved SDK locations. A fresh dotnet
// CLI must resolve global.json with its selected host rather than reuse them.
const inheritedSdkKeys = new Set([
  'msbuild_exe_path', 'msbuildsdkspath', 'msbuildextensionspath',
  'msbuildextensionspath32', 'msbuildextensionspath64', 'msbuildtoolspath',
  'msbuildtoolspath32', 'msbuildtoolspath64', 'dotnet_host_path',
  'dotnet_msbuild_sdk_resolver_cli_dir', 'dotnet_msbuild_sdk_resolver_sdks_dir',
  'dotnet_msbuild_sdk_resolver_sdks_ver',
]);

export function freshDotnetEnvironment(environment = process.env) {
  const result = { ...environment };
  for (const key of Object.keys(result)) if (inheritedSdkKeys.has(key.toLowerCase())) delete result[key];
  return result;
}
