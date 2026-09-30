export const opcCertificateStores = ["own", "trusted", "issuers", "rejected"] as const;
export type OpcCertificateStore = typeof opcCertificateStores[number];
export interface OpcCertificateSummary { store: OpcCertificateStore; sha256: string; subject: string; issuer: string; notBefore: string; notAfter: string }
export interface OpcCertificateListing { certificates: OpcCertificateSummary[]; invalidFiles: number; note: string }
export interface PublicCertificateUpload { name: string; bytes: number; sha256: string; certificate: string }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export function normalizeFingerprint(value: string): string {
  const normalized = value.replace(/[\s:]/g, "").toUpperCase();
  if (!/^[A-F0-9]{64}$/.test(normalized)) throw new Error("Enter the independently verified SHA-256 fingerprint: 64 hexadecimal characters (spaces and colons are accepted).");
  return normalized;
}
export function certificateListing(value: unknown): OpcCertificateListing {
  if (!record(value) || !Array.isArray(value.certificates) || value.certificates.length > 4000 || !Number.isInteger(value.invalidFiles) || Number(value.invalidFiles) < 0 || typeof value.note !== "string") throw new Error("The gateway returned an invalid public certificate listing.");
  for (const item of value.certificates) if (!record(item) || !opcCertificateStores.includes(item.store as OpcCertificateStore) || typeof item.sha256 !== "string" || !/^[a-f\d]{64}$/i.test(item.sha256)
    || typeof item.subject !== "string" || typeof item.issuer !== "string" || typeof item.notBefore !== "string" || !Number.isFinite(Date.parse(item.notBefore)) || typeof item.notAfter !== "string" || !Number.isFinite(Date.parse(item.notAfter))) throw new Error("The gateway returned invalid public certificate metadata.");
  return value as unknown as OpcCertificateListing;
}
/** Reject PEM/key containers and trailing bytes before hashing; the gateway validates X.509 and strength. */
export function publicDerBytes(name: string, bytes: Uint8Array): void {
  if (!/\.(?:der|cer)$/i.test(name) || bytes.length < 32 || bytes.length > 65536) throw new Error("Choose a DER public .der or .cer certificate between 32 bytes and 64 KiB. Private keys and certificate bundles are not accepted.");
  if (bytes[0] !== 0x30) throw new Error("Choose a binary DER public certificate. PEM text is not accepted.");
  const lengthOctets = bytes[1] & 0x7f;
  let length = bytes[1], header = 2;
  if (bytes[1] & 0x80) {
    if (lengthOctets < 1 || lengthOctets > 3 || bytes[2] === 0) throw new Error("Invalid DER certificate length.");
    length = 0; header += lengthOctets;
    for (let index = 0; index < lengthOctets; index++) length = length * 256 + bytes[2 + index];
    if (length < 128) throw new Error("Invalid DER certificate encoding.");
  }
  if (header + length !== bytes.length) throw new Error("Choose exactly one DER certificate without trailing data.");
  // X.509 Certificate is exactly { tbsCertificate SEQUENCE, algorithm SEQUENCE, signature BIT STRING }.
  // PKCS#8/RSA keys and PKCS#12 containers begin with INTEGER version and are rejected before upload.
  const endOf = (start: number, tag: number): number => {
    if (start + 2 > bytes.length || bytes[start] !== tag) throw new Error("Choose an X.509 public certificate, never a private key or key bundle.");
    const first = bytes[start + 1]; let count = first, offset = start + 2;
    if (first & 0x80) {
      const octets = first & 0x7f;
      if (!octets || octets > 3 || offset + octets > bytes.length || bytes[offset] === 0) throw new Error("Invalid DER certificate structure.");
      count = 0; for (let index = 0; index < octets; index++) count = count * 256 + bytes[offset++];
      if (count < 128) throw new Error("Invalid DER certificate structure.");
    }
    if (count < 1 || offset + count > bytes.length) throw new Error("Invalid DER certificate structure.");
    return offset + count;
  };
  const algorithm = endOf(header, 0x30), signature = endOf(algorithm, 0x30), end = endOf(signature, 0x03);
  if (end !== bytes.length) throw new Error("Choose exactly one X.509 public certificate.");
}
export async function preparePublicCertificate(file: Pick<File, "name" | "size" | "arrayBuffer">): Promise<PublicCertificateUpload> {
  if (file.size > 65536 || file.size < 32) throw new Error("Public certificates must be between 32 bytes and 64 KiB.");
  const raw = await file.arrayBuffer(), bytes = new Uint8Array(raw); publicDerBytes(file.name, bytes);
  if (!globalThis.crypto?.subtle) throw new Error("Certificate fingerprint verification requires HTTPS or a localhost connection.");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  return { name: file.name, bytes: bytes.length, sha256: [...digest].map(value => value.toString(16).padStart(2, "0")).join("").toUpperCase(), certificate: btoa(String.fromCharCode(...bytes)) };
}
export function certificateTrustRequest(upload: PublicCertificateUpload, confirmed: string, independentlyVerified: boolean) {
  if (!independentlyVerified) throw new Error("Verify this fingerprint independently with the OPC UA server administrator before trusting it.");
  const confirmedSha256 = normalizeFingerprint(confirmed);
  if (confirmedSha256 !== upload.sha256) throw new Error("The independently verified fingerprint does not match the selected file.");
  return { certificate: upload.certificate, confirmedSha256 };
}
export function certificateRemovalRequest(certificate: OpcCertificateSummary, confirmed: string) {
  if (certificate.store !== "trusted") throw new Error("Only a trusted public certificate can be removed through this page.");
  const confirmedSha256 = normalizeFingerprint(confirmed);
  if (confirmedSha256 !== certificate.sha256.toUpperCase()) throw new Error("Confirm the exact fingerprint of the trusted certificate being removed.");
  return { confirmedSha256 };
}
export function publicCertificatePath(certificate: Pick<OpcCertificateSummary, "store" | "sha256">) {
  if (!opcCertificateStores.includes(certificate.store)) throw new Error("Choose a public OPC certificate store.");
  return `/gateway/opcua/certificates/${certificate.store}/${normalizeFingerprint(certificate.sha256)}`;
}
