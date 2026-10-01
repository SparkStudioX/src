#!/usr/bin/env python3
"""Container startup regressions; generated certificates stay in temporary fixtures."""
import contextlib
import importlib.util
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch


sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("docker_entrypoint", Path(__file__).with_name("docker-entrypoint.py"))
entrypoint = importlib.util.module_from_spec(spec)
spec.loader.exec_module(entrypoint)


class SettingsChecks(unittest.TestCase):
    def test_names_normalize_and_deduplicate(self):
        self.assertEqual(entrypoint.identities(" LOCALHOST ,127.0.0.1,::1,localhost"),
                         [("DNS", "localhost"), ("IP", "127.0.0.1"), ("IP", "::1")])

    def test_names_reject_configuration_injection(self):
        for name in ("", "a,", "https://site", "site:8443", "*.site", "a/b", "a\nDNS:other", "site;other", "-site", "site-", "a..b", "a" * 64,
                     "0.0.0.0", "::", "224.0.0.1", "0.2.3.4", "127.1"):
            with self.subTest(name=name), self.assertRaises(entrypoint.ConfigurationError):
                entrypoint.identities(name)

    def test_name_count_is_bounded(self):
        with self.assertRaises(entrypoint.ConfigurationError):
            entrypoint.identities(",".join(f"host{index}" for index in range(33)))

    def test_certificate_settings_require_both_files(self):
        with tempfile.TemporaryDirectory() as temporary, self.assertRaises(entrypoint.ConfigurationError):
            entrypoint.certificate_pair(Path(temporary), [], "/server.crt", None)

    def test_supplied_pair_requires_absolute_paths(self):
        with tempfile.TemporaryDirectory() as temporary, self.assertRaises(entrypoint.ConfigurationError):
            entrypoint.certificate_pair(Path(temporary), [], "server.crt", "server.key")

    def test_public_identity_must_match_tls_names(self):
        with tempfile.TemporaryDirectory() as temporary, self.assertRaises(entrypoint.ConfigurationError):
            entrypoint.configure({"SPARKSTUDIO_DATA_DIR": temporary, "SPARKSTUDIO_PUBLIC_HOST": "different-host"})

    def test_redirect_port_must_be_valid(self):
        with tempfile.TemporaryDirectory() as temporary:
            for port in ("0", "443", "65536", "8443;other", " 8443", "٨٤٤٣"):
                with self.subTest(port=port), self.assertRaises(entrypoint.ConfigurationError):
                    entrypoint.configure({"SPARKSTUDIO_DATA_DIR": temporary, "SPARKSTUDIO_HTTPS_PORT": port})

    def test_management_stays_unexposed_and_redirect_uses_explicit_identity(self):
        with tempfile.TemporaryDirectory() as temporary, patch.object(entrypoint, "certificate_pair", return_value=(Path("/certificate.crt"), Path("/private.key"))):
            result = entrypoint.configure({"SPARKSTUDIO_DATA_DIR": temporary, "SPARKSTUDIO_TLS_NAMES": "::1", "SPARKSTUDIO_PUBLIC_HOST": "::1", "SPARKSTUDIO_HTTPS_PORT": "9443"})
            self.assertEqual(result["Kestrel__Endpoints__ContainerManagement__Url"], "http://127.0.0.1:5090")
            self.assertEqual(result["Kestrel__Endpoints__ContainerHttps__Url"], "https://0.0.0.0:8443")
            self.assertEqual(result["Kestrel__Endpoints__ContainerHttp__Url"], "http://0.0.0.0:8090")
            self.assertEqual(result["SPARKSTUDIO_CONTAINER_HTTPS_ORIGIN"], "https://[::1]:9443")

    def test_openssl_failure_is_sanitized(self):
        import subprocess
        with patch.object(entrypoint.subprocess, "run", side_effect=subprocess.CalledProcessError(1, ["openssl"], stderr=b"private contents")):
            with self.assertRaises(entrypoint.ConfigurationError) as failure:
                entrypoint.openssl("pkey")
            self.assertNotIn("private contents", str(failure.exception))


@unittest.skipUnless(shutil.which("openssl"), "OpenSSL is required for real certificate fixture checks")
class CertificateChecks(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.data = Path(self.temporary.name)
        self.names = entrypoint.identities("localhost,127.0.0.1,::1")
        # Windows lacks fcntl; locking is exercised by actual Linux image tests.
        self.lock = patch.object(entrypoint, "certificate_lock", lambda directory: contextlib.nullcontext())
        self.lock.start()
        self.addCleanup(self.lock.stop)

    def test_first_boot_and_restart_preserve_pair(self):
        certificate, key = entrypoint.certificate_pair(self.data, self.names)
        original = (certificate.read_bytes(), key.read_bytes())
        self.assertEqual(entrypoint.certificate_pair(self.data, self.names), (certificate, key))
        self.assertEqual(original, (certificate.read_bytes(), key.read_bytes()))
        if os.name != "nt":
            self.assertEqual(key.stat().st_mode & 0o777, 0o600)

    def test_mismatch_name_fails_even_if_openssl_query_exits_zero(self):
        certificate, key = entrypoint.certificate_pair(self.data, self.names)
        with self.assertRaises(entrypoint.ConfigurationError):
            entrypoint.validate_pair(certificate, key, entrypoint.identities("missing.example"))

    def test_common_name_cannot_replace_a_missing_dns_san(self):
        certificate, key = self.data / "cn.crt", self.data / "cn.key"
        entrypoint.openssl("req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "1",
                          "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.2", "-keyout", key, "-out", certificate)
        # OpenSSL considers the CN a match here. Browser-safe validation must not.
        self.assertTrue(entrypoint.openssl("x509", "-in", certificate, "-noout", "-checkhost", "localhost").endswith(" does match certificate"))
        with self.assertRaises(entrypoint.ConfigurationError):
            entrypoint.validate_pair(certificate, key, entrypoint.identities("localhost"))

    def test_mismatch_private_key_fails(self):
        certificate, key = entrypoint.certificate_pair(self.data, self.names)
        other_certificate, other_key = entrypoint.certificate_pair(self.data / "other", self.names)
        with self.assertRaises(entrypoint.ConfigurationError):
            entrypoint.validate_pair(certificate, other_key, self.names)

    def test_incomplete_existing_pair_is_not_overwritten(self):
        certificate, key = entrypoint.certificate_pair(self.data, self.names)
        original = certificate.read_bytes()
        # Generated disposable fixture only; the real volume is never touched.
        key.unlink()
        with self.assertRaises(entrypoint.ConfigurationError):
            entrypoint.certificate_pair(self.data, self.names)
        self.assertEqual(certificate.read_bytes(), original)

    def test_supplied_pair_is_validated_without_replacement(self):
        certificate, key = entrypoint.certificate_pair(self.data, self.names)
        original = (certificate.read_bytes(), key.read_bytes())
        self.assertEqual(entrypoint.certificate_pair(self.data / "provided", self.names, str(certificate), str(key)), (certificate, key))
        self.assertEqual(original, (certificate.read_bytes(), key.read_bytes()))


if __name__ == "__main__":
    unittest.main()
