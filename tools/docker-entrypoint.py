#!/usr/local/bin/python3
"""Initialize owned container TLS files, then replace this process with the gateway."""
import contextlib
import ipaddress
import os
from pathlib import Path
import re
import ssl
import subprocess
import sys
import tempfile
import time


class ConfigurationError(Exception):
    """A container setting needs an explicit operator correction."""


def identities(value):
    result = []
    for item in value.split(","):
        name = item.strip().lower()
        if not name or len(name) > 253:
            raise ConfigurationError("SPARKSTUDIO_TLS_NAMES must contain DNS names or IP addresses separated by commas.")
        try:
            address = ipaddress.ip_address(name)
            if address.is_unspecified or address.is_multicast or address.version == 4 and address.packed[0] == 0:
                raise ConfigurationError("TLS names must identify a specific host, not an unspecified or multicast address.")
            name = str(address)
            kind = "IP"
        except ValueError:
            labels = name.split(".")
            if all(character in "0123456789." for character in name) or not all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in labels):
                raise ConfigurationError("TLS names cannot include a scheme, port, path, wildcard or invalid DNS label.")
            kind = "DNS"
        entry = (kind, name)
        if entry not in result:
            result.append(entry)
    if len(result) > 32:
        raise ConfigurationError("At most 32 TLS names are supported.")
    return result


def openssl(*arguments):
    try:
        completed = subprocess.run(["openssl", *map(str, arguments)], stdin=subprocess.DEVNULL,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15, check=True)
        return completed.stdout.decode("ascii").strip()
    except (OSError, subprocess.SubprocessError, UnicodeError) as error:
        # Never echo command output: it can contain certificate/key file contents.
        raise ConfigurationError("TLS certificate validation failed. Check the PEM certificate and matching unencrypted private key.") from error


def validate_pair(certificate, key, names):
    for filename in (certificate, key):
        if not filename.is_file() or filename.stat().st_size > 65536:
            raise ConfigurationError("TLS certificate and key must be readable PEM files no larger than 64 KiB each.")
    if openssl("x509", "-in", certificate, "-pubkey", "-noout") != openssl("pkey", "-in", key, "-passin", "pass:", "-pubout"):
        raise ConfigurationError("The TLS private key does not match the certificate.")
    # Browsers require SAN identities; OpenSSL host checks can fall back to CN
    # when the extension contains IP entries but no DNS entries.
    alternative_names = openssl("x509", "-in", certificate, "-ext", "subjectAltName", "-noout")
    if "X509v3 Subject Alternative Name:" not in alternative_names:
        raise ConfigurationError("The TLS certificate must include Subject Alternative Name identities.")
    actual_names = set()
    for item in alternative_names.split(":", 1)[1].strip().split(","):
        if item.strip().startswith("DNS:"):
            actual_names.add(("DNS", item.strip()[4:].lower()))
        elif item.strip().startswith("IP Address:"):
            try:
                actual_names.add(("IP", str(ipaddress.ip_address(item.strip()[11:]))))
            except ValueError as error:
                raise ConfigurationError("The certificate contains an invalid IP Subject Alternative Name.") from error
    if not set(names).issubset(actual_names):
        raise ConfigurationError("Every configured TLS name must appear exactly in the certificate Subject Alternative Names.")
    dates = dict(line.split("=", 1) for line in openssl("x509", "-in", certificate, "-dates", "-noout").splitlines())
    try:
        now = time.time()
        valid = ssl.cert_time_to_seconds(dates["notBefore"]) <= now < ssl.cert_time_to_seconds(dates["notAfter"])
    except (KeyError, ValueError) as error:
        raise ConfigurationError("The TLS certificate validity period could not be read.") from error
    if not valid:
        raise ConfigurationError("The TLS certificate is expired or not yet valid. Replace it before restarting the gateway.")
    for kind, name in names:
        result = openssl("x509", "-in", certificate, "-noout", "-checkip" if kind == "IP" else "-checkhost", name)
        # OpenSSL's x509 query can exit successfully for a negative name match.
        if not result.endswith(" does match certificate"):
            raise ConfigurationError("A configured TLS name is absent from the certificate. Correct SPARKSTUDIO_TLS_NAMES or supply a matching certificate.")


