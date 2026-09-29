# Network access workshop

The companion build adds installer choices for **Local only** and **Network access — HTTPS**. Managed-listener upgrades also offer **Keep existing listener settings**, selected by default, so an upgrade does not discard changes made in Gateway Settings. The released preview.5 installer predates these choices.

Local management remains HTTP on `127.0.0.1`, port 5090 by default. Network access adds HTTPS on `0.0.0.0`, port 5443 by default, with a separate public DNS hostname. The two ports must differ. `0.0.0.0` is a listening address; it is never the URL operators use or the name matched against a certificate. This version binds all IPv4 interfaces for network access; selecting a particular network interface or IPv6 network listener is not included.

Use the supplied `gateway-network.json` screen as a read-only connectivity exercise on an isolated evaluation gateway. This setup-required workshop has no device, database, script, account or certificate material. A project package cannot configure listeners or carry private keys. From a source checkout, use the dedicated authenticated loader below to create its draft, then review and publish it explicitly. It is cataloged as setup-required and is not included among standalone portable workshop packages.

## Certificate and network prerequisites

Ask the factory network administrator for a DNS name resolving to the gateway, a currently valid PEM server certificate with that exact DNS name in its subject alternative names, its matching unencrypted PEM private key, and the issuing CA certificates. If intermediate certificates are needed, append them after the leaf certificate in the PEM certificate file. Certificates with a server-authentication EKU restriction must permit TLS server authentication.

For air-gapped networks, use the factory's internal CA and configure its trust on operator computers through the site's normal procedure. Public CA enrollment is not required. A self-signed evaluation certificate can be supplied explicitly, but the installer does not create one or disable browser validation. Wildcard-only certificates and common-name-only certificates are not accepted by the strict hostname check.

Setup does not create DNS records, open firewall rules or install certificate trust. Permit the selected HTTPS TCP port on the intended Windows firewall network profile and any intervening firewall. Keep the local management port closed to remote traffic; it is bound only to loopback. No remote HTTP login listener is added.

## Load the synthetic screen

On a disposable local gateway, create an administrator and save its username/password in a protected local-only JSON file. Do not put that file in source control or pass a password on the command line. From the source checkout:

```powershell
$env:SPARKSTUDIO_ADMIN_AUTH_FILE = 'C:\path-to-private-fixture\admin.json'
node tools/load-network-example.mjs http://127.0.0.1:5091
```

The loader also accepts local port 5090, but use an isolated gateway for this exercise. It refuses an existing project with the workshop name, creates only a new project draft, and signs its temporary engineering session out afterward. The printed Designer URL opens the draft. The optional "--publish" flag performs explicit publication; otherwise publish through Designer after reviewing it. Configure HTTPS separately using the installer or Deployment editor.

## Walkthrough

1. On a disposable gateway host, use a companion installer build and choose **Network access — HTTPS**. Retain a free local management port, choose a distinct free HTTPS port, and enter the DNS hostname without a URL scheme or port.
2. Select the certificate chain PEM and matching key PEM. Setup validates the certificate's date, hostname, server usage and key correspondence before stopping an existing owned service. It copies the selected bytes into uniquely named files under `<data-directory>/certificates/deployment/` with access limited to the service identity, Administrators and SYSTEM. Original certificate files remain your responsibility.
3. Finish setup. Its local readiness check verifies the owned process and bundled Python. A second local HTTPS request pins the installed certificate, uses its DNS hostname for TLS, and verifies the same process. This check does not prove trust or reachability from operator computers.
4. On the gateway host, open the loopback management URL. If no administrator exists, read `C:\ProgramData\SparkStudio\security\setup-code.txt` from an elevated PowerShell and enter the code in the local setup form. Bootstrap remains local-only.
5. Use the authenticated loader above to create the workshop project, publish it, and grant an operator account **View** on that project. Copy the operator application's project path, such as `/runtime/<project-id>`.
6. On a second computer, open `https://your-gateway-name:your-https-port/runtime/<project-id>`. Verify the browser recognizes the intended hostname and trusted certificate without bypassing its warning. Sign in as the operator and confirm the screen appears. Toggle the checkbox; it changes only that browser's local input.
7. Inspect Gateway Settings → Deployment on the gateway. Both actual listeners should be visible. Its saved listener URL is the network binding and its public hostname is separate. Saving a change only stages it; restart the service deliberately to apply it.
8. On the isolated installation, upgrade with **Keep existing listener settings**. Confirm the selected hostname, network port and certificate references remain unchanged. Switching explicitly to **Local only** removes the network intent on the next service start.

## Failure, renewal and recovery

The installer rejects remote HTTP, missing/mismatched/expired certificates, invalid hostnames, conflicting ports and unowned service commands. Managed service startup also rejects conflicting external URL/Kestrel/environment overrides before any listener starts. A manually configured host without the installer marker can still use explicit overrides. It retains the existing data. If installation fails after staging new deployment settings, the helper restores the previous deployment bytes and removes only the new certificate files created by that attempt. Payload rollback is a separate installer capability and is not implied by restoring listener settings.

If the configured certificate later becomes unavailable or invalid, managed startup opens only the local recovery listener and reports a recovery condition. It does not fall back to unencrypted network access. A port collision can still prevent startup. Use the documented explicit loopback recovery override after stopping the service if necessary.

Renewal is manual: place the new PEM files in the protected deployment certificate directory, update their filename references in Gateway Settings → Deployment, validate, save and restart. No certificate or key bytes are accepted through the web form. DNS, CA trust, revocation operations, renewal automation and reverse-proxy trust remain site-managed work.

Automated verification uses synthetic certificate fixtures: helper ownership/migration and rollback checks, a real certificate-pinned TLS request, and real Kestrel dual-listener startup plus local-only fallback after a missing key. Elevated service installation with these new network choices, remote-client browser trust and firewall traversal require a separate acceptance run; older preview.5 upgrade evidence does not establish them.
