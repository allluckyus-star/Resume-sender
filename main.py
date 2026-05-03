import json
import logging
import os
import re
import tempfile
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from docx_export import export_to_docx
from file_parser import extract_text
from resume_parser import extract_resume_facts, structure_ai_output


app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

LOGGER = logging.getLogger("uvicorn.error")


SESSION_STORES: dict[str, dict[str, Any]] = {}

USER_ID_HEADER = "x-resume-user-id"
LEGACY_USER_ID_HEADER = "x-resume-client-id"


def _sanitize_user_id(raw: str) -> str:
    """Allow safe ids (email-style or short handles). Empty after trim => invalid."""
    s = str(raw or "").strip()
    if not s:
        return ""
    if len(s) > 128:
        s = s[:128]
    if not re.fullmatch(r"[A-Za-z0-9_@.\-]+", s):
        raise HTTPException(
            status_code=400,
            detail="User ID contains invalid characters. Use letters, digits, _ - @ . only.",
        )
    return s


def _resolve_user_id(request: Request, form_user_id: str | None = None) -> str:
    header_val = request.headers.get(USER_ID_HEADER) or request.headers.get(LEGACY_USER_ID_HEADER)
    candidate = (header_val or form_user_id or "").strip()
    if not candidate:
        return ""
    return _sanitize_user_id(candidate)


def _require_user_id(request: Request, form_user_id: str | None = None) -> str:
    uid = _resolve_user_id(request, form_user_id)
    if not uid:
        raise HTTPException(
            status_code=400,
            detail="User ID missing. Set it in the extension popup, or send header X-Resume-User-Id (form field user_id for upload).",
        )
    return uid


def _log_user_request(request: Request, action: str, user_id: str) -> None:
    method = str(request.method or "UNKNOWN")
    path = str(getattr(request.url, "path", "") or "")
    safe = f"{user_id[:3]}…" if len(user_id) > 6 else user_id
    message = f"[ResumeSender] user_id={safe} action={action} method={method} path={path}"
    LOGGER.info(message)
    print(message, flush=True)


def _session_for_key(key: str) -> dict[str, Any]:
    if key not in SESSION_STORES:
        SESSION_STORES[key] = {
            "job_description": "",
            "company_role": "",
            "resume_filename": "",
            "resume_text": "",
            "extracted_resume": None,
            "gpt_result_raw": "",
            "gpt_resume_json": None,
            "gpt_extracted_facts": None,
        }
    return SESSION_STORES[key]


def _require_session(request: Request, *, form_user_id: str | None = None) -> tuple[str, dict[str, Any]]:
    key = _require_user_id(request, form_user_id)
    return key, _session_for_key(key)


async def _read_text_request(request: Request) -> str:
    content_type = str(request.headers.get("content-type") or "").lower()
    if "application/json" in content_type:
        payload = await request.json()
        if isinstance(payload, dict):
            return str(payload.get("text") or payload.get("prompt") or payload.get("job_description") or payload.get("gpt_result") or "").strip()
        return str(payload or "").strip()
    raw = await request.body()
    return raw.decode("utf-8", errors="ignore").strip()


def _resume_json_for_download(session: dict[str, Any]) -> dict[str, Any]:
    def _normalize_for_export(payload: dict[str, Any]) -> dict[str, Any]:
        normalized = _normalize_optimized_resume_payload(_sanitize_json_strings(payload))
        inner = normalized.get("optimized_resume")
        if isinstance(inner, dict):
            return inner
        raise HTTPException(status_code=400, detail="Invalid optimized resume payload")

    gpt_json = session.get("gpt_resume_json")
    if isinstance(gpt_json, dict):
        return _normalize_for_export(gpt_json)

    gpt_raw = str(session.get("gpt_result_raw") or "").strip()

    if gpt_raw:
        maybe_json = _extract_json_object(gpt_raw)
        if isinstance(maybe_json, dict) and _looks_like_optimized_resume(maybe_json):
            return _normalize_for_export(maybe_json)
        raise HTTPException(
            status_code=400,
            detail="Stored GPT result is not valid optimized_resume JSON. Re-send the final ChatGPT JSON output.",
        )

    raise HTTPException(
        status_code=400,
        detail="No GPT optimized resume available. Run ChatGPT Prompt (or Alt+W) and wait for auto-send.",
    )


