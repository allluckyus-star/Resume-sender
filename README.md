# Resume Sender

Local toolkit for parsing resumes, pairing them with job descriptions, generating ChatGPT prompts, and exporting tailored DOCX files. It includes a **FastAPI backend**, a **Chrome extension** (ChatGPT shortcuts and uploads), and an optional **Windows gateway** that proxies the extension and Explorer uploads to a backend on your LAN.

## Components

| Piece | Role |
|--------|------|
| `main.py` | Resume API: upload/parse resume, JD and role endpoints, ChatGPT prompt flow, DOCX download |
| `local_proxy_app.py` | Listens on **localhost** (default **8787**); forwards to the upstream API |
| `resume-extension/` | MV3 extension: storage, context menus, ChatGPT integration, hotkeys |
| `windows_backend_launcher.py` | One-shot setup under `C:\ResumeSender` and starts the local proxy (used by the packaged EXE) |
| `upload/upload.bat` | Posts a file to `http://localhost:8787/resume` (through the proxy) |
| `resume_sender_win_menu.py` | Windows Explorer “send” menu wiring for uploads |

## Prerequisites

- **Python 3.11+** (3.11 recommended to match the project)
- **Windows** for the packaged launcher, Explorer menu, and `docx2pdf` (Microsoft Word helps for PDF conversion paths)

Install dependencies:

```bash
pip install -r requirements.txt
```

## Run the API server

From the repo root:

```bash
python -m uvicorn main:app --host 0.0.0.0 --port 8000
```

Or on Windows:

```bat
run_server.bat
```

Use another port if needed: `set PORT=8001` before `run_server.bat`, or pass `--port` to uvicorn.

The server binds to **0.0.0.0** by default so other machines on your network can reach it (adjust firewall rules as needed).

## Run the local proxy (extension / upload.bat)

The extension and `upload.bat` target **localhost:8787**. Start the proxy with the upstream URL pointing at your `main.py` instance (same machine or another host on the LAN):

```bash
set RESUME_SENDER_UPSTREAM=http://192.168.x.x:8000
python -m uvicorn local_proxy_app:app --host 127.0.0.1 --port 8787
```

If you use the Windows bundle, upstream is read from `C:\ResumeSender\upstream.txt` (see `upload/upstream.example.txt`). You can also set `RESUME_SENDER_UPSTREAM` or `RESUME_SENDER_UPSTREAM_FALLBACK`.

## Chrome extension

1. Open `chrome://extensions`, enable **Developer mode**, **Load unpacked**, and select the `resume-extension` folder.
2. Set your **User ID** in the extension popup (it should align with `user_id.txt` / upload scripts if you use them).
3. Update **`host_permissions`** in `resume-extension/manifest.json` if your API or proxy URLs differ from the defaults (e.g. `http://192.168.100.17:8000/*`, `http://localhost:8787/*`).

Keyboard shortcuts (defaults in manifest): toggle extension **Alt+Q**, copy ChatGPT prompt **Alt+W**, download DOCX **Alt+A**.

## Packaged Windows backend

```bat
build_backend_exe.bat
```

Produces `dist\ResumeSenderBackend.exe`, which copies the extension and upload helpers into `C:\ResumeSender`, writes default config, refreshes Explorer menu hooks, and starts the local proxy.

## API overview (main app)

All routes expect a per-user id via header **`X-Resume-User-Id`** (or legacy `X-Resume-Client-Id`) or the documented form fields—see `main.py` for exact validation.

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/resume` | Upload resume file for parsing/session |
| POST | `/jd` | Job description payload |
| POST | `/com-role` | Company / role context |
| POST | `/chatgpt-prompt` | Build prompt for ChatGPT |
| POST | `/gpt-result` | Store model output for export |
| GET | `/download` | Download generated DOCX |
| POST | `/download/save` | Persist download payload |

## License

No license file is present in this repository; add one if you intend to distribute the project.
