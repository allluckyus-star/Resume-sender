import os
import shutil
import socket
import sys
from pathlib import Path

import uvicorn

from local_proxy_app import app
from resume_sender_win_menu import replace_resume_upload_shell_entries


TARGET_ROOT = Path(r"C:\ResumeSender")
TARGET_UPLOAD_BAT = TARGET_ROOT / "upload.bat"
TARGET_MENU_IDS_TXT = TARGET_ROOT / "upload_menu_ids.txt"
TARGET_EXTENSION_DIR = TARGET_ROOT / "resume-extension"
TARGET_UPSTREAM_TXT = TARGET_ROOT / "upstream.txt"
TARGET_USER_ID_TXT = TARGET_ROOT / "user_id.txt"
DEFAULT_UPSTREAM_URL = os.environ.get(
    "RESUME_SENDER_UPSTREAM_DEFAULT",
    "http://192.168.100.17:8000",
)
def _log(message: str) -> None:
    print(f"[ResumeSender Setup] {message}", flush=True)


def _bundle_root() -> Path:
    if hasattr(sys, "_MEIPASS"):
        return Path(getattr(sys, "_MEIPASS"))
    return Path(__file__).resolve().parent


def ensure_target_root() -> None:
    if not TARGET_ROOT.exists():
        TARGET_ROOT.mkdir(parents=True, exist_ok=True)
        _log(f"Created {TARGET_ROOT}")


def ensure_upload_bat() -> None:
    source_candidates = [
        _bundle_root() / "upload" / "upload.bat",
        Path(__file__).resolve().parent / "upload" / "upload.bat",
    ]

    source_path = None
    for candidate in source_candidates:
        if candidate.exists():
            source_path = candidate
            break

    if source_path is None:
        _log("upload.bat source not found in bundle, writing fallback file.")
        fallback = (
            "@echo off\n"
            "setlocal EnableDelayedExpansion\n"
            "set \"UIDFILE=C:\\ResumeSender\\user_id.txt\"\n"
            "set \"ARG1=%~1\"\n"
            "set \"ARG2=%~2\"\n"
            "if not \"!ARG2!\"==\"\" (\n"
            "  set \"RUID=!ARG1!\"\n"
            "  set \"UFILE=!ARG2!\"\n"
            "  goto :do_upload\n"
            ")\n"
            "set \"UFILE=!ARG1!\"\n"
            "set \"RUID=\"\n"
            "if exist \"%UIDFILE%\" (\n"
            "  for /f \"usebackq tokens=* delims=\" %%a in (\"%UIDFILE%\") do (\n"
            "    set \"RUID=%%a\"\n"
            "    goto :gotuid\n"
            "  )\n"
            ")\n"
            ":gotuid\n"
            "set \"RUID=!RUID: =!\"\n"
            "if \"!RUID!\"==\"\" (\n"
            "  echo Missing User ID. Set User ID in the Resume Sender extension.\n"
            "  exit /b 1\n"
            ")\n"
            ":do_upload\n"
            "if \"!UFILE!\"==\"\" (\n"
            "  echo Missing file path.\n"
            "  exit /b 1\n"
            ")\n"
            "echo Uploading file: !UFILE!\n"
            "curl -X POST -F \"resume_file=@!UFILE!\" -F \"user_id=!RUID!\" \"http://localhost:8787/resume\"\n"
            "exit /b\n"
        )
        TARGET_UPLOAD_BAT.write_text(fallback, encoding="utf-8")
        return

    shutil.copy2(source_path, TARGET_UPLOAD_BAT)
    _log(f"Ensured upload script at {TARGET_UPLOAD_BAT}")


def ensure_extension_folder() -> None:
    if TARGET_EXTENSION_DIR.exists():
        return

    source_candidates = [
        _bundle_root() / "resume-extension",
        Path(__file__).resolve().parent / "resume-extension",
    ]
    source_dir = None
    for candidate in source_candidates:
        if candidate.exists() and candidate.is_dir():
            source_dir = candidate
            break

    if source_dir is None:
        _log("resume-extension source not found in bundle.")
        return

    shutil.copytree(source_dir, TARGET_EXTENSION_DIR, dirs_exist_ok=True)
    _log(f"Copied extension to {TARGET_EXTENSION_DIR}")