def _require_gpt_result_before_download(session: dict[str, Any]) -> None:
    gpt_raw = str(session.get("gpt_result_raw") or "").strip()
    gpt_json = session.get("gpt_resume_json")
    if gpt_raw or isinstance(gpt_json, dict):
        return
    raise HTTPException(
        status_code=400,
        detail="GPT result not received yet. Click ChatGPT Prompt (or Alt+W), wait for generation, then download.",
    )


def _convert_docx_to_pdf(docx_path: str, pdf_path: str) -> None:
    try:
        from docx2pdf import convert
    except Exception as exc:
        raise HTTPException(status_code=500, detail="docx2pdf is required for PDF export") from exc

    try:
        convert(docx_path, pdf_path)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"DOCX to PDF conversion failed: {exc}") from exc



def _render_prompt_template(
    prompt_template: str,
    job_description: str,
    resume_text: str,
    *,
    facts_json: str = "",
) -> str:
    template = str(prompt_template or "").strip()
    if not template:
        raise HTTPException(status_code=400, detail="Prompt template is empty")
    return (
        template.replace("{jd_text}", str(job_description or "").strip())
        .replace("{resume_text}", str(resume_text or "").strip())
        .replace("{facts_json}", str(facts_json or "").strip())
    )


def _looks_like_extracted_resume_facts(payload: dict[str, Any]) -> bool:
    if not isinstance(payload, dict):
        return False
    return all(key in payload for key in ("name", "contact", "experience", "education"))


def _looks_like_optimized_resume(payload: dict[str, Any]) -> bool:
    if not isinstance(payload, dict):
        return False
    candidate = payload
    for key in ("optimized_resume", "optimizedResume", "resume"):
        if isinstance(payload.get(key), dict):
            candidate = payload.get(key)
            break

    if not isinstance(candidate, dict):
        return False
    if "header" in candidate and "sections" in candidate:
        return True

    sections = candidate.get("sections")
    if isinstance(sections, list) and sections:
        section_types = {
            str(section.get("type", "")).strip().lower()
            for section in sections
            if isinstance(section, dict)
        }
        return bool(section_types.intersection({"summary", "experience", "skills", "education"}))
    return False


def _extract_json_object(text: str) -> dict[str, Any] | None:
    raw = str(text or "").strip()
    if not raw:
        return None

    candidates: list[str] = [raw]
    for match in re.finditer(r"```(?:json)?\s*([\s\S]*?)```", raw, re.IGNORECASE):
        inner = str(match.group(1) or "").strip()
        if inner:
            candidates.append(inner)
    candidates.append("{" + raw + "}")

    # Collect balanced {...} slices from the raw text.
    depth = 0
    start = -1
    for idx, char in enumerate(raw):
        if char == "{":
            if depth == 0:
                start = idx
            depth += 1
        elif char == "}" and depth > 0:
            depth -= 1
            if depth == 0 and start >= 0:
                snippet = raw[start : idx + 1].strip()
                if snippet:
                    candidates.append(snippet)

    # Targeted recovery: pull optimized_resume object even when outer text is noisy.
    key_match = re.search(r'"(optimized_resume|optimizedResume|resume)"\s*:\s*\{', raw)
    if key_match:
        key = str(key_match.group(1))
        value_start = raw.find("{", key_match.end() - 1)
        if value_start >= 0:
            depth2 = 0
            end2 = -1
            for idx in range(value_start, len(raw)):
                ch = raw[idx]
                if ch == "{":
                    depth2 += 1
                elif ch == "}":
                    depth2 -= 1
                    if depth2 == 0:
                        end2 = idx
                        break
            if end2 > value_start:
                obj_slice = raw[value_start : end2 + 1]
                try:
                    parsed_obj = json.loads(obj_slice)
                    if isinstance(parsed_obj, dict):
                        candidates.append(json.dumps({key: parsed_obj}, ensure_ascii=False))
                except json.JSONDecodeError:
                    pass

    def _escape_controls_inside_strings(s: str) -> str:
        out: list[str] = []
        in_string = False
        escape = False
        for ch in s:
            if in_string:
                if escape:
                    out.append(ch)
                    escape = False
                    continue
                if ch == "\\":
                    out.append(ch)
                    escape = True
                    continue
                if ch == '"':
                    out.append(ch)
                    in_string = False
                    continue
                if ch == "\n":
                    out.append("\\n")
                    continue
                if ch == "\r":
                    out.append("\\r")
                    continue
                if ch == "\t":
                    out.append("\\t")
                    continue
                out.append(ch)
                continue
            out.append(ch)
            if ch == '"':
                in_string = True
        return "".join(out)

    seen: set[str] = set()
    for candidate in candidates:
        item = candidate.strip()
        if not item or item in seen:
            continue
        seen.add(item)
        parsed = None
        try:
            parsed = json.loads(item)
        except json.JSONDecodeError:
            repaired = _escape_controls_inside_strings(item)
            if repaired != item:
                try:
                    parsed = json.loads(repaired)
                except json.JSONDecodeError:
                    continue
            else:
                continue
        if isinstance(parsed, dict):
            return parsed
    return None


