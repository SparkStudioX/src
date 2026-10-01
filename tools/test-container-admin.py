"""Synthetic, offline CLI tests; never contacts a running gateway or real data."""

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock


spec = importlib.util.spec_from_file_location("container_admin", Path(__file__).with_name("container-admin.py"))
admin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(admin)
CODE = "a" * 43
PASSWORD = "Synthetic password 123!"


class ContainerAdministrationTests(unittest.TestCase):
    def test_transport_ignores_proxy_environment_and_never_follows_redirect(self):
        connection = mock.Mock()
        connection.getresponse.return_value.status = 302
        connection.getresponse.return_value.read.return_value = b'{"error":"secret response"}'
        with mock.patch.object(admin.http.client, "HTTPConnection", return_value=connection) as create, mock.patch.dict(os.environ, {"HTTP_PROXY": "http://example.invalid", "SPARKSTUDIO_ADMIN_URL": "http://example.invalid"}):
            with self.assertRaisesRegex(admin.AdministrationError, "HTTP 302") as error:
                admin.local_request("POST", "/api/auth/setup", {"setupCode": CODE, "password": PASSWORD})
        create.assert_called_once_with("127.0.0.1", 5090, timeout=10)
        self.assertNotIn("secret", str(error.exception))
        connection.request.assert_called_once()
        connection.close.assert_called_once()
        request = connection.request.call_args
        self.assertEqual(request.args[:2], ("POST", "/api/auth/setup"))
        self.assertEqual(request.kwargs["headers"], {"Content-Type": "application/json"})

    def test_response_body_is_bounded_and_errors_are_sanitized(self):
        for status, payload, message in [(200, b"x" * (admin.RESPONSE_LIMIT + 1), "oversized"), (200, b"private-not-json", "invalid"), (200, b"[]", "unexpected"), (403, b"private-error", "HTTP 403")]:
            with self.subTest(message=message):
                connection = mock.Mock()
                connection.getresponse.return_value.status = status
                connection.getresponse.return_value.read.return_value = payload
                with mock.patch.object(admin.http.client, "HTTPConnection", return_value=connection):
                    with self.assertRaisesRegex(admin.AdministrationError, message) as error:
                        admin.local_request("GET", "/api/ready")
                self.assertNotIn("private", str(error.exception))
                connection.getresponse.return_value.read.assert_called_once_with(admin.RESPONSE_LIMIT + 1)
        with mock.patch.object(admin.http.client, "HTTPConnection") as create:
            create.return_value.request.side_effect = OSError("private path and secret")
            with self.assertRaisesRegex(admin.AdministrationError, "Cannot reach") as error:
                admin.local_request("GET", "/api/ready")
            self.assertNotIn("secret", str(error.exception))

    def test_setup_code_is_bounded_validated_and_rejects_links(self):
        with tempfile.TemporaryDirectory() as folder:
            security = Path(folder) / "security"
            security.mkdir()
            code = security / "setup-code.txt"
            for value in ["bad", CODE + "suffix", "é" * 43, "x" * 5000]:
                code.write_text(value, encoding="utf-8")
                with self.assertRaises(admin.AdministrationError):
                    admin.setup_code(folder)
            code.write_text(CODE + "\n", encoding="ascii")
            self.assertEqual(admin.setup_code(folder), CODE)
            # Test link rejection without requiring Windows symlink privileges.
            original = Path.lstat
            def linked(path):
                result = original(path)
                return mock.Mock(st_mode=0o120777) if path == code else result
            with mock.patch.object(Path, "lstat", linked):
                with self.assertRaisesRegex(admin.AdministrationError, "ordinary"):
                    admin.setup_code(folder)
            code.unlink()
            with self.assertRaisesRegex(admin.AdministrationError, "absent"):
                admin.setup_code(folder)

    def test_explicit_stdin_and_validation_prevent_accidental_account_writes(self):
        cases = [("bad name", PASSWORD, PASSWORD), ("ok-user", "short", "short"), ("ok-user", PASSWORD, "Mismatch password"), ("ok-user", "x" * 257, "x" * 257), ("ok-user", "bad\x00password-value", "bad\x00password-value")]
        for username, password, confirmation in cases:
            with self.subTest(username=username, password_length=len(password)), mock.patch.object(admin.sys, "stdin", io.StringIO(f"{username}\n{password}\n{confirmation}\n")):
                with self.assertRaises(admin.AdministrationError):
                    admin.credentials(True)
        with mock.patch.object(admin.sys, "stdin", io.StringIO("admin\npassword-without-newline")):
            with self.assertRaisesRegex(admin.AdministrationError, "newline"):
                admin.credentials(True)
        with mock.patch.object(admin.sys, "stdin", io.StringIO("admin\n" + PASSWORD + "\n" + PASSWORD + "\n")):
            with self.assertRaisesRegex(admin.AdministrationError, "interactive"):
                admin.credentials(False)
        with mock.patch.object(admin.sys, "stdin", io.StringIO("admin\r\n" + PASSWORD + "\r\n" + PASSWORD + "\r\n")):
            self.assertEqual(admin.credentials(True), ("admin", PASSWORD))

    def test_interactive_password_echo_fallback_is_refused(self):
        terminal = mock.Mock()
        terminal.isatty.return_value = True
        with mock.patch.object(admin.sys, "stdin", terminal), mock.patch("builtins.input", return_value="admin"), mock.patch.object(admin.getpass, "getpass", side_effect=admin.getpass.GetPassWarning("Password may echo")), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaisesRegex(admin.AdministrationError, "hide password"):
                admin.credentials(False)

    def test_successful_setup_uses_existing_code_and_does_not_output_secrets(self):
        responses = [{"setupRequired": True}, {"setupRequired": False, "user": {"gatewayAdmin": True}, "csrfToken": "private-csrf"}]
        output = io.StringIO()
        with mock.patch.object(admin, "local_request", side_effect=responses) as request, mock.patch.object(admin, "setup_code", return_value=CODE), mock.patch.object(admin, "credentials", return_value=("admin", PASSWORD)), contextlib.redirect_stdout(output):
            self.assertEqual(admin.main(["setup", "--stdin"]), 0)
        self.assertEqual(request.call_count, 2)
        self.assertEqual(request.call_args.args, ("POST", "/api/auth/setup", {"setupCode": CODE, "username": "admin", "password": PASSWORD}))
        for secret in [CODE, PASSWORD, "private-csrf"]:
            self.assertNotIn(secret, output.getvalue())
        self.assertIn("Sign in", output.getvalue())

    def test_existing_accounts_and_uncertain_setup_are_never_written_again(self):
        with mock.patch.object(admin, "local_request", return_value={"setupRequired": False}) as request, mock.patch.object(admin, "credentials") as credentials, contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(admin.main(["setup", "--stdin"]), 1)
            request.assert_called_once_with("GET", "/api/auth/session?audience=engineering")
            credentials.assert_not_called()
        with mock.patch.object(admin, "local_request", side_effect=[{"setupRequired": True}, admin.AdministrationError("Cannot reach the local gateway.")]) as request, mock.patch.object(admin, "setup_code", return_value=CODE), mock.patch.object(admin, "credentials", return_value=("admin", PASSWORD)), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(admin.main(["setup", "--stdin"]), 1)
            self.assertEqual(request.call_count, 2)
        with mock.patch.object(admin, "local_request", side_effect=[{"setupRequired": True}, {"setupRequired": False, "user": None}]) as request, mock.patch.object(admin, "setup_code", return_value=CODE), mock.patch.object(admin, "credentials", return_value=("admin", PASSWORD)), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(admin.main(["setup", "--stdin"]), 1)
            self.assertEqual(request.call_count, 2)

    def test_health_fails_closed_and_prints_only_fixed_readiness_message(self):
        for response in [{}, {"product": "SparkStudio", "status": "not-ready", "pythonAvailable": False}, {"product": "other", "status": "ready", "pythonAvailable": True}]:
            with mock.patch.object(admin, "local_request", return_value=response), contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(admin.main(["health"]), 1)
        response = {"product": "SparkStudio", "status": "ready", "pythonAvailable": True, "unexpectedSecret": "do-not-print"}
        output = io.StringIO()
        with mock.patch.object(admin, "local_request", return_value=response) as request, contextlib.redirect_stdout(output):
            self.assertEqual(admin.main(["health"]), 0)
        request.assert_called_once_with("GET", "/api/ready")
        self.assertNotIn("do-not-print", output.getvalue())


if __name__ == "__main__":
    unittest.main(verbosity=2)
