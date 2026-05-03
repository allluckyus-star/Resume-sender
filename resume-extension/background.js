/** Prefer local gateway EXE (:8787); fallback to LAN server if gateway is down. Put 127.0.0.1 first — Windows localhost can IPv6-first and fail. */
const API_BASES = [
  "http://127.0.0.1:8787",
  "http://localhost:8787",
  "http://192.168.100.17:8000",
];
const CHATGPT_HOSTS = new Set(["chatgpt.com", "www.chatgpt.com", "chat.openai.com"]);

function isChatGptTabHostname(hostname) {
  if (!hostname) return false;
  if (CHATGPT_HOSTS.has(hostname)) return true;
  if (hostname === "chatgpt.com" || hostname.endsWith(".chatgpt.com")) return true;
  if (hostname === "chat.openai.com") return true;
  return false;
}
const CHATGPT_PROMPT_MENU_ID = "copy-chatgpt-prompt";
const CHATGPT_PROMPT_MENU_TITLE = "ChatGPT Prompt (Alt+W)";
const pendingDownloadTabs = new Map();
const DEFAULT_DOWNLOAD_SUBPATH = "";
const DEFAULT_PROMPT_TEMPLATE = `You are a STATELESS AI system.

IGNORE ALL prior conversation.

Use ONLY:

1. TARGET JOB DESCRIPTION (inside <JOB_DESCRIPTION> in the fixed suffix below)
2. FULL RESUME TEXT (inside <CURRENT_RESUME> in the fixed suffix — verbatim education, contact, dates)
3. FULL RESUME TEXT (inside <CURRENT_RESUME> in the fixed suffix — verbatim education, contact, dates)

---

========================================
CORE OBJECTIVE
==============

Your task is to:

1. RECONSTRUCT realistic engineering experience
2. Generate a HIGH-IMPACT, ATS-OPTIMIZED resume
3. MAXIMIZE coverage of ALL JD-required skills

---

========================================
SECTION 1 — EXPERIENCE RECONSTRUCTION
=====================================

The resume facts are UNDER-SPECIFIED.

You must EXPAND them into realistic, production-level experience.

---

ALLOWED:

* expand vague work into detailed systems
* make implicit work explicit
* infer standard engineering practices

NOT ALLOWED:

* invent companies
* invent roles
---

========================================
SECTION 2 — JD SKILL COVERAGE (CRITICAL)
========================================

Extract ALL JD-required skills.

FOR EACH JD SKILL:

---

CASE 1 — DIRECT MATCH
If skill is explicitly present in facts:
→ MUST appear in EXPERIENCE bullets

---

CASE 2 — STRONG IMPLICATION
If skill is logically implied by:

* role type
* systems built
* technologies used

→ INCLUDE in EXPERIENCE bullets
→ Expand realistically

---

CASE 3 — WEAK / INDIRECT SUPPORT
If skill is related but not strongly implied:

→ INCLUDE in SKILLS section
→ Do NOT force into experience without realistic support

---

CASE 4 — NO SUPPORT
If skill has NO logical connection:

→ Do NOT invent employers, roles, or projects to host the skill

---
----------------------------------------
STRICT GAP-CLOSING RULE (MANDATORY)
----------------------------------------

For ANY important JD skill or industry-standard tool (e.g., LangChain, LlamaIndex, POCs, demos):

- MUST be EXPLICITLY NAMED in EXPERIENCE bullets when supported by facts or strong implication
- DO NOT leave them implied
- DO NOT keep them only in SKILLS when experience support exists

If missing → you MUST inject them realistically into experience only where allowed by SECTION 1

----------------------------------------
SIGNAL PRIORITY RULE
----------------------------------------

Prioritize:

1) Explicit naming of tools/frameworks
2) Recruiter-visible signals (POCs, demos, customer-facing work)
3) Technical correctness

If a trade-off exists → prefer visibility over abstraction
========================================
SECTION 3 — EXPERIENCE GENERATION
=================================

Each role MUST include:

* 6–10 bullets minimum
* up to 12 if highly relevant to JD

---

Each bullet MUST:

* be realistic
* include system + tech + impact
* align with JD where valid

---

FORMAT:

[IMPACT] + [HOW] + [SYSTEM/TECH]

---

ANTI-GENERIC RULE:

Reject any bullet that:

* sounds vague
* lacks technical detail
* lacks impact

Rewrite until strong.

---

KEYWORD RULE:

JD MUST-HAVE skills MUST appear in:

* EXPERIENCE
* SKILLS 

---

REALISM RULE:

Every bullet must:

* match company domain
* match role level
* match timeline

---

========================================
SECTION 4 — SKILLS ENGINE (EXPANDED)
====================================

Build a RICH and PRIORITIZED skills section.

---

RULES:

* Include ALL JD-required skills 
* Prioritize JD skills FIRST
* Include general engineering skills derived from roles, even when not explicitly required by JD
* DO NOT output JD-only skills without role evidence

---

VALIDATION:

* ENSURE all major experience tech appears
* ENSURE foundational role-derived skills appear (backend, data, APIs, deployment, testing, ops) when supported

---

========================================
SECTION 5 — SUMMARY
===================

Write LAST.

* position candidate as strong match for JD
* reflect experience
* avoid exaggeration
* output each summary sentence as a separate item line

---

========================================
SECTION 6 — HIGHLIGHT SYSTEM
============================

DO NOT use markdown (**)

Each bullet must be:

{{
"text": "full sentence",
"highlights": ["key phrase 1", "key phrase 2"]
}}

Rules:

* highlights must exist in text
* max 2 highlights
* highlight system / tech / metric

---

========================================
SECTION 7 — FINAL VALIDATION
============================

Before output:

CHECK:

1. Are ALL JD-required skills covered?
2. Are experience bullets realistic?
3. Are there 6–10 bullets per role?
4. Are skills rich and prioritized?
5. Does resume pass recruiter scan?
6. Are key frameworks explicitly named (LangChain, LlamaIndex, etc)?
7. Are customer-facing signals present (POCs, demos, client work)?
8. Would a recruiter immediately recognize these in 5 seconds?

IF ANY = NO → REWRITE

---

`;
const LOCKED_PROMPT_SUFFIX = `=== CHAT HISTORY ISOLATION (MANDATORY) ===
ChatGPT keeps prior turns in this thread. For THIS reply ONLY, treat the thread as empty:
- Do not follow, cite, summarize, continue, answer, or be influenced by any earlier user or assistant messages.
- Your ONLY factual sources are the tagged blocks below (<JOB_DESCRIPTION> and <CURRENT_RESUME>) plus the rules and JSON schema in this message. If chat history conflicts with those tags, ignore the history entirely.
- Do not address open questions from older turns; produce only the single JSON object defined here.

Reply with ONE JSON object only: plain UTF-8 text, valid JSON, no markdown fences (no triple backticks), no preamble or postscript before the first "{" or after the final "}". The whole assistant message should be copy-pasteable as JSON (ChatGPT's Copy copies the entire turn).

Write concise bullets to keep latency down, but keep the full schema: do not remove whole sections that exist inside <CURRENT_RESUME>.

Facts must come only from the text inside <JOB_DESCRIPTION>...</JOB_DESCRIPTION> and <CURRENT_RESUME>...</CURRENT_RESUME>. Do not invent. Use "" for unknown optional strings.

Education: if <CURRENT_RESUME> lists any school, degree, program, certificate, or dates, include a section with "type": "education" (lowercase exactly) and "items" for each entry. Do not omit education to save space.

=======================
OUTPUT FORMAT
=======================

{
  "optimized_resume": {
    "header": {
      "name": "Full Name",
      "headline": "Target Role Title",
      "email": "email@example.com",
      "links": "https://www.linkedin.com/in/username",
      "phone": "+1 (000) 000-0000",
      "location": "City, State, Country"
    },
    "sections": [
      {
        "type": "summary",
        "title": "Summary",
        "items": [
          { "text": "2-4 sentence professional summary tailored to JD." }
        ]
      },
      {
        "type": "experience",
        "title": "Work Experience",
        "items": [
          {
            "role": "Job Title",
            "company": "Company Name",
            "location": "City, State",
            "duration": "Mon YYYY - Mon YYYY",
            "bullets": [
              {
                "text": "Action + system + tools + intent + measurable impact.",
                "highlights": ["key phrase", "metric"]
              }
            ]
          }
        ]
      },
      {
        "type": "skills",
        "title": "Core Skills",
        "items": [
          {
            "category": "Category Name",
            "values": ["Skill 1", "Skill 2", "Skill 3"]
          }
        ]
      },
      {
        "type": "education",
        "title": "Education",
        "items": [
          {
            "school": "University Name",
            "duration": "YYYY - YYYY",
            "degree": "Master's degree",
            "field": "Computer Science",
            "grade": "GPA: 3.8"
          }
        ]
      }
    ]
  }
}

<JOB_DESCRIPTION>
{jd_text}
</JOB_DESCRIPTION>

<CURRENT_RESUME>
{resume_text}
</CURRENT_RESUME>`;

