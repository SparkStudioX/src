#!/usr/local/bin/python3
"""Container-local administration over SparkStudio's unexposed loopback listener.

This is a client of the existing setup API, not a second account store or a
remote bootstrap endpoint. It never uses proxy settings or follows redirects.
"""

import argparse
import getpass
import http.client
import json
import os
from pathlib import Path
import re
import stat
import sys


MANAGEMENT_HOST = "127.0.0.1"
MANAGEMENT_PORT = 5090
RESPONSE_LIMIT = 65_536
SETUP_CODE = re.compile(r"[A-Za-z0-9_-]{43}\Z")
USERNAME = re.compile(r"[A-Za-z0-9._-]{3,64}\Z")


class AdministrationError(Exception):
    """A deliberately sanitized error suitable for the local terminal."""


def local_request(method, path, body=None):
    connection = http.client.HTTPConnection(MANAGEMENT_HOST, MANAGEMENT_PORT, timeout=10)
    try:
        payload = None if body is None else json.dumps(body, ensure_ascii=True).encode("utf-8")
        headers = {} if payload is None else {"Content-Type": "application/json"}
        connection.request(method, path, body=payload, headers=headers)
        response = connection.getresponse()
        data = response.read(RESPONSE_LIMIT + 1)
        if len(data) > RESPONSE_LIMIT:
            raise AdministrationError("The local gateway returned an oversized response.")
        if response.status != 200:
            # Do not echo bodies, cookies or exceptions that could include secrets.
            raise AdministrationError(f"The local gateway rejected this operation (HTTP {response.status}).")
        parsed = json.loads(data)
        if not isinstance(parsed, dict):
            raise AdministrationError("The local gateway returned an unexpected response.")
        return parsed
    except (OSError, http.client.HTTPException):
        raise AdministrationError("Cannot reach the local gateway. Start the container and wait for its health check.") from None
    except (ValueError, UnicodeError):
        raise AdministrationError("The local gateway returned an invalid response.") from None
    finally:
        connection.close()


def setup_code(data_directory):
    filename = Path(data_directory).absolute() / "security" / "setup-code.txt"
    try:
        # The data mount, each directory and the code must be ordinary paths.
        # O_NOFOLLOW also closes the final-file symlink race on Linux.
        for item in reversed((filename, *filename.parents)):
            mode = item.lstat().st_mode
            if stat.S_ISLNK(mode) or item != filename and not stat.S_ISDIR(mode):
                raise AdministrationError("The setup-code path must contain only ordinary directories and a regular file.")
        descriptor = os.open(filename, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(descriptor, "rb") as source:
            if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                raise AdministrationError("The setup code must be a regular file.")
            code = source.read(128).decode("ascii").strip()
        if not SETUP_CODE.fullmatch(code):
            raise AdministrationError("The local setup-code file is invalid.")
        return code
    except FileNotFoundError:
        raise AdministrationError("The setup code is absent. Initial setup may already be complete; check the container and data volume.") from None
    except (OSError, UnicodeError):
        raise AdministrationError("Cannot safely read the local setup code. Check the container user and data-volume permissions.") from None


def stdin_line(label, maximum):
    # Explicit --stdin is for a pipe from a password manager or an isolated test.
    # Limit reads before allocating an arbitrary amount of input.
    line = sys.stdin.readline(maximum + 3)
    if not line or not line.endswith("\n"):
        raise AdministrationError(f"Provide {label} as one newline-terminated input line.")
    value = line[:-1].removesuffix("\r")
    if len(value) > maximum:
        raise AdministrationError(f"The {label} exceeds its maximum length.")
    return value


def credentials(from_stdin):
    if from_stdin:
        username = stdin_line("username", 64)
        password = stdin_line("password", 256)
        confirmation = stdin_line("password confirmation", 256)
    else:
        if not sys.stdin.isatty():
            raise AdministrationError("Use an interactive terminal (docker compose exec gateway sparkstudio-admin setup), or explicitly supply --stdin.")
        print("Create the first gateway administrator. There are no default credentials.", file=sys.stderr)
        username = input("Username: ")
        # getpass normally hides input. Refuse fallback-to-echo behavior.
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            try:
                password = getpass.getpass("Password (12–256 characters): ")
                confirmation = getpass.getpass("Confirm password: ")
            except getpass.GetPassWarning:
                raise AdministrationError("A terminal that can hide password input is required; use docker compose exec without -T.") from None
    if not USERNAME.fullmatch(username):
        raise AdministrationError("Use 3–64 letters, digits, dots, underscores or hyphens for the username.")
    if len(password) < 12 or len(password) > 256 or "\x00" in password:
        raise AdministrationError("Use a password of 12–256 characters without a NUL character.")
    if password != confirmation:
        raise AdministrationError("The passwords do not match. No account was created.")
    return username, password


def health():
    response = local_request("GET", "/api/ready")
    if response.get("product") != "SparkStudio" or response.get("status") != "ready" or response.get("pythonAvailable") is not True:
        raise AdministrationError("The gateway is not ready, including its Python worker.")
    print("SparkStudio gateway and Python worker are ready.")


def setup(from_stdin):
    state = local_request("GET", "/api/auth/session?audience=engineering")
    if state.get("setupRequired") is not True:
        raise AdministrationError("Initial setup is already complete. This command cannot add or replace accounts.")
    code = setup_code(os.environ.get("SPARKSTUDIO_DATA_DIR", "/data"))
    username, password = credentials(from_stdin)
    result = local_request("POST", "/api/auth/setup", {"setupCode": code, "username": username, "password": password})
    if result.get("setupRequired") is not False or not isinstance(result.get("user"), dict) or result["user"].get("gatewayAdmin") is not True:
        raise AdministrationError("Setup returned an unexpected result. Check the gateway before attempting it again.")
    # No cookie jar, token output or automatic second write after an uncertain result.
    print("Initial administrator created. Sign in at the container's HTTPS address with the credentials you chose.")


def main(arguments=None):
    parser = argparse.ArgumentParser(description="Administer only the gateway in this container over its private loopback listener.")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("health", help="Check gateway and Python readiness inside the container.")
    command = commands.add_parser("setup", help="Create the first administrator; cannot reset or replace existing accounts.")
    command.add_argument("--stdin", action="store_true", help="Read username, password and confirmation as three lines from stdin instead of prompting.")
    options = parser.parse_args(arguments)
    try:
        if options.command == "health":
            health()
        else:
            setup(options.stdin)
        return 0
    except (AdministrationError, EOFError):
        error = sys.exc_info()[1]
        print(f"Administration failed: {error or 'Input ended before setup completed.'}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("Administration cancelled. Check the gateway before retrying an interrupted setup request.", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
