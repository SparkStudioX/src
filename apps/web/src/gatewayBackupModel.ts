export type BackupDestinationKind = "smb" | "ftp" | "ftps";
export interface BackupConfiguration {
  enabled: boolean; dailyTime: string; timeZoneId: string; retentionDays: number;
  destination: { kind: BackupDestinationKind; address: string; username: string; domain: string; timeoutSeconds: number };
}
export interface BackupStatus {
  revision: string; saved: BackupConfiguration; hasDestinationPassword: boolean; hasArchivePassphrase: boolean;
  gatewayTimeZoneId: string; running: boolean; nextDueAt: string | null; downloadId: string | null; recoveryBlocked: boolean;
  coverage: string; configurationError?: string | null;
  lastRun: null | { id: string; status: "running" | "succeeded" | "failed"; startedAt: string; completedAt: string | null; message: string; archiveName: string | null; bytes: number | null; removedCount: number };
}
export interface BackupDraft {
  enabled: boolean; dailyTime: string; timeZoneId: string; retentionDays: number;
  kind: BackupDestinationKind; sharePath: string; ftpHost: string; ftpPort: number; ftpFolder: string;
  username: string; domain: string; timeoutSeconds: number;
}
export interface BackupSecretEdits {
  replaceDestinationPassword: boolean; destinationPassword: string; clearDestinationPassword: boolean;
  replaceArchivePassphrase: boolean; archivePassphrase: string; confirmation: string;
}
export const emptyBackupSecrets = (): BackupSecretEdits => ({ replaceDestinationPassword: false, destinationPassword: "", clearDestinationPassword: false, replaceArchivePassphrase: false, archivePassphrase: "", confirmation: "" });

export function backupDraftFromSaved(saved: BackupConfiguration, gatewayTimeZoneId: string): BackupDraft {
  let ftpHost = "", ftpPort = 21, ftpFolder = "/sparkstudio/";
  if (saved.destination.kind !== "smb" && saved.destination.address) {
    const url = new URL(saved.destination.address);
    ftpHost = url.hostname; ftpPort = Number(url.port || 21); ftpFolder = decodeURIComponent(url.pathname);
  }
  return {
    enabled: saved.enabled, dailyTime: saved.dailyTime, timeZoneId: saved.timeZoneId || gatewayTimeZoneId,
    retentionDays: saved.retentionDays, kind: saved.destination.kind,
    sharePath: saved.destination.kind === "smb" ? saved.destination.address : "", ftpHost, ftpPort, ftpFolder,
    username: saved.destination.username || "", domain: saved.destination.domain || "", timeoutSeconds: saved.destination.timeoutSeconds,
  };
}

export function backupSettingsRequest(revision: string, draft: BackupDraft, secrets: BackupSecretEdits) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.dailyTime)) throw new Error("Choose a daily time in HH:mm format.");
  if (!draft.timeZoneId.trim()) throw new Error("Enter a gateway-supported time zone ID.");
  if (!Number.isInteger(draft.retentionDays) || draft.retentionDays < 1 || draft.retentionDays > 3650) throw new Error("Keep backups for a whole number of days from 1 to 3650.");
  if (!Number.isInteger(draft.timeoutSeconds) || draft.timeoutSeconds < 30 || draft.timeoutSeconds > 3600) throw new Error("The transfer timeout must be 30–3600 seconds.");
  if (draft.username.length > 256 || draft.domain.length > 256) throw new Error("Destination username and domain are limited to 256 characters each.");
  let address = draft.sharePath.trim();
  if (draft.kind !== "smb") {
    address = "";
    if (draft.ftpHost.trim()) {
      if (!Number.isInteger(draft.ftpPort) || draft.ftpPort < 1 || draft.ftpPort > 65535) throw new Error("Enter an FTP port from 1 to 65535.");
      let url: URL;
      try { url = new URL(`ftp://${draft.ftpHost.trim()}`); } catch { throw new Error("Enter the FTP host name or IP address without a scheme or path."); }
      if (url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash) throw new Error("Enter only the FTP host; use the separate port and folder fields.");
      if (!draft.ftpFolder.startsWith("/") || !/^\/[A-Za-z0-9._/-]*$/.test(draft.ftpFolder) || draft.ftpFolder.split("/").some(part => part === "." || part === "..")) throw new Error("Use an absolute FTP folder with letters, digits, periods, underscores or hyphens, without dot or parent segments.");
      if (!draft.username.trim()) throw new Error("Enter an FTP username. Use anonymous explicitly only when the destination permits anonymous access.");
      url.port = String(draft.ftpPort);
      url.pathname = draft.ftpFolder;
      if (!url.pathname.endsWith("/")) url.pathname += "/";
      address = url.href;
    }
  } else if (address && !/^\\\\[^\\/]+\\[^\\/]+/.test(address)) throw new Error("Use a UNC share path such as \\\\backup-server\\backups\\sparkstudio.");
  if (address.length > 2048) throw new Error("The destination address is limited to 2048 characters.");
  if (draft.enabled && !address) throw new Error("Configure a destination before enabling daily backups.");
  const settings: BackupConfiguration = {
    enabled: draft.enabled, dailyTime: draft.dailyTime, timeZoneId: draft.timeZoneId.trim(), retentionDays: draft.retentionDays,
    destination: { kind: draft.kind, address, username: draft.username.trim(), domain: draft.kind === "smb" ? draft.domain.trim() : "", timeoutSeconds: draft.timeoutSeconds },
  };
  const request: { revision: string; settings: BackupConfiguration; destinationPassword?: string; archivePassphrase?: string; clearDestinationPassword?: boolean } = { revision, settings };
  if (secrets.clearDestinationPassword) request.clearDestinationPassword = true;
  else if (secrets.replaceDestinationPassword) {
    if (!secrets.destinationPassword || secrets.destinationPassword.length > 4096) throw new Error("Enter a new destination password (at most 4096 characters), or turn off Replace password to keep the saved one.");
    request.destinationPassword = secrets.destinationPassword;
  }
  if (secrets.replaceArchivePassphrase) {
    if (secrets.archivePassphrase.length < 12 || secrets.archivePassphrase.length > 1024) throw new Error("Use 12–1024 characters for the archive passphrase.");
    if (secrets.archivePassphrase !== secrets.confirmation) throw new Error("The archive passphrase and confirmation do not match.");
    request.archivePassphrase = secrets.archivePassphrase;
  }
  return request;
}