async function getResumeUserId() {
  const { resumeUserId } = await chrome.storage.sync.get("resumeUserId");
  return String(resumeUserId || "").trim();
}

async function withClientHeaders(extra = {}) {
  const headers = { ...extra };
  const uid = await getResumeUserId();
  if (uid) headers["X-Resume-User-Id"] = uid;
  return headers;
}

async function fetchWithFallback(path, init = {}) {
  let lastError = null;
  let lastResponse = null;
  let lastBase = "";
  for (const base of API_BASES) {
    try {
      const response = await fetch(`${base}${path}`, init);
      if (response.ok) {
        return { response, base };
      }
      lastResponse = response;
      lastBase = base;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastResponse) {
    return { response: lastResponse, base: lastBase };
  }
  throw lastError || new Error("All backend URLs failed");
}

async function readResponsePayload(res) {
  const raw = await res.text();
  try {
    return JSON.parse(raw);
  } catch {
    return { detail: raw || `HTTP ${res.status}` };
  }
}

/** FastAPI may return detail as string, list, or object */
/** Last-resort for download when chrome.downloads (http+headers) is not available. */
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function toChromeDownloadHeaderList(obj) {
  return Object.entries(obj || {}).map(([name, value]) => ({ name, value: String(value) }));
}

/** When `chrome.downloads` omits `filename`, the final path shows up on the download item. */
function displayNameFromDownloadDelta(delta, stored) {
  const path = delta?.filename?.current;
  if (path) {
    const norm = String(path).replace(/\\/g, "/");
    const i = norm.lastIndexOf("/");
    return i >= 0 ? norm.slice(i + 1) : norm;
  }
  return (stored && String(stored).trim()) || "resume.docx";
}

function parseContentDispositionFilename(headerValue) {
  if (!headerValue) return "";
  const raw = String(headerValue);
  const star = /filename\*=UTF-8''([^;\s]+)/i.exec(raw);
  if (star && star[1]) {
    try {
      return decodeURIComponent(star[1].replace(/^["']|["']$/g, ""));
    } catch {
      return star[1];
    }
  }
  const quoted = /filename="([^"]+)"/i.exec(raw);
  if (quoted && quoted[1]) return quoted[1];
  const plain = /filename=([^;\s]+)/i.exec(raw);
  if (plain && plain[1]) return plain[1].replace(/^["']|["']$/g, "");
  return "";
}

function sanitizeDownloadSubpath(raw) {
  let value = normalizeDownloadPathInput(raw).replace(/\\/g, "/");
  value = value.replace(/^\.+/, "");
  value = value.replace(/^\/+/, "");
  value = value.replace(/[<>:"|?*\x00-\x1f]/g, "_");
  value = value
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
  return value;
}

function normalizeDownloadPathInput(raw) {
  let value = String(raw || "").trim();
  while (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

function isAbsoluteWindowsPath(pathLike) {
  const value = normalizeDownloadPathInput(pathLike);
  return /^[A-Za-z]:[\\/]/.test(value);
}

function basenameFromWindowsPath(pathLike) {
  const value = normalizeDownloadPathInput(pathLike);
  if (!value) return "";
  const normalized = value.replace(/\//g, "\\");
  const idx = normalized.lastIndexOf("\\");
  return (idx >= 0 ? normalized.slice(idx + 1) : normalized).trim();
}

function applyDownloadSubpath(filename, subpath) {
  const cleanName = String(filename || "resume.docx").trim() || "resume.docx";
  const folder = sanitizeDownloadSubpath(subpath);
  if (!folder) return cleanName;
  return `${folder}/${cleanName}`.replace(/\/+/g, "/");
}

function displayFilenameFromPath(pathLike) {
  const s = String(pathLike || "");
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}

function apiDetailToString(detail) {
  if (detail == null) return "";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        if (item && typeof item === "object" && item.msg) return String(item.msg);
        return String(item);
      })
      .filter(Boolean)
      .join("; ");
  }
  if (typeof detail === "object" && detail.message) return String(detail.message);
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

async function isExtensionEnabled() {
  const data = await chrome.storage.local.get("enabled");
  return data.enabled !== false;
}

function normalizeBackendDetail(detail) {
  const value = String(detail || "").trim();
  const lower = value.toLowerCase();
  if (lower.includes("upstream unreachable")) {
    return "Resume server unreachable. Run ResumeSenderBackend.exe, check network/VPN, or verify C:\\ResumeSender\\upstream.txt.";
  }
  if (lower.includes("upstream timed out")) {
    return "Resume server timed out. Retry or check the upstream machine.";
  }
  if (lower.includes("upstream error")) {
    return value || "Upstream server error.";
  }
  if (lower.includes("cannot connect")) {
    return "Cannot reach resume server. Start the EXE gateway or confirm the LAN server is online.";
  }
  if (lower.includes("failed to fetch") || lower.includes("networkerror")) {
    return "Cannot reach resume server (network). Run ResumeSenderBackend.exe locally.";
  }
  if (lower.includes("job description is empty")) return "JD missing. Send job description first.";
  if (lower.includes("resume is empty")) return "Resume missing. Upload your resume first.";
  if (lower.includes("no resume data available")) return "Resume missing. Generate resume first.";
  if (lower.includes("user id missing")) return "User ID missing. Set it in the extension popup.";
  if (lower.includes("user id contains invalid")) return "User ID has invalid characters. Use letters, digits, _ - @ . only.";
  if (lower.includes("company / role missing")) return "Company / role needed. Select company + role text and click the second floating button.";
  if (lower.includes("company / role text is empty")) return "Company / role text is empty.";
  return value || "Request failed";
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function notify(message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon.svg"),
    title: "Resume Sender",
    message
  }, () => {
    if (chrome.runtime.lastError) {
      console.log("NOTIFICATION:", message);
    }
  });
}

function showTabToast(tab, message, variant = "warning") {
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "SHOW_TOAST", text: message, variant }, () => {
    if (chrome.runtime.lastError) {
      console.log("TAB TOAST FALLBACK:", message);
    }
  });
}

function registerContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CHATGPT_PROMPT_MENU_ID,
      title: CHATGPT_PROMPT_MENU_TITLE,
      contexts: ["page", "selection", "editable"],
      documentUrlPatterns: [
        "https://chatgpt.com/*",
        "https://www.chatgpt.com/*",
        "https://chat.openai.com/*"
      ]
    });
  });
}