def ensure_context_menu() -> None:
    menus: list[str] = []
    try:
        if TARGET_MENU_IDS_TXT.exists():
            raw = TARGET_MENU_IDS_TXT.read_text(encoding="utf-8")
            menus = [ln.strip() for ln in raw.splitlines() if ln.strip()]
    except OSError as exc:
        _log(f"Could not read upload_menu_ids.txt: {exc}")

    if not menus:
        try:
            if TARGET_USER_ID_TXT.exists():
                raw = TARGET_USER_ID_TXT.read_text(encoding="utf-8")
                lines = [ln.strip() for ln in raw.splitlines() if ln.strip()]
                if lines:
                    menus = [lines[0]]
        except OSError as exc:
            _log(f"Could not read user_id.txt for menus: {exc}")

    replace_resume_upload_shell_entries(menus, home=TARGET_ROOT)
    preview = ", ".join(menus) if menus else "(none)"
    _log(f"Context menu entries verified: {len(menus)} send(...) — {preview}")


def ensure_upstream_txt() -> None:
    """One-line URL the local gateway forwards to (remote Resume API server)."""
    if TARGET_UPSTREAM_TXT.exists():
        return
    TARGET_UPSTREAM_TXT.write_text(
        f"{DEFAULT_UPSTREAM_URL.strip()}\n",
        encoding="utf-8",
    )
    _log(f"Created default upstream config {TARGET_UPSTREAM_TXT} -> {DEFAULT_UPSTREAM_URL.strip()}")


def ensure_user_id_txt() -> None:
    """Empty placeholder; popup POST /local/user-id (plain text) fills it for upload.bat."""
    if TARGET_USER_ID_TXT.exists():
        return
    TARGET_USER_ID_TXT.write_text("", encoding="utf-8")
    _log(f"Created empty {TARGET_USER_ID_TXT} (set User ID in extension to sync)")


def _check_listen_port(host: str, port: int) -> None:
    """Fail fast with a clear message if the port is already taken (WinError 10048)."""
    if port <= 0 or port > 65535:
        print(f"[ResumeSender ERROR] Invalid port: {port}", flush=True)
        sys.exit(1)

    bind_host = host
    if host in ("0.0.0.0", "", "::"):
        bind_host = "0.0.0.0"

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.bind((bind_host, port))
    except OSError as exc:
        print(
            "\n[ResumeSender ERROR] Cannot listen on port "
            f"{port} ({exc!s}).\n"
            "  Another program is already using that port — often:\n"
            "    - another ResumeSenderBackend.exe\n"
            "    - another app already listening on the same port\n"
            "    - another dev server or Docker mapping\n"
            "  Fix: stop the other process, or use a different port before starting this EXE, e.g.:\n"
            "    set RESUME_SENDER_PORT=8001\n"
            "    ResumeSenderBackend.exe\n"
            "  If you change the port, set RESUME_SENDER_PORT and update upload.bat / extension "
            "(local gateway defaults to 8787).\n",
            flush=True,
        )
        if sys.stdin.isatty():
            try:
                input("Press Enter to exit...")
            except (EOFError, OSError):
                pass
        sys.exit(1)
    finally:
        sock.close()


def run_server() -> None:
    host = os.environ.get("RESUME_SENDER_HOST", "0.0.0.0")
    port = int(os.environ.get("RESUME_SENDER_PORT", "8787"))
    _check_listen_port(host, port)
    _log(f"Starting local gateway (proxy to upstream) on {host}:{port}")
    uvicorn.run(app, host=host, port=port)


def main() -> None:
    ensure_target_root()
    ensure_upload_bat()
    ensure_extension_folder()
    ensure_upstream_txt()
    ensure_user_id_txt()
    ensure_context_menu()
    run_server()


def _write_fatal_log(text: str) -> None:
    try:
        ensure_target_root()
        (TARGET_ROOT / "last_error.txt").write_text(text, encoding="utf-8")
    except OSError:
        pass


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except BaseException as exc:
        import traceback

        err = traceback.format_exc()
        msg = f"\n[ResumeSender FATAL] {exc!s}\n{err}"
        print(msg, flush=True)
        _write_fatal_log(msg)
        try:
            input("Press Enter to close...")
        except (EOFError, OSError):
            pass
        raise SystemExit(1) from exc
