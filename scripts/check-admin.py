#!/usr/bin/env python3
"""Static-server contract checks; browser flows require the content backend."""
from pathlib import Path
import sys
import unittest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from admin.main import api_origin, create_app


class AdminTests(unittest.TestCase):
    def test_origin_rejects_credentials_paths_and_remote_http(self):
        for value in ("http://example.com", "https://user:secret@example.com", "https://example.com/path",
                      "https://example.com/?token=x", "https://example.com/#x", "javascript:alert(1)",
                      " https://example.com", "https://example.com\n", "https://exam\nple.com"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                api_origin(value)

    def test_local_development_and_https(self):
        self.assertEqual(api_origin("http://127.0.0.1:18000/"), "http://127.0.0.1:18000")
        self.assertEqual(api_origin("https://example.com/"), "https://example.com")

    def test_configuration_contains_no_credentials(self):
        with TestClient(create_app("https://api.example.com")) as client:
            response = client.get("/config.json")
            self.assertEqual(response.json(), {"api_base_url": "https://api.example.com"})
            self.assertEqual(response.headers["cache-control"], "no-store")
            self.assertIn("connect-src 'self' https://api.example.com", response.headers["content-security-policy"])

    def test_assets_are_allowlisted_and_pages_have_security_headers(self):
        with TestClient(create_app()) as client:
            for path in ("/", "/admin", "/admin/assets/app.js", "/admin/assets/styles.css"):
                with self.subTest(path=path):
                    response = client.get(path)
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.headers["x-frame-options"], "DENY")
                    self.assertEqual(response.headers["x-content-type-options"], "nosniff")
            self.assertEqual(client.get("/admin/assets/.env").status_code, 404)
            self.assertEqual(client.get("/docs").status_code, 404)


if __name__ == "__main__":
    unittest.main(verbosity=2)