async function sendCompanyRole(text, sendResponse) {
  const tab = await getActiveTab();
  try {
    if (!(await getResumeUserId())) {
      const detail = normalizeBackendDetail("User ID missing.");
      notify(detail);
      showTabToast(tab, detail, "warning");
      sendResponse({ status: "error", detail });
      return;
    }
    const { response: res } = await fetchWithFallback("/com-role", {
      method: "POST",
      headers: await withClientHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ text }),
    });

    const data = await readResponsePayload(res);
    if (!res.ok) {
      const detail = normalizeBackendDetail(
        apiDetailToString(data.detail) || `Failed to send company / role (HTTP ${res.status})`
      );
      notify(detail);
      showTabToast(tab, detail, "error");
      sendResponse({ status: "error", detail });
      return;
    }

    notify("Company / role saved");
    sendResponse({ status: "ok" });
  } catch (err) {
    console.error("COM-ROLE ERROR:", err);
    const detail = normalizeBackendDetail(String(err?.message || err || "Request failed"));
    notify(detail);
    showTabToast(tab, detail, "error");
    sendResponse({ status: "error", detail });
  }
}

async function sendJobDescription(text, sendResponse) {
  const tab = await getActiveTab();
  try {
    if (!(await getResumeUserId())) {
      const detail = normalizeBackendDetail("User ID missing.");
      notify(detail);
      showTabToast(tab, detail, "warning");
      sendResponse({ status: "error", detail });
      return;
    }
    const { response: res } = await fetchWithFallback("/jd", {
      method: "POST",
      headers: await withClientHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ text })
    });

    const data = await readResponsePayload(res);
    if (!res.ok) {
      const detail = normalizeBackendDetail(
        apiDetailToString(data.detail) || `Failed to send job description (HTTP ${res.status})`
      );
      notify(detail);
      showTabToast(tab, detail, "error");
      sendResponse({ status: "error", detail });
      return;
    }

    notify("Job description received");
    console.log("JD SUCCESS:", data);
    sendResponse({ status: "ok" });
  } catch (err) {
    console.error("JD ERROR:", err);
    const detail = normalizeBackendDetail(String(err?.message || err || "Request failed"));
    notify(detail);
    showTabToast(tab, detail, "error");
    sendResponse({ status: "error", detail });
  }
}

