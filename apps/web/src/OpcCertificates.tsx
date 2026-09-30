import { useEffect, useRef, useState } from "react";
import { api, apiUrl, authenticatedFetch, assertAuthResponseCurrent } from "./api";
import { certificateListing, certificateRemovalRequest, certificateTrustRequest, opcCertificateStores, preparePublicCertificate, publicCertificatePath } from "./opcCertificateModel";
import type { OpcCertificateListing, OpcCertificateSummary, PublicCertificateUpload } from "./opcCertificateModel";
import "./opcCertificates.css";

export default function OpcCertificates() {
  const [listing, setListing] = useState<OpcCertificateListing>(), [store, setStore] = useState("all"), [search, setSearch] = useState("");
  const [upload, setUpload] = useState<PublicCertificateUpload>(), [fingerprint, setFingerprint] = useState(""), [verified, setVerified] = useState(false);
  const [review, setReview] = useState<"trust" | OpcCertificateSummary>(), [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const current = useRef(true), generation = useRef(0), uploadGeneration = useRef(0), inFlight = useRef(false), dialog = useRef<HTMLDialogElement>(null);
  const alive = () => current.current;
  async function load() {
    const run = ++generation.current; setError("");
    try { const result = certificateListing(await api("/gateway/opcua/certificates")); if (alive() && generation.current === run) setListing(result); }
    catch (reason) { if (alive() && generation.current === run) setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  useEffect(() => { current.current = true; void load(); return () => { current.current = false; generation.current++; uploadGeneration.current++; }; }, []);
  useEffect(() => { if (review) dialog.current?.showModal(); return () => dialog.current?.close(); }, [review]);
  async function choose(file?: File) {
    const run = ++uploadGeneration.current; setUpload(undefined); setFingerprint(""); setVerified(false); setError("");
    if (!file) return;
    setBusy(true);
    try { const next = await preparePublicCertificate(file); if (alive() && uploadGeneration.current === run) setUpload(next); }
    catch (reason) { if (alive() && uploadGeneration.current === run) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (alive() && uploadGeneration.current === run) setBusy(false); }
  }
  function openTrust() {
    try { if (!upload) throw new Error("Choose a public certificate."); certificateTrustRequest(upload, fingerprint, verified); setReview("trust"); setError(""); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  async function apply() {
    if (!review || inFlight.current) return;
    let path: string, body: unknown;
    try {
      if (review === "trust") { if (!upload) throw new Error("Choose a public certificate."); body = certificateTrustRequest(upload, fingerprint, verified); path = "/gateway/opcua/certificates/trust"; }
      else { body = certificateRemovalRequest(review, confirmation); path = `${publicCertificatePath(review)}/remove`; }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return; }
    inFlight.current = true; setBusy(true); setError("");
    try {
      const result = await api<{ restartRequired: boolean }>(path, "POST", body);
      if (!alive()) return;
      if (result.restartRequired !== true) throw new Error("The gateway did not confirm the certificate-store change. Refresh before retrying.");
      setNotice("Public certificate store updated. Restart the gateway to apply the change to OPC UA sessions. Existing connection-specific pins must also be removed when revoking trust.");
      setReview(undefined); setUpload(undefined); setFingerprint(""); setVerified(false); setConfirmation(""); await load();
    } catch (reason) { if (alive()) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { inFlight.current = false; if (alive()) setBusy(false); }
  }
  async function download(certificate: OpcCertificateSummary) {
    setError("");
    try {
      const response = await authenticatedFetch(apiUrl(publicCertificatePath(certificate)));
      if (!response.ok) throw new Error(`Public certificate download failed (${response.status}).`);
      const bytes = await response.blob(); assertAuthResponseCurrent(response);
      if (!alive()) return;
      const checked = await preparePublicCertificate({ name: "certificate.der", size: bytes.size, arrayBuffer: () => bytes.arrayBuffer() });
      assertAuthResponseCurrent(response);
      if (!alive()) return;
      if (checked.sha256 !== certificate.sha256.toUpperCase()) throw new Error("The downloaded public certificate does not match the selected fingerprint.");
      const url = URL.createObjectURL(bytes), link = document.createElement("a"); link.href = url; link.download = `sparkstudio-opc-${certificate.sha256}.der`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) { if (alive()) setError(reason instanceof Error ? reason.message : String(reason)); }
  }
  const visible = listing?.certificates.filter(certificate => (store === "all" || certificate.store === store) && `${certificate.subject} ${certificate.issuer} ${certificate.sha256}`.toLowerCase().includes(search.toLowerCase())) ?? [];
  let trustReady = false; try { if (upload) { certificateTrustRequest(upload, fingerprint, verified); trustReady = true; } } catch { /* Inputs explain what is required. */ }
  let removalReady = false; try { if (review && review !== "trust") { certificateRemovalRequest(review, confirmation); removalReady = true; } } catch { /* Keep confirmation disabled until exact. */ }
  return <section className="opc-certificates" aria-labelledby="opc-certificates-title">
    <h2 id="opc-certificates-title">Public OPC certificates</h2>
    <p>Download SparkStudio’s <strong>own</strong> public certificate to trust this client in your OPC UA server. Import a server’s public DER certificate only after verifying its SHA-256 fingerprint through an independent source. Private keys never appear on this page.</p>
    {notice && <p className="gateway-observation" role="status">{notice}</p>}{error && !review && <p className="gateway-error" role="alert">{error}</p>}
    <div className="opc-certificate-toolbar"><label>Store<select value={store} onChange={event => setStore(event.target.value)}><option value="all">All public stores</option>{opcCertificateStores.map(value => <option key={value}>{value}</option>)}</select></label><label>Filter<input value={search} onChange={event => setSearch(event.target.value)} placeholder="Subject, issuer or fingerprint" /></label><button type="button" className="button" disabled={busy} onClick={() => void load()}>Refresh certificates</button></div>
    {listing && <><p>{listing.note}</p>{listing.invalidFiles > 0 && <p role="status">{listing.invalidFiles} unreadable public certificate file(s) were omitted. Inspect the gateway’s public certificate folders locally.</p>}<div className="opc-certificate-table"><table><thead><tr><th>Store / subject</th><th>SHA-256 fingerprint</th><th>Validity / issuer</th><th>Actions</th></tr></thead><tbody>{visible.map(certificate => <tr key={`${certificate.store}:${certificate.sha256}`}><td><strong>{certificate.store}</strong><small>{certificate.subject}</small></td><td><code>{certificate.sha256}</code></td><td><span>{new Date(certificate.notBefore).toLocaleString()} – {new Date(certificate.notAfter).toLocaleString()}</span><small>{certificate.issuer}</small></td><td><button type="button" className="button" disabled={busy} onClick={() => void download(certificate)}>Download public DER</button>{certificate.store === "trusted" && <button type="button" className="button" disabled={busy} onClick={() => { setReview(certificate); setConfirmation(""); setError(""); }}>Remove trust…</button>}</td></tr>)}</tbody></table></div>{!visible.length && <p>No matching public certificates. An own client certificate is created when the OPC UA client initializes.</p>}</>}
    <fieldset disabled={busy}><legend>Trust a server public certificate</legend><label>DER certificate<input type="file" accept=".der,.cer,application/pkix-cert" onChange={event => void choose(event.target.files?.[0])} /></label>{upload && <p>{upload.name} · {upload.bytes} bytes<br />Calculated SHA-256: <code>{upload.sha256}</code></p>}<label>Independently verified SHA-256<input value={fingerprint} onChange={event => setFingerprint(event.target.value)} autoComplete="off" spellCheck={false} placeholder="Enter the fingerprint obtained from the OPC UA server administrator" /></label><label className="opc-certificate-check"><input type="checkbox" checked={verified} onChange={event => setVerified(event.target.checked)} />I verified this fingerprint through an independent trusted source.</label><button type="button" className="button" disabled={!trustReady} onClick={openTrust}>Review certificate trust</button></fieldset>
    {review && <dialog ref={dialog} className="project-dialog" aria-labelledby="opc-certificate-review-title" onCancel={event => { event.preventDefault(); if (!busy) setReview(undefined); }}><header><h2 id="opc-certificate-review-title">{review === "trust" ? "Trust this public certificate?" : "Remove certificate trust?"}</h2></header><div className="project-dialog-body"><p>{review === "trust" ? upload?.name : review.subject}</p><code>{review === "trust" ? upload?.sha256 : review.sha256}</code><p>{review === "trust" ? "The gateway checks certificate validity and strength before adding trust." : "A gateway restart is required to revoke existing sessions. Remove any connection-specific certificate pins as well."}</p>{review !== "trust" && <label>Confirm the exact SHA-256 fingerprint<input value={confirmation} onChange={event => setConfirmation(event.target.value)} spellCheck={false} autoComplete="off" disabled={busy} /></label>}{error && <p className="gateway-error" role="alert">{error}</p>}</div><footer><button type="button" className="button" disabled={busy} onClick={() => setReview(undefined)}>Cancel</button><button type="button" className="button primary" disabled={busy || (review === "trust" ? !trustReady : !removalReady)} onClick={() => void apply()}>{busy ? "Applying…" : review === "trust" ? "Confirm trust" : "Confirm removal"}</button></footer></dialog>}
  </section>;
}
