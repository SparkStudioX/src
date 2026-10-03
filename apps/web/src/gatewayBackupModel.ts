export type BackupDestinationKind = "smb" | "ftp" | "ftps" | "s3";
export interface BackupDestinationSettings {
  kind: BackupDestinationKind; address: string; username?: string; domain?: string; timeoutSeconds: number; allowInsecureFtp?: boolean;
  bucket?: string; region?: string; prefix?: string; accessKeyId?: string; endpoint?: string; forcePathStyle?: boolean;
}
export interface BackupDestination { id: string; name: string; settings: BackupDestinationSettings }
export interface BackupSchedule { id: string; name: string; enabled: boolean; destinationId: string; dailyTime: string; timeZoneId: string; retentionDays: number; daysOfWeek?: number[] }
export interface BackupConfiguration { destinations: BackupDestination[]; schedules: BackupSchedule[] }
export interface BackupRun { id: string; status: "running" | "succeeded" | "failed"; startedAt: string; completedAt: string | null; message: string; archiveName: string | null; bytes: number | null; removedCount: number; destinationId?: string | null; scheduleId?: string | null }
export interface BackupStatus {
  revision: string; saved: BackupConfiguration; destinationSecrets: { destinationId: string; hasPassword: boolean; hasSecretAccessKey: boolean; hasSessionToken: boolean }[];
  scheduleStates: { scheduleId: string; lastScheduledDate: string | null; lastRun: BackupRun | null; nextDueAt: string | null }[];
  hasArchivePassphrase: boolean; gatewayTimeZoneId: string; running: boolean; downloadId: string | null; recoveryBlocked: boolean;
  coverage: string; configurationError?: string | null; lastRun: BackupRun | null;
}
export interface BackupDestinationDraft {
  id: string; name: string; kind: BackupDestinationKind; sharePath: string; ftpHost: string; ftpPort: number; ftpFolder: string;
  username: string; domain: string; timeoutSeconds: number; allowInsecureFtp: boolean;
  bucket: string; region: string; prefix: string; accessKeyId: string; endpoint: string; forcePathStyle: boolean;
}
export interface BackupDraft { destinations: BackupDestinationDraft[]; schedules: BackupSchedule[] }
export interface BackupDestinationSecretEdits {
  replacePassword: boolean; password: string; clearPassword: boolean;
  replaceSecretAccessKey: boolean; secretAccessKey: string; clearSecretAccessKey: boolean;
  replaceSessionToken: boolean; sessionToken: string; clearSessionToken: boolean;
}
export interface BackupSecretEdits { destinations: Record<string, BackupDestinationSecretEdits>; replaceArchivePassphrase: boolean; archivePassphrase: string; confirmation: string }
export const emptyDestinationSecrets = (): BackupDestinationSecretEdits => ({ replacePassword: false, password: "", clearPassword: false, replaceSecretAccessKey: false, secretAccessKey: "", clearSecretAccessKey: false, replaceSessionToken: false, sessionToken: "", clearSessionToken: false });
export const emptyBackupSecrets = (): BackupSecretEdits => ({ destinations: {}, replaceArchivePassphrase: false, archivePassphrase: "", confirmation: "" });
export const backupSecretsDirty = (value: BackupSecretEdits) => value.replaceArchivePassphrase || Object.values(value.destinations).some(item => item.replacePassword || item.clearPassword || item.replaceSecretAccessKey || item.clearSecretAccessKey || item.replaceSessionToken || item.clearSessionToken);
export const newBackupDestination = (id: string): BackupDestinationDraft => ({ id, name: "New destination", kind: "smb", sharePath: "", ftpHost: "", ftpPort: 21, ftpFolder: "/sparkstudio/", username: "", domain: "", timeoutSeconds: 300, allowInsecureFtp: false, bucket: "", region: "", prefix: "", accessKeyId: "", endpoint: "", forcePathStyle: false });
export const newBackupSchedule = (id: string, destinationId: string, timeZoneId: string): BackupSchedule => ({ id, name: "New schedule", enabled: false, destinationId, dailyTime: "02:00", timeZoneId, retentionDays: 7 });
export function backupDraftFromSaved(saved: BackupConfiguration, gatewayTimeZoneId: string): BackupDraft {
  return {
    schedules: saved.schedules.map(item => ({ ...item, timeZoneId: item.timeZoneId || gatewayTimeZoneId, ...(item.daysOfWeek ? { daysOfWeek: [...item.daysOfWeek] } : {}) })),
    destinations: saved.destinations.map(({ id, name, settings }) => {
      const draft = { ...newBackupDestination(id), name, kind: settings.kind, username: settings.username || "", domain: settings.domain || "", timeoutSeconds: settings.timeoutSeconds, allowInsecureFtp: settings.allowInsecureFtp === true, bucket: settings.bucket || "", region: settings.region || "", prefix: settings.prefix || "", accessKeyId: settings.accessKeyId || "", endpoint: settings.endpoint || "", forcePathStyle: settings.forcePathStyle === true };
      if (settings.kind === "smb") draft.sharePath = settings.address;
      else if ((settings.kind === "ftp" || settings.kind === "ftps") && settings.address) { const url = new URL(settings.address); draft.ftpHost = url.hostname; draft.ftpPort = Number(url.port || 21); draft.ftpFolder = decodeURIComponent(url.pathname); }
      return draft;
    }),
  };
}
// eslint-disable-next-line no-control-regex -- This character filter intentionally matches control characters.
const bounded = (value: string, maximum: number, label: string) => { if (value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label} is limited to ${maximum} characters without control characters.`); };
const identity = (id: string, name: string, ids: Set<string>, label: string) => {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || ids.has(id)) throw new Error(`${label} IDs must be unique and contain 1–64 letters, numbers, dashes or underscores.`);
  ids.add(id); bounded(name, 100, `${label} name`); if (!name.trim()) throw new Error(`Enter a ${label.toLowerCase()} name.`);
};
function backupS3Endpoint(value: string): string {
  const endpoint = value.trim();
  if (!endpoint) return endpoint;
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error("Enter an HTTPS endpoint origin."); }
  if (endpoint.includes("\\") || url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Use an HTTPS endpoint origin without credentials, a path, query or fragment.");
  return url.origin;
}

function backupS3Settings(item: BackupDestinationDraft): BackupDestinationSettings {
  for (const [value, max, label] of [[item.bucket, 63, "Bucket"], [item.region, 63, "Region"], [item.prefix, 700, "Key prefix"], [item.accessKeyId, 256, "Access key ID"], [item.endpoint, 1000, "Endpoint"]] as const) bounded(value, max, label);
  if (item.bucket && (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(item.bucket) || /\.\.|\.-|-\./.test(item.bucket) || /^\d+\.\d+\.\d+\.\d+$/.test(item.bucket) || /^(xn--|sthree-|amzn-s3-demo-)/.test(item.bucket) || /(-s3alias|--ol-s3|\.mrap|--x-s3|--table-s3)$/.test(item.bucket))) throw new Error("Use a DNS-compatible S3 bucket name of 3–63 lowercase characters without reserved S3 prefixes or suffixes.");
  if (item.region && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(item.region)) throw new Error("Use a lowercase S3 region name with letters, numbers or hyphens.");
  if (item.accessKeyId && !/^[A-Za-z0-9_-]{1,256}$/.test(item.accessKeyId)) throw new Error("Use an access key ID with letters, numbers, underscores or hyphens.");
  if ((item.prefix && !item.prefix.endsWith("/") ? item.prefix.length + 1 : item.prefix.length) > 700 || !/^[A-Za-z0-9._/-]*$/.test(item.prefix) || item.prefix.startsWith("/") || item.prefix.includes("//") || item.prefix.split("/").some(part => part === "." || part === "..")) throw new Error("Use a key prefix of at most 700 characters including its trailing slash, without leading or repeated slashes, dot or parent segments.");
  const endpoint = backupS3Endpoint(item.endpoint);
  return { kind: item.kind, address: "", timeoutSeconds: item.timeoutSeconds, bucket: item.bucket.trim(), region: item.region.trim(), prefix: item.prefix && !item.prefix.endsWith("/") ? `${item.prefix}/` : item.prefix, accessKeyId: item.accessKeyId.trim(), endpoint, forcePathStyle: item.forcePathStyle };
}

function backupFtpAddress(item: BackupDestinationDraft): string {
  if (item.kind === "ftp" && !item.allowInsecureFtp) throw new Error("Choose FTPS or explicitly acknowledge that FTP sends credentials without encryption.");
  if (!item.ftpHost.trim()) return "";
  if (!Number.isInteger(item.ftpPort) || item.ftpPort < 1 || item.ftpPort > 65535) throw new Error("Enter an FTP port from 1 to 65535.");
  let url: URL;
  try { url = new URL(`ftp://${item.ftpHost.trim()}`); } catch { throw new Error("Enter the FTP host name or IP address without a scheme or path."); }
  if (url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) throw new Error("Enter only the FTP host; use the separate port and folder fields.");
  if (!/^\/[A-Za-z0-9._/-]*$/.test(item.ftpFolder) || item.ftpFolder.split("/").some(part => part === "." || part === "..")) throw new Error("Use an absolute FTP folder without spaces, dot or parent segments.");
  if (!item.username.trim()) throw new Error("Enter an FTP username. Use anonymous explicitly only when permitted.");
  url.port = String(item.ftpPort); url.pathname = item.ftpFolder;
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

function backupFileSettings(item: BackupDestinationDraft): BackupDestinationSettings {
  let address: string;
  if (item.kind === "smb") {
    address = item.sharePath.trim();
    if (address && !/^\\\\[^\\/]+\\[^\\/]+/.test(address)) throw new Error("Use a UNC share path such as \\\\backup-server\\backups\\sparkstudio.");
  } else address = backupFtpAddress(item);
  bounded(address, 2048, "Destination address");
  return { kind: item.kind, address, timeoutSeconds: item.timeoutSeconds, username: item.username.trim(), domain: item.kind === "smb" ? item.domain.trim() : "", allowInsecureFtp: item.kind === "ftp" && item.allowInsecureFtp };
}

function backupDestination(item: BackupDestinationDraft, destinationIds: Set<string>): BackupDestination {
  identity(item.id, item.name, destinationIds, "Destination");
  if (!["smb", "ftp", "ftps", "s3"].includes(item.kind)) throw new Error("Choose a supported destination type.");
  if (!Number.isInteger(item.timeoutSeconds) || item.timeoutSeconds < 30 || item.timeoutSeconds > 3600) throw new Error("The transfer timeout must be 30–3600 seconds.");
  bounded(item.username, 256, "Destination username"); bounded(item.domain, 256, "Destination domain");
  const destination = item.kind === "s3" ? backupS3Settings(item) : backupFileSettings(item);
  const placeholder = item.id === "default-destination" && item.kind === "smb" && !destination.address && !item.username.trim() && !item.domain.trim();
  if (!placeholder && (item.kind === "s3" ? !destination.bucket || !destination.region || !destination.accessKeyId : !destination.address)) throw new Error(`Complete destination ${item.name} before saving.`);
  return { id: item.id, name: item.name.trim(), settings: destination };
}

export function backupSettingsRequest(revision: string, draft: BackupDraft, secrets: BackupSecretEdits, storedSecrets: BackupStatus["destinationSecrets"] = [], hasArchivePassphrase = false) {
  if (draft.destinations.length > 32 || draft.schedules.length > 64) throw new Error("Use at most 32 destinations and 64 schedules.");
  const destinationIds = new Set<string>(), scheduleIds = new Set<string>();
  const settings: BackupConfiguration = { destinations: draft.destinations.map(item => backupDestination(item, destinationIds)), schedules: [] };
  settings.schedules = draft.schedules.map(item => {
    identity(item.id, item.name, scheduleIds, "Schedule");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(item.dailyTime)) throw new Error("Choose a schedule time in HH:mm format.");
    bounded(item.timeZoneId, 200, "Time zone"); if (!item.timeZoneId.trim()) throw new Error("Enter a gateway-supported time zone ID.");
    if (!Number.isInteger(item.retentionDays) || item.retentionDays < 1 || item.retentionDays > 3650) throw new Error("Keep backups for a whole number of days from 1 to 3650.");
    if (item.destinationId && !destinationIds.has(item.destinationId)) throw new Error(`Schedule ${item.name} refers to a missing destination.`);
    const target = settings.destinations.find(destination => destination.id === item.destinationId)?.settings;
    if (item.enabled && (!target || (target.kind === "s3" ? !target.bucket || !target.region || !target.accessKeyId : !target.address))) throw new Error(`Configure a destination before enabling schedule ${item.name}.`);
    if (item.enabled && !hasArchivePassphrase && !secrets.replaceArchivePassphrase) throw new Error("Set an archive passphrase before enabling backup schedules.");
    if (item.enabled && target) {
      const edit = secrets.destinations[item.destinationId], saved = storedSecrets.find(secret => secret.destinationId === item.destinationId);
      const password = !edit?.clearPassword && (edit?.replacePassword ? Boolean(edit.password) : saved?.hasPassword);
      const accessKey = !edit?.clearSecretAccessKey && (edit?.replaceSecretAccessKey ? Boolean(edit.secretAccessKey) : saved?.hasSecretAccessKey);
      if (target.kind === "s3" ? !accessKey : (target.kind === "smb" ? Boolean(target.username) && !password : target.username?.toLowerCase() !== "anonymous" && !password)) throw new Error(`Set destination credentials before enabling schedule ${item.name}.`);
    }
    if (item.daysOfWeek && (item.daysOfWeek.some(day => !Number.isInteger(day) || day < 0 || day > 6) || new Set(item.daysOfWeek).size !== item.daysOfWeek.length)) throw new Error("Choose each weekday at most once, from Sunday through Saturday.");
    return { ...item, name: item.name.trim(), timeZoneId: item.timeZoneId.trim(), ...(item.daysOfWeek ? { daysOfWeek: [...item.daysOfWeek].sort((a, b) => a - b) } : {}) };
  });
  type SecretRequest = { destinationId: string; password?: string; secretAccessKey?: string; sessionToken?: string; clearPassword?: boolean; clearSecretAccessKey?: boolean; clearSessionToken?: boolean };
  const destinationSecrets: SecretRequest[] = [];
  for (const item of draft.destinations) {
    const edit = secrets.destinations[item.id]; if (!edit) continue;
    const entry: SecretRequest = { destinationId: item.id };
    const fields = item.kind === "s3" ? [["secretAccessKey", "replaceSecretAccessKey", "clearSecretAccessKey"], ["sessionToken", "replaceSessionToken", "clearSessionToken"]] as const : [["password", "replacePassword", "clearPassword"]] as const;
    for (const [value, replace, clear] of fields) {
      if (edit[replace] && edit[clear]) throw new Error("Choose either replace or clear for each destination secret.");
      if (edit[clear]) entry[clear] = true;
      else if (edit[replace]) { if (!edit[value] || edit[value].length > 4096) throw new Error("Enter a replacement secret of 1–4096 characters, or turn off Replace to retain the saved secret."); entry[value] = edit[value]; }
    }
    if (Object.keys(entry).length > 1) destinationSecrets.push(entry);
  }
  const request: { revision: string; settings: BackupConfiguration; destinationSecrets?: SecretRequest[]; archivePassphrase?: string } = { revision, settings };
  if (destinationSecrets.length) request.destinationSecrets = destinationSecrets;
  if (secrets.replaceArchivePassphrase) { if (secrets.archivePassphrase.length < 12 || secrets.archivePassphrase.length > 1024) throw new Error("Use 12–1024 characters for the archive passphrase."); if (secrets.archivePassphrase !== secrets.confirmation) throw new Error("The archive passphrase and confirmation do not match."); request.archivePassphrase = secrets.archivePassphrase; }
  return request;
}
