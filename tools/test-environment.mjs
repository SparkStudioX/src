// Repository-relative tool discovery shared by offline .NET fixture runners.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
const windows = process.platform === 'win32';
const localDotnet = path.join(root, '.tools/dotnet', windows ? 'dotnet.exe' : 'dotnet');
export const dotnet = process.env.SPARKSTUDIO_DOTNET || (fs.existsSync(localDotnet) ? localDotnet : 'dotnet');
export const testEnv = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1' };
if (dotnet === localDotnet) Object.assign(testEnv, {
  DOTNET_ROOT: path.dirname(localDotnet),
  DOTNET_CLI_HOME: process.env.DOTNET_CLI_HOME || path.join(root, '.tools/dotnet-home'),
  NUGET_PACKAGES: process.env.NUGET_PACKAGES || path.join(root, '.tools/nuget'),
  ...(windows ? {
    APPDATA: path.join(root, '.tools/dotnet-home/AppData/Roaming'),
    LOCALAPPDATA: path.join(root, '.tools/dotnet-home/AppData/Local'),
  } : {}),
});
