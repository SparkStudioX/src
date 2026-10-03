"""Run the pinned standalone Ruff binary without changing the embedded Python runtime."""

import hashlib
import json
from pathlib import Path
import platform
import subprocess
import sys
from urllib.request import urlopen
import zipfile


ROOT = Path(__file__).resolve().parent.parent
INPUTS = [
    "runtimes/python/worker.py",
    "tools/container-admin.py",
    "tools/docker-entrypoint.py",
    "tools/collect-docker-runtime.py",
]


def ruff_binary():
    manifest = json.loads((ROOT / "tools/ruff-runtime.json").read_text(encoding="utf-8"))
    machine = platform.machine().lower()
    architecture = {"amd64": "x64", "x86_64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(machine)
    system = {"win32": "win", "linux": "linux"}.get(sys.platform)
    key = f"{system}-{architecture}"
    if key not in manifest["platforms"]:
        raise RuntimeError(f"No reviewed Ruff runtime for {sys.platform}/{machine}.")
    release = manifest["platforms"][key]
    directory = ROOT / ".tools/ruff" / manifest["version"] / key
    directory.mkdir(parents=True, exist_ok=True)
    wheel = directory / "ruff.whl"
    if not wheel.exists():
        with urlopen(release["url"], timeout=120) as response:
            payload = response.read(32 * 1024 * 1024)
        if hashlib.sha256(payload).hexdigest() != release["sha256"]:
            raise RuntimeError("Ruff download differs from its reviewed SHA-256.")
        wheel.write_bytes(payload)
    if hashlib.sha256(wheel.read_bytes()).hexdigest() != release["sha256"]:
        raise RuntimeError(f"Ruff archive checksum mismatch: {wheel}")
    name = "ruff.exe" if system == "win" else "ruff"
    with zipfile.ZipFile(wheel) as archive:
        entries = [entry for entry in archive.namelist() if entry.rsplit("/", 1)[-1] == name]
        if len(entries) != 1:
            raise RuntimeError("Pinned Ruff wheel must contain exactly one standalone binary.")
        binary_bytes = archive.read(entries[0])
    binary = directory / name
    if not binary.exists():
        binary.write_bytes(binary_bytes)
    if hashlib.sha256(binary.read_bytes()).digest() != hashlib.sha256(binary_bytes).digest():
        raise RuntimeError(f"Extracted Ruff binary differs from its reviewed archive: {binary}")
    if system != "win":
        binary.chmod(0o755)
    return binary


def main():
    try:
        binary = ruff_binary()
        result = subprocess.run([str(binary), "check", "--config", str(ROOT / "ruff.toml"), *INPUTS], cwd=ROOT, check=False)
        return result.returncode
    except (OSError, ValueError, RuntimeError, zipfile.BadZipFile) as error:
        print(f"Python lint setup failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