@contextlib.contextmanager
def certificate_lock(directory):
    # Linux advisory locking also protects first boot when two containers are
    # accidentally launched against one volume. The gateway has its own data lease.
    import fcntl
    with (directory / ".initialization.lock").open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def certificate_pair(data, names, certificate_setting=None, key_setting=None):
    if bool(certificate_setting) != bool(key_setting):
        raise ConfigurationError("Set both SPARKSTUDIO_TLS_CERTIFICATE and SPARKSTUDIO_TLS_KEY, or neither.")
    if certificate_setting:
        certificate, key = Path(certificate_setting), Path(key_setting)
        if not certificate.is_absolute() or not key.is_absolute():
            raise ConfigurationError("Supplied certificate and key paths must be absolute container paths.")
        validate_pair(certificate, key, names)
        return certificate, key
    directory = data / "certificates" / "container"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if any(item.is_symlink() for item in (directory, *directory.parents)):
        raise ConfigurationError("The container certificate directory must contain only ordinary directories.")
    os.chmod(directory, 0o700)
    certificate, key = directory / "server.crt", directory / "server.key"
    with certificate_lock(directory):
        if certificate.is_symlink() or key.is_symlink():
            raise ConfigurationError("The saved container certificate and key must be ordinary files.")
        if certificate.exists() != key.exists():
            raise ConfigurationError("The saved container certificate pair is incomplete. Restore both files or remove the incomplete pair before restarting.")
        if not certificate.exists():
            with tempfile.TemporaryDirectory(prefix=".new-", dir=directory) as temporary:
                new_certificate, new_key = Path(temporary) / "server.crt", Path(temporary) / "server.key"
                san = ",".join(f"{kind}:{name}" for kind, name in names)
                openssl("req", "-x509", "-newkey", "rsa:3072", "-sha256", "-nodes", "-days", "365",
                        "-subj", "/CN=SparkStudio container", "-addext", f"subjectAltName={san}",
                        "-addext", "basicConstraints=critical,CA:FALSE", "-addext", "extendedKeyUsage=serverAuth",
                        "-keyout", new_key, "-out", new_certificate)
                os.chmod(new_key, 0o600)
                os.chmod(new_certificate, 0o644)
                validate_pair(new_certificate, new_key, names)
                new_key.replace(key)
                new_certificate.replace(certificate)
            print("Created a self-signed HTTPS certificate in the gateway data volume. Trust it deliberately or supply a trusted PEM certificate.", flush=True)
        validate_pair(certificate, key, names)
        os.chmod(key, 0o600)
    return certificate, key


def configure(environment):
    data = Path(environment.get("SPARKSTUDIO_DATA_DIR", "/data"))
    if not data.is_absolute():
        raise ConfigurationError("SPARKSTUDIO_DATA_DIR must be an absolute container path.")
    data.mkdir(mode=0o700, parents=True, exist_ok=True)
    names = identities(environment.get("SPARKSTUDIO_TLS_NAMES", "localhost,127.0.0.1,::1"))
    public_identity = identities(environment.get("SPARKSTUDIO_PUBLIC_HOST", "localhost"))
    if len(public_identity) != 1 or public_identity[0] not in names:
        raise ConfigurationError("SPARKSTUDIO_PUBLIC_HOST must be one identity included in SPARKSTUDIO_TLS_NAMES.")
    port = environment.get("SPARKSTUDIO_HTTPS_PORT", "8443")
    if not port.isascii() or not port.isdecimal() or not 1024 <= int(port) <= 65535:
        raise ConfigurationError("SPARKSTUDIO_HTTPS_PORT must be a port from 1024 to 65535.")
    certificate, key = certificate_pair(data, names, environment.get("SPARKSTUDIO_TLS_CERTIFICATE"), environment.get("SPARKSTUDIO_TLS_KEY"))
    environment["Kestrel__Endpoints__ContainerHttps__Url"] = "https://0.0.0.0:8443"
    environment["Kestrel__Endpoints__ContainerHttps__Certificate__Path"] = str(certificate)
    environment["Kestrel__Endpoints__ContainerHttps__Certificate__KeyPath"] = str(key)
    environment["Kestrel__Endpoints__ContainerHttp__Url"] = "http://0.0.0.0:8090"
    environment["Kestrel__Endpoints__ContainerManagement__Url"] = "http://127.0.0.1:5090"
    kind, hostname = public_identity[0]
    authority = f"[{hostname}]" if kind == "IP" and ":" in hostname else hostname
    environment["SPARKSTUDIO_CONTAINER_HTTP_PORT"] = "8090"
    environment["SPARKSTUDIO_CONTAINER_HTTPS_ORIGIN"] = f"https://{authority}:{int(port)}"
    hosts = ["localhost", "127.0.0.1", "[::1]"]
    hosts.extend(f"[{name}]" if kind == "IP" and ":" in name else name for kind, name in names)
    environment.setdefault("AllowedHosts", ";".join(dict.fromkeys(hosts)))
    return environment


def main():
    try:
        environment = configure(dict(os.environ))
        command = sys.argv[1:] or ["dotnet", "SparkStudio.Gateway.dll"]
        os.execvpe(command[0], command, environment)
    except ConfigurationError as error:
        print(f"SparkStudio container cannot start: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