def _normalize_save_target_path(raw_path: str, default_filename: str) -> Path:
    input_path = str(raw_path or "").strip().strip('"').strip("'")
    if not input_path:
        raise HTTPException(status_code=400, detail="Path is empty")
    if not re.match(r"^[A-Za-z]:[\\/]", input_path):
        raise HTTPException(status_code=400, detail="Absolute Windows path required (example: D:\\AI)")

    normalized = os.path.normpath(input_path)
    base = Path(normalized)
    suffix = base.suffix.lower()

    if suffix in {"", "."}:
        target = base / default_filename
    elif suffix != ".docx":
        raise HTTPException(status_code=400, detail="Only .docx output is supported for absolute path save")
    else:
        target = base

    try:
        target.parent.mkdir(parents=True, exist_ok=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Cannot create target directory: {exc}") from exc
    return target


def _normalize_optimized_resume_payload(payload: dict[str, Any]) -> dict[str, Any]:
    root = payload
    for key in ("optimized_resume", "optimizedResume", "resume"):
        if isinstance(payload.get(key), dict):
            root = payload.get(key)
            break
    header = dict(root.get("header") or {})
    sections = root.get("sections") or []

    if header.get("linkedin") and not header.get("links"):
        header["links"] = str(header.get("linkedin"))
    normalized_sections: list[dict[str, Any]] = []

    for section in sections:
        if not isinstance(section, dict):
            continue
        sec_type = str(section.get("type") or "").strip().lower()
        if sec_type in ("educational", "academic", "academics", "schooling", "degrees"):
            sec_type = "education"
        title = str(section.get("title") or sec_type.title() or "Section")
        items = section.get("items")
        content = section.get("content")

        if sec_type == "summary":
            if isinstance(items, list):
                summary_items = items
            elif isinstance(content, str):
                parts = [part.strip() for part in re.split(r"(?<=[.!?])\s+", content) if part.strip()]
                summary_items = [{"text": part} for part in parts] if parts else [{"text": content}]
            else:
                summary_items = []
            normalized_sections.append({"type": "summary", "title": title, "items": summary_items})
            continue

        if sec_type == "experience":
            source_items = items if isinstance(items, list) else content if isinstance(content, list) else []
            normalized_exp: list[dict[str, Any]] = []
            for role in source_items:
                if not isinstance(role, dict):
                    continue
                bullets = role.get("bullets") if isinstance(role.get("bullets"), list) else []
                normalized_exp.append(
                    {
                        "role": str(role.get("role") or ""),
                        "company": str(role.get("company") or ""),
                        "location": str(role.get("location") or ""),
                        "duration": str(role.get("duration") or role.get("period") or ""),
                        "overview": str(role.get("overview") or ""),
                        "bullets": bullets,
                    }
                )
            normalized_sections.append({"type": "experience", "title": title, "items": normalized_exp})
            continue

        if sec_type == "skills":
            if isinstance(items, list):
                skills_items = items
            elif isinstance(content, dict):
                skills_items = []
                for key, values in content.items():
                    if isinstance(values, list):
                        category = str(key).replace("_", " ").title()
                        skills_items.append({"category": category, "values": [str(v) for v in values if str(v).strip()]})
            else:
                skills_items = []
            normalized_sections.append({"type": "skills", "title": title, "items": skills_items})
            continue

        if sec_type == "education":
            source_items = items if isinstance(items, list) else content if isinstance(content, list) else []
            edu_items: list[dict[str, Any]] = []
            for edu in source_items:
                if not isinstance(edu, dict):
                    continue
                edu_items.append(
                    {
                        "degree": str(edu.get("degree") or ""),
                        "school": str(edu.get("school") or ""),
                        "grade": str(edu.get("grade") or  ""),
                        "field": str(edu.get("field") or  ""),
                        "duration": str(edu.get("duration") or  ""),
                    }
                )
            normalized_sections.append({"type": "education", "title": title, "items": edu_items})
            continue

        # Pass-through unknown section types.
        normalized_sections.append({"type": sec_type or "section", "title": title, "items": items if isinstance(items, list) else []})

    normalized_root = {"header": header, "sections": normalized_sections}
    return {"optimized_resume": normalized_root}


def _clean_string(value: str) -> str:
    return " ".join(str(value or "").replace("\r", " ").replace("\n", " ").split()).strip()


def _sanitize_filename_segment(value: str, *, max_len: int = 88) -> str:
    raw = _clean_string(str(value or ""))
    raw = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", raw)
    raw = re.sub(r"\s+", " ", raw).strip()
    if not raw:
        return ""
    return raw[:max_len]


def _candidate_name_from_session(session: dict[str, Any]) -> str:
    rj = session.get("gpt_resume_json")
    if isinstance(rj, dict):
        header = rj.get("header") if isinstance(rj.get("header"), dict) else {}
        name = str(header.get("name") or "").strip()
        if name:
            return name
    extracted = session.get("extracted_resume")
    if isinstance(extracted, dict):
        extracted_name = str(extracted.get("name") or "").strip()
        if extracted_name:
            return extracted_name
    resume_text = str(session.get("resume_text") or "").strip()
    if resume_text:
        first = resume_text.splitlines()[0].strip()
        if first and len(first) <= 120:
            return first
    return "Resume"


def _download_docx_filename(session: dict[str, Any]) -> str:
    name_part = _sanitize_filename_segment(_candidate_name_from_session(session)) or "Resume"
    role_part = _sanitize_filename_segment(str(session.get("company_role") or ""))
    if not role_part:
        raise HTTPException(
            status_code=400,
            detail="Company / role missing. Select the company and role text on any page and click the second floating button (sends to /com-role).",
        )
    return f"{name_part}({role_part}).docx"


def _sanitize_json_strings(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _sanitize_json_strings(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_sanitize_json_strings(item) for item in value]
    if isinstance(value, str):
        return _clean_string(value)
    return value


@app.post("/jd")
async def store_job_description(request: Request):
    key, session = _require_session(request)
    _log_user_request(request, "store_job_description", key)
    jd = await _read_text_request(request)
    if not jd:
        raise HTTPException(status_code=400, detail="Job description is empty")
    session["job_description"] = jd
    return {"stored": True}


@app.post("/com-role")
async def store_company_role(request: Request):
    key, session = _require_session(request)
    _log_user_request(request, "store_company_role", key)
    text = await _read_text_request(request)
    if not text:
        raise HTTPException(status_code=400, detail="Company / role text is empty")
    session["company_role"] = text
    return {"stored": True}


@app.post("/resume")
async def store_resume(
    request: Request,
    resume_file: UploadFile = File(...),
    user_id: str | None = Form(default=None),
):
    key, session = _require_session(request, form_user_id=user_id)
    _log_user_request(request, "store_resume", key)
    data = await resume_file.read()
    text = await run_in_threadpool(extract_text, data, resume_file.filename or "resume.txt")
    extracted_resume = _sanitize_json_strings(extract_resume_facts(text))
    session["resume_filename"] = resume_file.filename or "resume.txt"
    session["resume_text"] = text
    session["extracted_resume"] = extracted_resume
    session["gpt_result_raw"] = ""
    session["gpt_resume_json"] = None
    session["gpt_extracted_facts"] = None
    return {
        "stored": True,
        "filename": session["resume_filename"],
        "text": text,
        "extracted_resume": extracted_resume,
    }


@app.post("/chatgpt-prompt")
async def chatgpt_prompt(request: Request):
    key, session = _require_session(request)
    _log_user_request(request, "chatgpt_prompt", key)
    jd = str(session.get("job_description") or "").strip()
    resume_text = str(session.get("resume_text") or "").strip()
    prompt_template = await _read_text_request(request)
    if not jd:
        raise HTTPException(status_code=400, detail="Job description is empty")
    if not resume_text:
        raise HTTPException(status_code=400, detail="Resume is empty")
    facts = session.get("extracted_resume")
    if not isinstance(facts, dict):
        facts = _sanitize_json_strings(extract_resume_facts(resume_text))
        session["extracted_resume"] = facts
    try:
        facts_json = json.dumps(facts, ensure_ascii=False, indent=2)
    except (TypeError, ValueError):
        facts_json = "{}"
    prompt = _render_prompt_template(prompt_template, jd, resume_text, facts_json=facts_json)
    return {"prompt": prompt, "stage": "optimized_resume_single_loop"}


@app.post("/gpt-result")
async def store_gpt_result(request: Request):
    key, session = _require_session(request)
    _log_user_request(request, "store_gpt_result", key)
    value = await _read_text_request(request)
    if not value:
        raise HTTPException(status_code=400, detail="GPT result is empty")

    # print("GPT result:", value)
    session["gpt_result_raw"] = value
    session["gpt_resume_json"] = None
    maybe_json = _extract_json_object(value)
    if isinstance(maybe_json, dict):
        maybe_json = _sanitize_json_strings(maybe_json)
        if _looks_like_optimized_resume(maybe_json):
            normalized = _normalize_optimized_resume_payload(maybe_json)
            session["gpt_resume_json"] = normalized["optimized_resume"]
            return {"stored": True, "stage": "optimized_resume"}
        if _looks_like_extracted_resume_facts(maybe_json):
            session["gpt_extracted_facts"] = maybe_json
            raise HTTPException(
                status_code=400,
                detail="Received extracted_resume_facts JSON, but /gpt-result requires optimized_resume JSON for download.",
            )

    session["gpt_result_raw"] = ""
    session["gpt_resume_json"] = None
    debug_keys = list(maybe_json.keys())[:12] if isinstance(maybe_json, dict) else []
    raise HTTPException(
        status_code=400,
        detail={
            "message": "Unrecognized GPT JSON shape. Send one JSON object with top-level optimized_resume.",
            "detected_keys": debug_keys,
        },
    )


@app.get("/download")
async def download_current_resume(request: Request, format: str = "docx"):
    key, session = _require_session(request)
    _log_user_request(request, "download_current_resume", key)
    _require_gpt_result_before_download(session)
    resume_json = _resume_json_for_download(session)
    payload = {"optimized_resume": resume_json}
    normalized_format = str(format).lower()
    if normalized_format not in ("docx", "pdf"):
        raise HTTPException(status_code=400, detail="Only pdf and docx formats are supported")

    display_name = _download_docx_filename(session)
    pdf_basename = display_name[:-5] + ".pdf" if display_name.lower().endswith(".docx") else f"{display_name}.pdf"

    if normalized_format == "pdf":
        docx_fd, docx_path = tempfile.mkstemp(suffix=".docx")
        os.close(docx_fd)
        await run_in_threadpool(export_to_docx, payload, docx_path)

        pdf_fd, pdf_path = tempfile.mkstemp(suffix=".pdf")
        os.close(pdf_fd)
        await run_in_threadpool(_convert_docx_to_pdf, docx_path, pdf_path)
        return FileResponse(
            path=pdf_path,
            filename=pdf_basename,
            media_type="application/pdf",
        )

    fd, output_path = tempfile.mkstemp(suffix=".docx")
    os.close(fd)
    await run_in_threadpool(export_to_docx, payload, output_path)
    return FileResponse(
        path=output_path,
        filename=display_name,
        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    )


@app.post("/download/save")
async def save_resume_to_absolute_path(request: Request):
    key, session = _require_session(request)
    _log_user_request(request, "save_resume_to_absolute_path", key)
    _require_gpt_result_before_download(session)
    try:
        payload = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid JSON body") from exc
    raw_path = str((payload or {}).get("path") or "").strip()
    if not raw_path:
        raise HTTPException(status_code=400, detail="Path is required")

    resume_json = _resume_json_for_download(session)
    docx_payload = {"optimized_resume": resume_json}
    display_name = _download_docx_filename(session)
    output_path = _normalize_save_target_path(raw_path, display_name)

    await run_in_threadpool(export_to_docx, docx_payload, str(output_path))
    return {"saved": True, "path": str(output_path)}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
