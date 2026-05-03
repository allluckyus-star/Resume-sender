const toggleBtn = document.getElementById("toggle");
const editPromptBtn = document.getElementById("editPrompt");
const promptBtn = document.getElementById("prompt");
const downloadBtn = document.getElementById("download");
const statusBox = document.getElementById("status");
const hint = document.getElementById("hint");
const toggleTitle = toggleBtn.querySelector(".button-title");
const promptTitle = promptBtn.querySelector(".button-title");
const downloadTitle = downloadBtn.querySelector(".button-title");
const promptEditor = document.getElementById("promptEditor");
const promptLocked = document.getElementById("promptLocked");
const userIdInput = document.getElementById("userId");
const downloadPathInput = document.getElementById("downloadPath");

let promptEditorExpanded = false;
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

const LOCKED_PROMPT_SUFFIX = `Reply with ONE JSON object only: plain UTF-8 text, valid JSON, no markdown fences (no triple backticks), no preamble or postscript before the first "{" or after the final "}". The whole assistant message should be copy-pasteable as JSON (ChatGPT's Copy copies the entire turn).

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

function sanitizeUserId(raw) {
  return String(raw || "").trim().slice(0, 128);
}

function sanitizeDownloadSubpath(raw) {
  let value = String(raw || "").trim();
  while (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    value = value.slice(1, -1).trim();
  }
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    return value;
  }
  value = value.replace(/\\/g, "/");
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

/** user_id.txt + append new id to Explorer send(...) menus (local gateway on 8787). */
async function writeLocalUserIdFile(userId) {
  if (!userId) return;
  try {
    const res = await fetch("http://localhost:8787/local/user-id", {
      method: "POST",
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      body: userId,
    });
    if (!res.ok) await res.text();
  } catch {
    /* gateway off — txt unchanged */
  }
}

async function updateUI() {
  const [localData, syncData] = await Promise.all([
    chrome.storage.local.get(["enabled"]),
    chrome.storage.sync.get(["promptTemplate", "resumeUserId", "downloadSubpath"]),
  ]);
  const data = { ...localData, ...syncData };
  const enabled = data.enabled !== false;
  const uidOk = Boolean(String(data.resumeUserId || "").trim());
  promptLocked.value = LOCKED_PROMPT_SUFFIX;
  if (!promptEditor.value) {
    promptEditor.value = String(data.promptTemplate || DEFAULT_PROMPT_TEMPLATE);
  }

  if (document.activeElement !== userIdInput) {
    userIdInput.value = String(data.resumeUserId || "").trim();
  }
  if (document.activeElement !== downloadPathInput) {
    downloadPathInput.value = sanitizeDownloadSubpath(data.downloadSubpath || DEFAULT_DOWNLOAD_SUBPATH);
  }

  if (enabled) {
    toggleTitle.innerText = "ON";
    toggleBtn.className = "on";
  } else {
    toggleTitle.innerText = "OFF";
    toggleBtn.className = "off";
  }

  promptBtn.disabled = !enabled || !uidOk;
  downloadBtn.disabled = !enabled || !uidOk;
  statusBox.className = `status ${enabled && uidOk ? "success" : "warning"}`;
  statusBox.innerText = enabled
    ? uidOk
      ? "Ready. Send JD and GPT result, then download."
      : "Set User ID below to enable prompt and download."
    : "Extension is OFF.";
  hint.innerText = enabled
    ? uidOk
      ? "Ready. Open ChatGPT, then click ChatGPT Prompt to auto-send."
      : "Set User ID (same as C:\\ResumeSender\\user_id.txt when gateway is on)."
    : "Extension is OFF. Turn it ON to use ChatGPT Prompt.";
}

toggleBtn.onclick = async () => {
  const data = await chrome.storage.local.get("enabled");
  const newState = !(data.enabled !== false);
  await chrome.storage.local.set({ enabled: newState });
  updateUI();
};

promptBtn.onclick = async () => {
  promptBtn.disabled = true;
  promptTitle.innerText = "Sending...";

  chrome.runtime.sendMessage({ type: "GENERATE_CHATGPT_PROMPT" }, (response) => {
    if (response?.status === "ok") {
      promptTitle.innerText = "Ready";
      hint.innerText = "Prompt pasted and sent to ChatGPT.";
    } else {
      promptTitle.innerText = "ChatGPT Prompt";
      hint.innerText = response?.detail || "Could not send prompt.";
    }

    window.setTimeout(() => {
      promptTitle.innerText = "ChatGPT Prompt";
      updateUI();
    }, 1200);
  });
};

editPromptBtn.onclick = async () => {
  promptEditorExpanded = !promptEditorExpanded;
  document.body.classList.toggle("expanded", promptEditorExpanded);
  editPromptBtn.querySelector(".button-title").innerText = promptEditorExpanded ? "Close Prompt" : "Edit Prompt";
  if (promptEditorExpanded) {
    const data = await chrome.storage.sync.get("promptTemplate");
    promptEditor.value = String(data.promptTemplate || DEFAULT_PROMPT_TEMPLATE);
  }
};

downloadBtn.onclick = async () => {
  downloadBtn.disabled = true;
  downloadTitle.innerText = "Downloading...";

  chrome.runtime.sendMessage({ type: "DOWNLOAD_RESUME" }, (response) => {
    if (response?.status === "ok") {
      downloadTitle.innerText = "Downloaded";
      hint.innerText = "Optimized resume DOCX download started.";
    } else {
      downloadTitle.innerText = "Download";
      hint.innerText = response?.detail || "Could not download resume.";
    }

    window.setTimeout(() => {
      downloadTitle.innerText = "Download";
      updateUI();
    }, 1200);
  });
};

promptEditor.addEventListener("input", () => {
  chrome.storage.sync.set({ promptTemplate: promptEditor.value });
});

userIdInput.addEventListener("change", async () => {
  const v = sanitizeUserId(userIdInput.value);
  userIdInput.value = v;
  await chrome.storage.sync.remove("resumeUploadMenuIds");
  await chrome.storage.sync.set({ resumeUserId: v });
  await writeLocalUserIdFile(v);
  updateUI();
});

userIdInput.addEventListener("blur", async () => {
  const v = sanitizeUserId(userIdInput.value);
  userIdInput.value = v;
  await chrome.storage.sync.remove("resumeUploadMenuIds");
  await chrome.storage.sync.set({ resumeUserId: v });
  if (v) await writeLocalUserIdFile(v);
  updateUI();
});

downloadPathInput.addEventListener("change", async () => {
  const path = sanitizeDownloadSubpath(downloadPathInput.value);
  downloadPathInput.value = path;
  await chrome.storage.sync.set({ downloadSubpath: path });
  updateUI();
});

downloadPathInput.addEventListener("blur", async () => {
  const path = sanitizeDownloadSubpath(downloadPathInput.value);
  downloadPathInput.value = path;
  await chrome.storage.sync.set({ downloadSubpath: path });
  updateUI();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.resumeUserId) updateUI();
});

updateUI();
