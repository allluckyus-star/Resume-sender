"""
Local Resume Sender gateway: listens on localhost (typically :8787) and proxies
requests to an upstream Resume backend on the LAN/WAN.

Upstream URL resolution (first match wins):
  1. Environment variable RESUME_SENDER_UPSTREAM
  2. First line of C:\\ResumeSender\\upstream.txt (written by ResumeSenderBackend.exe)
  3. Default http://192.168.100.17:8000

upload.bat continues to POST to http://localhost:8787/resume → this proxy → upstream.
Chrome extension hits localhost → same proxy → upstream.
"""

from __future__ import annotations

import os
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from resume_sender_win_menu import replace_resume_upload_shell_entries

TARGET_ROOT = Path(os.environ.get("RESUME_SENDER_HOME", r"C:\ResumeSender"))
UPSTREAM_FILE = TARGET_ROOT / "upstream.txt"
USER_ID_FILE = TARGET_ROOT / "user_id.txt"
UPLOAD_MENU_IDS_FILE = TARGET_ROOT / "upload_menu_ids.txt"


def _load_upload_menu_ids_ordered() -> list[str]:
    """Cumulative Explorer send(id) ids (one per line), order preserved, deduped."""
    try:
        if not UPLOAD_MENU_IDS_FILE.exists():
            return []
        raw = UPLOAD_MENU_IDS_FILE.read_text(encoding="utf-8")
        seen: set[str] = set()
        out: list[str] = []
        for line in raw.splitlines():
            s = line.strip()
            if not s or s in seen:
                continue
            seen.add(s)
            out.append(s)
        return out
    except OSError:
        return []

DEFAULT_UPSTREAM_FALLBACK = os.environ.get(
    "RESUME_SENDER_UPSTREAM_FALLBACK",
    "http://192.168.100.17:8000",
)

SKIP_REQUEST_HEADERS = frozenset({
    "host",
    "connection",
    "content-length",
    "transfer-encoding",
    "accept-encoding",
    "keep-alive",
    "upgrade",
})

_cached_upstream = ""
_cached_mtime: float | None = None


def resolve_upstream_base() -> str:
    """Return upstream base URL without trailing slash."""
    env = os.environ.get("RESUME_SENDER_UPSTREAM", "").strip()
    if env:
        return env.rstrip("/")

    global _cached_upstream, _cached_mtime
    try:
        stat = UPSTREAM_FILE.stat()
        if _cached_mtime != stat.st_mtime_ns:
            raw = UPSTREAM_FILE.read_text(encoding="utf-8").strip().splitlines()
            url = raw[0].strip() if raw else ""
            _cached_upstream = url.rstrip("/") if url else ""
            _cached_mtime = stat.st_mtime_ns
    except OSError:
        _cached_upstream = ""

    if _cached_upstream:
        return _cached_upstream

    return DEFAULT_UPSTREAM_FALLBACK.rstrip("/")


def build_forward_headers(request: Request, *, drop_headers: frozenset[str]) -> dict[str, str]:
    """Forward incoming headers minus hop-by-hop names."""
    out: dict[str, str] = {}
    for key, value in request.headers.items():
        lk = key.lower()
        if lk in drop_headers:
            continue
        out[key] = value
    return out


async def proxy_request(method: str, upstream_path: str, request: Request) -> Response:
    base = resolve_upstream_base()
    if not base:
        raise HTTPException(status_code=503, detail="Upstream URL not configured.")

    url = f"{base}{upstream_path}"
    forwards = build_forward_headers(request, drop_headers=SKIP_REQUEST_HEADERS)
    body = await request.body()
    if method in ("GET", "HEAD"):
        content = None
    else:
        content = body if body else None

    timeout = httpx.Timeout(
        connect=float(os.environ.get("RESUME_SENDER_CONNECT_TIMEOUT", "30")),
        read=float(os.environ.get("RESUME_SENDER_READ_TIMEOUT", "300")),
        write=float(os.environ.get("RESUME_SENDER_WRITE_TIMEOUT", "300")),
        pool=float(os.environ.get("RESUME_SENDER_POOL_TIMEOUT", "300")),
    )

    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            upstream = await client.request(method, url, headers=forwards, content=content)
    except httpx.ConnectError as exc:
        raise HTTPException(
            status_code=503,
            detail=f"Upstream unreachable ({base}): cannot connect — check VPN/network or server.",
        ) from exc
    except httpx.TimeoutException as exc:
        raise HTTPException(
            status_code=504,
            detail=f"Upstream timed out ({base}).",
        ) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Upstream error ({base}): {exc}",
        ) from exc

    resp_headers = [(k, v) for k, v in upstream.headers.items() if k.lower() != "transfer-encoding"]

    # Avoid gzip mismatch when server gunzips incorrectly.
    filtered = [(k, v) for k, v in resp_headers if k.lower() != "content-encoding"]

    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        headers=dict(filtered),
        media_type=upstream.headers.get("content-type"),
    )


app = FastAPI(title="Resume Sender Local Gateway")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/jd")
async def jd_proxy(request: Request):
    return await proxy_request("POST", "/jd", request)


@app.post("/com-role")
async def com_role_proxy(request: Request):
    return await proxy_request("POST", "/com-role", request)


@app.post("/resume")
async def resume_proxy(request: Request):
    return await proxy_request("POST", "/resume", request)


@app.post("/chatgpt-prompt")
async def chatgpt_prompt_proxy(request: Request):
    return await proxy_request("POST", "/chatgpt-prompt", request)


@app.post("/gpt-result")
async def gpt_result_proxy(request: Request):
    return await proxy_request("POST", "/gpt-result", request)


@app.get("/download")
async def download_proxy(request: Request):
    query = request.url.query
    path = "/download"
    if query:
        path = f"{path}?{query}"
    return await proxy_request("GET", path, request)


@app.post("/download/save")
async def download_save_proxy(request: Request):
    return await proxy_request("POST", "/download/save", request)


@app.get("/health")
async def health():
    base = resolve_upstream_base()
    connected = False
    detail = ""
    try:
        timeout = httpx.Timeout(connect=10.0, read=15.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            r = await client.get(f"{base}/openapi.json")
            connected = r.status_code < 500
    except Exception as exc:
        connected = False
        detail = str(exc)

    return {
        "role": "local-gateway",
        "upstream_configured": bool(base),
        "upstream_base": base,
        "upstream_reachable": connected,
        "upstream_probe_detail": detail or None,
    }


@app.post("/local/user-id")
async def write_local_user_id(request: Request):
    """Plain text body (UTF-8) → user_id.txt; new ids append to upload_menu_ids.txt + Explorer send(id)."""
    raw = await request.body()
    uid = raw.decode("utf-8", errors="replace").strip()
    if not uid:
        raise HTTPException(status_code=400, detail="Empty body")

    if len(uid) > 128:
        uid = uid[:128]

    menus = _load_upload_menu_ids_ordered()
    if uid not in menus:
        menus.append(uid)

    TARGET_ROOT.mkdir(parents=True, exist_ok=True)
    USER_ID_FILE.write_text(uid + "\n", encoding="utf-8")
    UPLOAD_MENU_IDS_FILE.write_text("\n".join(menus) + ("\n" if menus else ""), encoding="utf-8")
    replace_resume_upload_shell_entries(menus, home=TARGET_ROOT)
    return Response(content=b"ok", media_type="text/plain")

