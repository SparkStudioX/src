#!/usr/bin/env python3
"""Retain the original notices and inventory from the actual Linux image.

This executes during image construction, before dropping to the application
user. It copies attribution texts only, never OS or third-party source code.
"""
import hashlib
import json
import pathlib
import platform
import re
import shutil
import subprocess
import sys


def sha256(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def retain(source, destination, output):
    source = pathlib.Path(source)
    if not source.is_file() or source.stat().st_size == 0:
        raise RuntimeError(f"Required runtime notice is missing: {source}")
    target = output / destination
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
    return {"path": destination, "sha256": sha256(target)}


def collect(output):
    if output.exists():
        raise RuntimeError("Runtime notice output must be a fresh directory.")
    output.mkdir(parents=True)
    if pathlib.Path("/usr/local/lib/python3.14/site-packages/pip").exists():
        raise RuntimeError("The runtime image must omit unused pip and its vendored dependencies.")
    inventory = {"formatVersion": 1, "platform": f"linux/{platform.machine()}", "python": {}, "frameworks": [], "osPackages": []}
    inventory["osRelease"] = pathlib.Path("/etc/os-release").read_text()
    inventory["runtimeNotices"] = [
        retain("/usr/share/dotnet/LICENSE.txt", "dotnet/LICENSE.txt", output),
        retain("/usr/share/dotnet/ThirdPartyNotices.txt", "dotnet/ThirdPartyNotices.txt", output),
    ]
    python_license = pathlib.Path(sys.base_prefix) / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "LICENSE.txt"
    inventory["python"] = {"version": platform.python_version(), "notices": [retain(python_license, "python/LICENSE.txt", output)]}
    runtimes = subprocess.check_output(["dotnet", "--list-runtimes"], text=True)
    for line in runtimes.splitlines():
        match = re.fullmatch(r"(\S+) (\S+) \[(.+)\]", line)
        if not match:
            raise RuntimeError(f"Unrecognized installed .NET framework: {line}")
        inventory["frameworks"].append({"name": match[1], "version": match[2]})
    package_format = "${binary:Package}\t${Version}\t${Architecture}\t${source:Package}\t${source:Version}\t${Status}\n"
    records = subprocess.check_output(["dpkg-query", "-W", f"-f={package_format}"], text=True)
    for line in records.splitlines():
        name, version, architecture, source_name, source_version, status = line.split("\t")
        if status != "install ok installed":
            continue
        package = name.split(":", 1)[0]
        if not re.fullmatch(r"[a-z0-9][a-z0-9+.-]*", package):
            raise RuntimeError(f"Invalid package name: {name}")
        copyright_file = pathlib.Path("/usr/share/doc") / package / "copyright"
        notice = retain(copyright_file, f"os/{package}/copyright", output)
        inventory["osPackages"].append({"name": package, "version": version, "architecture": architecture, "sourcePackage": source_name or package, "sourceVersion": source_version or version, "notices": [notice]})
    # Debian-family package licenses often reference these common original texts.
    common = pathlib.Path("/usr/share/common-licenses")
    inventory["commonLicenses"] = [retain(file, f"os/common-licenses/{file.name}", output) for file in sorted(common.iterdir()) if file.is_file()]
    (output / "runtime-inventory.json").write_text(json.dumps(inventory, indent=2) + "\n")
    print(f"Runtime originals: {len(inventory['osPackages'])} OS packages, {len(inventory['frameworks'])} .NET frameworks, CPython {inventory['python']['version']}.")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: collect-docker-runtime.py /fresh-runtime-notice-output")
    collect(pathlib.Path(sys.argv[1]).resolve())