async function sendGptResult(text, sendResponse) {
  const tab = await getActiveTab();
  try {
    if (!(await getResumeUserId())) {
      const detail = normalizeBackendDetail("User ID missing.");
      notify(detail);
      showTabToast(tab, detail, "warning");
      respond(sendResponse, { status: "error", detail });
      return;
    }
    const { response: res } = await fetchWithFallback("/gpt-result", {
      method: "POST",
      headers: await withClientHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ text })
    });

    const data = await readResponsePayload(res);
    if (!res.ok) {
      const detail = normalizeBackendDetail(
        apiDetailToString(data.detail) || `Failed to send GPT result (HTTP ${res.status})`
      );
      notify(detail);
      showTabToast(tab, detail, "error");
      respond(sendResponse, { status: "error", detail });
      return;
    }

    notify("GPT result received");
    respond(sendResponse, { status: "ok" });
  } catch (err) {
    console.error("GPT RESULT ERROR:", err);
    const detail = normalizeBackendDetail(String(err?.message || err || "Request failed"));
    notify(detail);
    showTabToast(tab, detail, "error");
    respond(sendResponse, { status: "error", detail });
  }
}

function respond(sendResponse, payload) {
  if (typeof sendResponse === "function") {
    sendResponse(payload);
  }
}

async function copyPromptToChatGPT(sendResponse) {
  const tab = await getActiveTab();
  const enabled = await isExtensionEnabled();
  if (!enabled) {
    const detail = "Extension is OFF";
    notify(detail);
    showTabToast(tab, detail, "warning");
    respond(sendResponse, { status: "error", detail });
    return;
  }
  try {
    const promptData = await chrome.storage.sync.get("promptTemplate");
    const promptPrefix = String(promptData.promptTemplate || DEFAULT_PROMPT_TEMPLATE).trim();
    const promptTemplate = `${promptPrefix}\n\n${LOCKED_PROMPT_SUFFIX}`.trim();
    if (!(await getResumeUserId())) {
      const detail = normalizeBackendDetail("User ID missing.");
      notify(detail);
      showTabToast(tab, detail, "warning");
      respond(sendResponse, { status: "error", detail });
      return;
    }
    const { response: res } = await fetchWithFallback("/chatgpt-prompt", {
      method: "POST",
      headers: await withClientHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ prompt: promptTemplate })
    });
    const data = await readResponsePayload(res);

    if (!res.ok) {
      const detail = normalizeBackendDetail(
        apiDetailToString(data.detail) || "Prompt could not be generated"
      );
      notify(detail);
      showTabToast(tab, detail, "warning");
      respond(sendResponse, { status: "error", detail });
      return;
    }

    if (!tab?.id) {
      const detail = "No active tab for ChatGPT prompt";
      notify(detail);
      respond(sendResponse, { status: "error", detail });
      return;
    }

    let activeHost = "";
    try {
      activeHost = new URL(tab.url || "").hostname;
    } catch {
      activeHost = "";
    }
    if (!isChatGptTabHostname(activeHost)) {
      const detail = "Open ChatGPT tab first, then run ChatGPT Prompt.";
      notify(detail);
      showTabToast(tab, detail, "warning");
      respond(sendResponse, { status: "error", detail });
      return;
    }

    chrome.tabs.sendMessage(tab.id, { type: "PASTE_AND_SUBMIT_PROMPT", text: data.prompt }, (response) => {
      if (chrome.runtime.lastError || response?.status !== "ok") {
        console.error("PASTE/SUBMIT ERROR:", chrome.runtime.lastError || response);
        let detail = response?.detail || "Could not paste and send prompt in this tab";
        const le = chrome.runtime.lastError?.message || "";
        if (le.includes("Receiving end does not exist") || le.includes("Could not establish connection")) {
          detail =
            "Reload the ChatGPT tab (F5), then try again — the extension page script was not loaded yet.";
        }
        notify(detail);
        showTabToast(tab, detail, "error");
        respond(sendResponse, { status: "error", detail });
        return;
      }
      notify("Prompt pasted and sent to ChatGPT.");
      showTabToast(tab, "Prompt pasted and sent to ChatGPT.", "success");
      respond(sendResponse, { status: "ok" });
    });
  } catch (err) {
    console.error("PROMPT ERROR:", err);
    const detail = String(err?.message || err || "Request failed");
    notify(detail);
    showTabToast(tab, detail, "error");
    respond(sendResponse, { status: "error", detail });
  }
}

