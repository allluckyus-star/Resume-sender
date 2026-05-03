"""Windows Explorer — multiple send(<user_id>) shell entries (one per account)."""

from __future__ import annotations

import hashlib
import os
import sys
from pathlib import Path

SHELL_PARENT = r"Software\Classes\*\shell"
MENU_KEY_PREFIX = "ResumeSenderUpload_"
LEGACY_SHELL = "SendToResume"


def default_resume_sender_home() -> Path:
    return Path(os.environ.get("RESUME_SENDER_HOME", r"C:\ResumeSender"))


def send_menu_caption(user_id: str, *, max_total: int = 64) -> str:
    uid = (user_id or "").strip()
    if not uid:
        return "send(not set)"
    overhead = len("send()")
    max_inner = max(4, max_total - overhead)
    inner = uid
    if len(inner) > max_inner:
        inner = inner[: max_inner - 3] + "..."
    return f"send({inner})"


def _shell_key_name_for_uid(uid: str) -> str:
    digest = hashlib.md5(uid.encode("utf-8")).hexdigest()
    return f"{MENU_KEY_PREFIX}{digest}"


def _enum_managed_shell_keys(winreg) -> list[str]:
    out: list[str] = []
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, SHELL_PARENT, 0, winreg.KEY_READ) as parent:
            i = 0
            while True:
                try:
                    name = winreg.EnumKey(parent, i)
                except OSError:
                    break
                if name.startswith(MENU_KEY_PREFIX) or name == LEGACY_SHELL:
                    out.append(name)
                i += 1
    except OSError:
        pass
    return out


def _delete_shell_branch(winreg, name: str) -> None:
    base = f"{SHELL_PARENT}\\{name}"
    cmd = f"{base}\\command"
    try:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, cmd)
    except OSError:
        pass
    try:
        winreg.DeleteKey(winreg.HKEY_CURRENT_USER, base)
    except OSError:
        pass


def replace_resume_upload_shell_entries(user_ids: list[str], *, home: Path | None = None) -> None:
    """Remove prior ResumeSender / legacy shell keys, then add one send(<id>) entry per id (Windows only)."""
    if sys.platform != "win32":
        return
    try:
        import winreg
    except ImportError:
        return

    root = home or default_resume_sender_home()
    try:
        bat = str((root / "upload.bat").resolve())
    except OSError:
        bat = str(root / "upload.bat")

    ordered: list[str] = []
    seen: set[str] = set()
    for raw in user_ids:
        u = (raw or "").strip()
        if len(u) > 128:
            u = u[:128]
        if not u or u in seen:
            continue
        seen.add(u)
        ordered.append(u)

    for name in _enum_managed_shell_keys(winreg):
        _delete_shell_branch(winreg, name)

    for uid in ordered:
        sub = _shell_key_name_for_uid(uid)
        cap = send_menu_caption(uid)
        key_path = f"{SHELL_PARENT}\\{sub}"
        cmd_path = f"{key_path}\\command"
        if '"' in uid or "\r" in uid or "\n" in uid:
            continue
        command_value = f'"{bat}" "{uid}" "%1"'

        try:
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key_path) as sk:
                winreg.SetValueEx(sk, "", 0, winreg.REG_SZ, cap)
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, cmd_path) as ck:
                winreg.SetValueEx(ck, "", 0, winreg.REG_SZ, command_value)
        except OSError:
            pass


def update_send_to_resume_context_menu(user_id: str, *, home: Path | None = None) -> None:
    """Backward-compatible: one menu entry for this id, or clear if empty."""
    uid = (user_id or "").strip()
    replace_resume_upload_shell_entries([uid] if uid else [], home=home)
