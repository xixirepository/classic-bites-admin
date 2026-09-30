"""Serve the independent administrator UI; content lives in the existing API."""

import os
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse


STATIC = Path(__file__).parent / "static"


def api_origin(value: str) -> str:
    if any(character.isspace() or ord(character) < 32 or ord(character) == 127 for character in value):
        raise ValueError("ADMIN_API_BASE_URL must not contain whitespace or control characters.")
    parsed = urlsplit(value)
    if (not parsed.hostname or parsed.username or parsed.password or parsed.query
            or parsed.fragment or parsed.path not in ("", "/")):
        raise ValueError("ADMIN_API_BASE_URL must be an origin without credentials or path.")
    if parsed.scheme != "https" and not (
        parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1")
    ):
        raise ValueError("Use HTTPS; HTTP is allowed only for local development on loopback.")
    # Validate the port before the origin is used in a response header.
    _ = parsed.port
    return value.rstrip("/")


def create_app(backend_url: str | None = None):
    origin = api_origin(backend_url or os.environ.get("ADMIN_API_BASE_URL", "https://vpn.xixiplay.com"))
    app = FastAPI(title="Classic Bites Admin", docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def security_headers(request, call_next):
        response = await call_next(request)
        response.headers.update({
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "X-Frame-Options": "DENY",
            "Content-Security-Policy": (
                "default-src 'none'; script-src 'self'; style-src 'self'; "
                f"connect-src 'self' {origin}; img-src 'self' blob:; "
                "font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
            ),
        })
        return response

    @app.get("/")
    @app.get("/admin")
    @app.get("/admin/", include_in_schema=False)
    def index():
        return FileResponse(STATIC / "index.html", media_type="text/html")

    @app.get("/config.json")
    def configuration():
        return {"api_base_url": origin}

    @app.get("/admin/assets/{filename}")
    def asset(filename: str):
        types = {"app.js": "text/javascript", "styles.css": "text/css"}
        if filename not in types:
            return JSONResponse({"detail": "Not found"}, status_code=404)
        return FileResponse(STATIC / filename, media_type=types[filename])

    @app.get("/health")
    def health():
        return {"status": "ok"}

    return app


app = create_app()