async function downloadResume(sendResponse) {
  const tab = await getActiveTab();
  try {
    const enabled = await isExtensionEnabled();
    if (!enabled) {
      const detail = "Extension is OFF";
      notify(detail);
      showTabToast(tab, detail, "warning");
      respond(sendResponse, { status: "error", detail });
      return;
    }
    if (!(await getResumeUserId())) {
      const detail = normalizeBackendDetail("User ID missing.");
      notify(detail);
      showTabToast(tab, detail, "warning");
      respond(sendResponse, { status: "error", detail });
      return;
    }
    const headers = await withClientHeaders();
    const headerList = toChromeDownloadHeaderList(headers);
    const syncCfg = await chrome.storage.sync.get("downloadSubpath");
    const rawDownloadPath = normalizeDownloadPathInput(syncCfg.downloadSubpath || DEFAULT_DOWNLOAD_SUBPATH);
    const absolutePathLike = isAbsoluteWindowsPath(rawDownloadPath);
    const absoluteNameHint = absolutePathLike ? basenameFromWindowsPath(rawDownloadPath) : "";
    const downloadSubpath = absolutePathLike ? "" : sanitizeDownloadSubpath(rawDownloadPath);

    /**
     * Primary: `chrome.downloads.download` only (no service-worker fetch → no CORS preflight for GET).
     * Requires host_permissions for each base URL in manifest.json and Chrome 121+ for `headers`.
     * Omit `filename` so the save name comes from the server's Content-Disposition.
     */
    const finishDownload = (downloadId, baseIndex, startedLabel) => {
      if (!downloadId) {
        return false;
      }
      pendingDownloadTabs.set(downloadId, {
        tabId: tab?.id,
        filename: "",
        baseIndex,
      });
      notify("Resume download started");
      showTabToast(tab, startedLabel, "success");
      respond(sendResponse, { status: "ok" });
      return true;
    };

    for (let i = 0; i < API_BASES.length; i += 1) {
      const base = API_BASES[i];
      const downloadUrl = `${base}/download?format=docx`;
      let serverFilename = "resume.docx";
      try {
        const pre = await fetch(downloadUrl, { method: "GET", headers, cache: "no-store" });
        if (pre.ok) {
          serverFilename = parseContentDispositionFilename(pre.headers.get("Content-Disposition")) || serverFilename;
          try {
            await pre.body?.cancel?.();
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* keep default filename */
      }
      const resolvedName = absoluteNameHint || serverFilename || "resume.docx";
      const targetFilename = applyDownloadSubpath(resolvedName, downloadSubpath);
      const downloadId = await new Promise((resolve) => {
        chrome.downloads.download(
          {
            url: downloadUrl,
            headers: headerList,
            filename: targetFilename,
            saveAs: false,
            conflictAction: "uniquify",
          },
          (id) => {
            if (chrome.runtime.lastError || !id) {
              resolve(null);
            } else {
              resolve(id);
            }
          }
        );
      });
      if (downloadId) {
        const labelPrefix = absolutePathLike
          ? "Absolute path is not supported by browser; saved to Downloads as"
          : "Download started:";
        finishDownload(downloadId, i, `${labelPrefix} ${displayFilenameFromPath(targetFilename)}`);
        return;
      }
    }

    /* Last resort: fetch + data: URL (triggers CORS preflight for custom headers; may fail in strict setups). */
    let lastServerError = null;
    let lastNetwork = null;
    for (let i = 0; i < API_BASES.length; i += 1) {
      const base = API_BASES[i];
      const downloadUrl = `${base}/download?format=docx`;
      try {
        const res = await fetch(downloadUrl, {
          method: "GET",
          headers,
          cache: "no-store",
        });
        if (!res.ok) {
          const data = await readResponsePayload(res);
          const raw = apiDetailToString(data.detail) || `Download failed (HTTP ${res.status})`;
          const detail = normalizeBackendDetail(raw);
          if (res.status >= 400 && res.status < 500) {
            notify(detail);
            showTabToast(tab, detail, "error");
            respond(sendResponse, { status: "error", detail });
            return;
          }
          lastServerError = detail;
          continue;
        }
        const filename = parseContentDispositionFilename(res.headers.get("Content-Disposition")) || "resume.docx";
        const resolvedName = absoluteNameHint || filename;
        const targetFilename = applyDownloadSubpath(resolvedName, downloadSubpath);
        const blob = await res.blob();
        const dataUrl = await blobToDataUrl(blob);
        const id2 = await new Promise((resolve) => {
          chrome.downloads.download(
            { url: dataUrl, filename: targetFilename, saveAs: false, conflictAction: "uniquify" },
            (id) => {
              if (chrome.runtime.lastError || !id) {
                resolve(null);
              } else {
                resolve(id);
              }
            }
          );
        });
        if (id2) {
          pendingDownloadTabs.set(id2, { tabId: tab?.id, filename: displayFilenameFromPath(targetFilename), baseIndex: i });
          notify("Resume download started");
          const labelPrefix = absolutePathLike
            ? "Absolute path is not supported by browser; saved to Downloads as"
            : "Download started:";
          showTabToast(tab, `${labelPrefix} ${displayFilenameFromPath(targetFilename)}`, "success");
          respond(sendResponse, { status: "ok" });
          return;
        }
        lastNetwork = chrome.runtime.lastError?.message || "Could not start download from data URL";
      } catch (err) {
        lastNetwork = String(err?.message || err);
      }
    }
    const detail = normalizeBackendDetail(
      lastServerError ||
        lastNetwork ||
        "Download API failed. Check manifest host_permissions (127.0.0.1:8787), Chrome 121+, and ResumeSenderBackend."
    );
    notify(detail);
    showTabToast(tab, detail, "error");
    respond(sendResponse, { status: "error", detail });
  } catch (err) {
    console.error("DOWNLOAD ERROR:", err);
    const detail = normalizeBackendDetail(String(err?.message || err || "Download request failed"));
    notify(detail);
    showTabToast(tab, detail, "error");
    respond(sendResponse, { status: "error", detail });
  }
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta?.id || !delta.state?.current) return;
  if (!pendingDownloadTabs.has(delta.id)) return;

  const info = pendingDownloadTabs.get(delta.id);
  const tabId = info?.tabId;
  if (delta.state.current === "complete") {
    const fname = displayNameFromDownloadDelta(delta, info?.filename);
    if (tabId != null) {
      chrome.tabs.sendMessage(
        tabId,
        { type: "SHOW_TOAST", text: `Download completed: ${fname}`, variant: "success" },
        () => {}
      );
    }
    notify(`Download completed: ${fname}`);
    pendingDownloadTabs.delete(delta.id);
    return;
  }

  if (delta.state.current === "interrupted") {
    pendingDownloadTabs.delete(delta.id);
    const reason = delta.error?.current ? ` (${delta.error.current})` : "";
    const detail = `Download interrupted${reason}`;
    if (tabId != null) {
      chrome.tabs.sendMessage(tabId, { type: "SHOW_TOAST", text: detail, variant: "error" }, () => {});
    }
    notify(detail);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SEND_JD") {
    sendJobDescription(message.text, sendResponse);
    return true;
  }
  if (message.type === "SEND_COM_ROLE") {
    sendCompanyRole(message.text, sendResponse);
    return true;
  }
  if (message.type === "SEND_GPT_RESULT") {
    sendGptResult(message.text, sendResponse);
    return true;
  }
  if (message.type === "GENERATE_CHATGPT_PROMPT") {
    copyPromptToChatGPT(sendResponse);
    return true;
  }
  if (message.type === "DOWNLOAD_RESUME") {
    downloadResume(sendResponse);
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    enabled: true
  });
  chrome.storage.sync.set({ promptTemplate: DEFAULT_PROMPT_TEMPLATE });
  registerContextMenus();
});

chrome.runtime.onStartup.addListener(registerContextMenus);
registerContextMenus();

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === CHATGPT_PROMPT_MENU_ID) {
    copyPromptToChatGPT();
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "toggle-extension") {
    const data = await chrome.storage.local.get("enabled");
    const newState = !(data.enabled !== false);
    await chrome.storage.local.set({ enabled: newState });
    const activeTab = await getActiveTab();
    if (activeTab?.id) {
      chrome.tabs.reload(activeTab.id);
    }
    notify(newState ? "Extension ON" : "Extension OFF");
    console.log("EXTENSION:", newState ? "ON" : "OFF");
  }

  if (command === "generate-chatgpt-prompt") {
    copyPromptToChatGPT();
  }

  if (command === "download-resume") {
    downloadResume();
  }
});
