const SEND_BUTTON_ID = "resume-sender-floating-button";
const COM_ROLE_BUTTON_ID = "resume-sender-com-role-button";
const GPT_BUTTON_ID = "resume-sender-gpt-button";
const TOAST_CONTAINER_ID = "resume-sender-toast-container";
const CHATGPT_HOSTS = new Set(["chatgpt.com", "www.chatgpt.com", "chat.openai.com"]);
const CHATGPT_COPY_SELECTORS = [
  "button[aria-label='Copy']",
  "button[aria-label*='copy' i]",
  "button[data-state][aria-label='Copy']",
  "[role='button'][aria-label*='copy' i]",
  "button[data-testid*='copy' i]",
];
let buttons = [];
let isActive = false;
let lastCopiedText = "";
let lastCopyTriggerAt = 0;
let lastGptResultSentAt = 0;
let lastGptResultSentText = "";
let autoCaptureJob = null;
/** Last pointer position in page coordinates (for toolbar placement when selection has no DOM range). */
let lastPointerPageXY = { x: 0, y: 0 };
/**
 * After mouseup shows the toolbar, the following click often fires with an already-collapsed
 * selection; skip one empty-selection clear so the buttons are not removed immediately.
 */
let suppressToolbarClearOnce = false;
let lastToolbarShownAt = 0;

function trackPointerForToolbar(e) {
  lastPointerPageXY = { x: e.pageX, y: e.pageY };
}

function isTextLikeInput(el) {
  if (!(el instanceof HTMLInputElement)) return false;
  const blocked = new Set([
    "button",
    "checkbox",
    "color",
    "date",
    "datetime-local",
    "file",
    "hidden",
    "image",
    "month",
    "radio",
    "range",
    "reset",
    "submit",
    "time",
    "week",
  ]);
  const t = String(el.type || "text").toLowerCase();
  return !blocked.has(t);
}

/** Selected text inside a focused text control (window.getSelection() is often empty there). */
function getFormControlSelectionText(el) {
  if (!el) return "";
  if (el instanceof HTMLTextAreaElement) {
    const start = el.selectionStart;
    const end = el.selectionEnd;
    if (typeof start !== "number" || typeof end !== "number" || start === end) return "";
    return String(el.value || "").slice(start, end);
  }
  if (el instanceof HTMLInputElement && isTextLikeInput(el)) {
    const start = el.selectionStart;
    const end = el.selectionEnd;
    if (typeof start !== "number" || typeof end !== "number" || start === end) return "";
    return String(el.value || "").slice(start, end);
  }
  return "";
}

function getCombinedSelectedText() {
  const fromWindow = String(window.getSelection()?.toString() || "");
  const winTrim = fromWindow.trim();
  if (winTrim.length > 0) return fromWindow.trim();
  return String(getFormControlSelectionText(document.activeElement) || "").trim();
}

function getSelectionAnchorPageXY(selection, mouseEvent) {
  if (selection && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!range.collapsed && (rect.width > 1 || rect.height > 1)) {
      return {
        x: window.scrollX + rect.right,
        y: window.scrollY + rect.top,
      };
    }
  }
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && isTextLikeInput(el))) {
    const r = el.getBoundingClientRect();
    const x = window.scrollX + Math.min(r.right - 4, r.left + Math.max(72, r.width * 0.75));
    const y = window.scrollY + r.top + 8;
    return { x, y };
  }
  const px = mouseEvent?.pageX ?? lastPointerPageXY.x;
  const py = mouseEvent?.pageY ?? lastPointerPageXY.y;
  if (px > 0 || py > 0) {
    return { x: px, y: py };
  }
  return { x: window.scrollX + 120, y: window.scrollY + 120 };
}

// ===== MAIN HANDLER =====
function handleClick(e) {
  if (isOwnButton(e.target)) return;
  if (isChatGPTPage()) {
    const copyControl = getCopyControl(e);
    if (copyControl) {
      const copiedText = extractChatGptMessageText(copyControl);
      if (copiedText) {
        lastCopiedText = copiedText;
        lastCopyTriggerAt = Date.now();
        sendGptResultText(copiedText, "click-copy");
      } else if (isUsableSelection(lastCopiedText)) {
        lastCopyTriggerAt = Date.now();
        sendGptResultText(lastCopiedText, "click-copy-fallback");
      }
      return;
    }
  }

  const text = getCombinedSelectedText();

  if (!isUsableSelection(text)) {
    if (suppressToolbarClearOnce && Date.now() - lastToolbarShownAt < 500) {
      suppressToolbarClearOnce = false;
      return;
    }
    suppressToolbarClearOnce = false;
    removeButtons();
    return;
  }

  suppressToolbarClearOnce = false;
  showSelectionButtons(e.pageX, e.pageY, text);
}

function getControlAnchorPoint(control, event) {
  const pageX = Number(event?.pageX || 0);
  const pageY = Number(event?.pageY || 0);
  if (pageX > 0 || pageY > 0) {
    return { x: pageX, y: pageY };
  }
  const rect = control.getBoundingClientRect();
  return {
    x: window.scrollX + rect.right,
    y: window.scrollY + rect.top,
  };
}

function handleCopy() {
  const copied = getCombinedSelectedText();
  if (isUsableSelection(copied)) {
    lastCopiedText = copied;
    lastCopyTriggerAt = Date.now();
    if (isChatGPTPage()) {
      sendGptResultText(copied, "native-copy");
    }
  }
  window.setTimeout(showButtonsFromSelection, 0);
}

function sendGptResultText(text, source = "unknown") {
  const payload = normalizeJsonForSend(String(text || "").trim());
  if (!isUsableSelection(payload)) return;

  const now = Date.now();
  const isDuplicate = payload === lastGptResultSentText && now - lastGptResultSentAt < 2500;
  if (isDuplicate) return;
  lastGptResultSentText = payload;
  lastGptResultSentAt = now;

  chrome.runtime.sendMessage({ type: "SEND_GPT_RESULT", text: payload }, (response) => {
    if (response?.status === "ok") {
      showToast("GPT result sent successfully.", "success");
      // Full auto-flow: prompt -> generate -> capture -> send result -> auto-download.
      if (source === "auto-after-submit") {
        chrome.runtime.sendMessage({ type: "DOWNLOAD_RESUME" }, (downloadResponse) => {
          if (downloadResponse?.status === "ok") {
            showToast("Resume download started.", "success");
            return;
          }
          showToast(downloadResponse?.detail || "Could not download resume.", "error");
        });
      }
      return;
    }
    // Allow immediate retry if backend rejects.
    lastGptResultSentAt = 0;
    lastGptResultSentText = "";
    console.warn("SEND_GPT_RESULT failed:", source, response);
    showToast(response?.detail || "Failed to send GPT result.", "error");
  });
}

function normalizeJsonForSend(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  const candidate = extractLargestJsonObject(text) || text;
  return escapeControlCharsInsideJsonStrings(candidate);
}

function escapeControlCharsInsideJsonStrings(s) {
  const input = String(s || "");
  let out = "";
  let inString = false;
  let escape = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inString) {
      if (escape) {
        out += ch;
        escape = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        escape = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inString = false;
        continue;
      }
      if (ch === "\n") {
        out += "\\n";
        continue;
      }
      if (ch === "\r") {
        out += "\\r";
        continue;
      }
      if (ch === "\t") {
        out += "\\t";
        continue;
      }
      out += ch;
      continue;
    }
    out += ch;
    if (ch === '"') {
      inString = true;
    }
  }
  return out;
}

function handleKeydown(event) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
    window.setTimeout(showButtonsFromSelection, 0);
  }
}

function showButtonsFromSelection(mouseEvent) {
  const selection = window.getSelection();
  const text = getCombinedSelectedText();
  if (isUsableSelection(text)) {
    const anchor = getSelectionAnchorPageXY(selection, mouseEvent);
    lastToolbarShownAt = Date.now();
    suppressToolbarClearOnce = true;
    showSelectionButtons(anchor.x, anchor.y, text);
    return;
  }
  const recentlyCopied = Date.now() - lastCopyTriggerAt < 1500;
  if (isChatGPTPage() && recentlyCopied && isUsableSelection(lastCopiedText)) {
    const x = window.scrollX + Math.max(120, window.innerWidth - 120);
    const y = window.scrollY + 90;
    showSelectionButtons(x, y, lastCopiedText);
  }
}

function isChatGPTPage() {
  const h = window.location.hostname;
  if (CHATGPT_HOSTS.has(h)) return true;
  if (h === "chatgpt.com" || h.endsWith(".chatgpt.com")) return true;
  if (h === "chat.openai.com") return true;
  return false;
}

/** Hosted ChatGPT at chatgpt.com — selection UI is a single “send GPT result” control. */
function isChatgptDotComPage() {
  const h = window.location.hostname;
  return h === "chatgpt.com" || h === "www.chatgpt.com" || h.endsWith(".chatgpt.com");
}

function isOwnButton(target) {
  return Boolean(target?.closest?.(`#${SEND_BUTTON_ID}, #${COM_ROLE_BUTTON_ID}, #${GPT_BUTTON_ID}`));
}

function getCopyControl(event) {
  const path = typeof event?.composedPath === "function" ? event.composedPath() : [];
  for (const node of path) {
    if (!(node instanceof Element)) continue;
    for (const selector of CHATGPT_COPY_SELECTORS) {
      if (node.matches?.(selector)) return node;
    }
    const matchedParent = node.closest?.(CHATGPT_COPY_SELECTORS.join(", "));
    if (matchedParent) return matchedParent;
  }

  const target = event?.target;
  const control = target?.closest?.("button, [role='button']");
  if (!control) return null;

  const ariaLabel = (control.getAttribute("aria-label") || "").trim().toLowerCase();
  if (ariaLabel.includes("copy")) return control;

  const title = (control.getAttribute("title") || "").trim().toLowerCase();
  if (title.includes("copy")) return control;

  const dataTestId = (control.getAttribute("data-testid") || "").trim().toLowerCase();
  if (dataTestId.includes("copy")) return control;

  const className = String(control.className || "").toLowerCase();
  if (className.includes("copy")) return control;

  const label = [
    control.innerText,
    control.textContent,
  ]
    .join(" ")
    .trim()
    .toLowerCase();

  if (label.includes("copy")) return control;
  return null;
}

function extractChatGptMessageText(control) {
  const message = control.closest(
    "[data-message-author-role='assistant'], article, [data-testid*='conversation-turn'], [data-testid*='conversation-turn-assistant']"
  );
  if (!message) return "";
  const raw = sanitizeAssistantText(message.innerText || message.textContent || "");
  return extractLargestJsonObject(raw) || raw;
}

function removeButtons() {
  buttons.forEach((button) => button.remove());
  buttons = [];
}

function showSelectionButtons(x, y, text) {
  if (!isUsableSelection(text)) {
    removeButtons();
    return;
  }

  removeButtons();
  if (isChatgptDotComPage()) {
    buttons = [
      createButton(GPT_BUTTON_ID, x, y, text, "SEND_GPT_RESULT", getGptIcon(), "#7c3aed", "GPT"),
    ];
  } else {
    buttons = [
      createButton(SEND_BUTTON_ID, x, y, text, "SEND_JD", getJdIcon(), "#1d4ed8", "JD"),
      createButton(COM_ROLE_BUTTON_ID, x + 44, y, text, "SEND_COM_ROLE", getComRoleIcon(), "#1d4ed8", "Role"),
    ];
  }
  buttons.forEach((button) => {
    document.body.appendChild(button);
    requestAnimationFrame(() => {
      button.style.opacity = "1";
      button.style.transform = "translateY(0) scale(1)";
    });
  });
}

function isUsableSelection(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length < 3) return false;
  if (!/[A-Za-z0-9]/.test(normalized)) return false;
  if (/^[\W_]+$/.test(normalized)) return false;
  return true;
}

function enable() {
  if (isActive) return;

  document.addEventListener("click", handleClick, true);
  document.addEventListener("mousemove", trackPointerForToolbar, { passive: true, capture: true });
  document.addEventListener("mouseup", showButtonsFromSelection, true);
  document.addEventListener("copy", handleCopy);
  document.addEventListener("keydown", handleKeydown);
  isActive = true;

  console.log("Extension ON");
}

function disable() {
  if (!isActive) return;

  document.removeEventListener("click", handleClick, true);
  document.removeEventListener("mousemove", trackPointerForToolbar, { capture: true });
  document.removeEventListener("mouseup", showButtonsFromSelection, true);
  document.removeEventListener("copy", handleCopy);
  document.removeEventListener("keydown", handleKeydown);

  // remove any UI immediately
  removeButtons();
  lastCopiedText = "";

  isActive = false;

  console.log("Extension OFF");
}

async function init() {
  const data = await chrome.storage.local.get("enabled");
  const enabled = data.enabled !== false;

  if (enabled) enable();
  else disable();
}

init();

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.enabled) return;

  if (changes.enabled.newValue !== false) enable();
  else disable();
});

function createButton(id, x, y, text, messageType, icon, background, label) {
  const btn = document.createElement("div");
  btn.id = id;
  if (label === "GPT") btn.title = "Send selection to resume server (GPT result)";
  else if (label === "Role") btn.title = "Send company / role (required for download filename)";
  else btn.title = "Send job description";

  btn.innerHTML = icon;

  Object.assign(btn.style, {
    position: "absolute",
    left: x + "px",
    top: y + "px",
    zIndex: 2147483647,
    width: "36px",
    height: "36px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background,
    borderRadius: "50%",
    cursor: "pointer",
    opacity: "0",
    transform: "translateY(8px) scale(0.72)",
    transition: "opacity 540ms ease, transform 540ms cubic-bezier(0.16, 1, 0.3, 1), background 220ms ease",
    boxShadow: "0 12px 24px rgba(0,0,0,0.22)",
  });
  btn.style.setProperty("z-index", "2147483647", "important");

  let locked = false;

  btn.onclick = (event) => {
    event.stopPropagation();
    event.preventDefault();
    if (locked) return;
    locked = true;

    btn.innerHTML = getSpinner();
    btn.style.background = "#1e40af";

    chrome.runtime.sendMessage(
      { type: messageType, text },
      (response) => {
        if (response?.status === "ok") {
          btn.innerHTML = getCheckIcon();
          btn.style.background = "#22c55e";
          if (response.workflow?.message) {
            showToast(formatWorkflowMessage(response.workflow), response.workflow.color || "success", 8000);
          }
        } else {
          btn.innerHTML = getErrorIcon();
          btn.style.background = "#ef4444";
          showToast(response?.detail || "Send failed.", "error");
        }

        setTimeout(() => {
          btn.style.opacity = "0";
          btn.style.transform = "scale(0.8)";
        }, 800);

        setTimeout(() => removeButtons(), 1100);
      }
    );
  };

  return btn;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "SHOW_TOAST") {
    showToast(message.text || "", message.variant || "warning");
    sendResponse({ status: "ok" });
    return false;
  }

  if (message.type === "PASTE_AND_SUBMIT_PROMPT") {
    pasteAndSubmitPromptAsync(message.text)
      .then((result) => {
        if (result.ok) {
          showToast("Prompt pasted and sent to ChatGPT.", "success");
          sendResponse({ status: "ok" });
        } else {
          showToast(result.detail || "Could not paste and send prompt.", "error");
          sendResponse({ status: "error", detail: result.detail || "Could not paste and send prompt." });
        }
      })
      .catch((err) => {
        const detail = String(err?.message || err || "Paste failed");
        showToast(detail, "error");
        sendResponse({ status: "error", detail });
      });
    return true;
  }

  if (message.type !== "COPY_PROMPT") return false;

  copyText(message.text)
    .then(() => {
      showToast("Prompt copied. Press Ctrl+V.", "success");
      sendResponse({ status: "ok" });
    })
    .catch((error) => {
      console.error("Copy failed:", error);
      showToast("Copy failed.", "error");
      sendResponse({ status: "error", detail: String(error) });
    });

  return true;
});


function isVisible(el) {
  if (!(el instanceof HTMLElement)) return false;
  const s = getComputedStyle(el);
  if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 1 && r.height > 1;
}

async function pasteAndSubmitPromptAsync(text) {
  const promptText = String(text || "").trim();
  if (!promptText) {
    return { ok: false, detail: "Prompt is empty." };
  }

  if (!isChatGPTPage()) {
    return { ok: false, detail: "Open ChatGPT tab first (chatgpt.com)." };
  }

  const composer = getChatGptComposer();
  if (!composer) {
    return { ok: false, detail: "Could not find ChatGPT input. Scroll to the bottom or refresh the page." };
  }

  if (!setComposerText(composer, promptText)) {
    return { ok: false, detail: "Could not fill ChatGPT input. Try clicking the input, then use the button again." };
  }

  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  await new Promise((r) => setTimeout(r, 60));

  const sent = await trySubmitChatGptPrompt(composer);
  if (!sent) {
    return { ok: false, detail: "Prompt filled, but send failed. Click the send button or press Enter once." };
  }
  startAutoCaptureAfterSubmit();
  return { ok: true };
}

function startAutoCaptureAfterSubmit() {
  if (!isChatGPTPage()) return;
  if (autoCaptureJob?.timer) {
    clearTimeout(autoCaptureJob.timer);
  }
  if (autoCaptureJob?.observer) {
    try {
      autoCaptureJob.observer.disconnect();
    } catch {
      /* ignore */
    }
  }

  const startedAt = Date.now();
  autoCaptureJob = {
    startedAt,
    lastText: "",
    stableSince: 0,
    sent: false,
    observer: null,
    timer: null,
    finalizedMessage: null,
  };

  const maybeFinish = () => {
    if (!autoCaptureJob || autoCaptureJob.sent) return;
    const latest = getLatestAssistantMessageElement();
    if (!latest) return;

    const rawText = sanitizeAssistantText(latest.innerText || latest.textContent || "");
    const text = extractLargestJsonObject(rawText) || rawText;
    if (!isUsableSelection(text)) return;

    if (autoCaptureJob.lastText !== text) {
      autoCaptureJob.lastText = text;
      autoCaptureJob.stableSince = Date.now();
      autoCaptureJob.finalizedMessage = latest;
      return;
    }

    const stillGenerating = isAssistantLikelyGenerating();
    const stableMs = Date.now() - autoCaptureJob.stableSince;
    if (!stillGenerating && stableMs >= 1500) {
      autoCaptureJob.sent = true;
      sendGptResultText(text, "auto-after-submit");
      showToast("Generated result auto-sent.", "success");
      stopAutoCaptureJob();
    }
  };

  const observer = new MutationObserver(() => {
    maybeFinish();
  });
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  autoCaptureJob.observer = observer;

  const tick = () => {
    if (!autoCaptureJob) return;
    maybeFinish();
    const elapsed = Date.now() - startedAt;
    if (elapsed > 180000) {
      stopAutoCaptureJob();
      return;
    }
    autoCaptureJob.timer = window.setTimeout(tick, 700);
  };
  autoCaptureJob.timer = window.setTimeout(tick, 400);
}

function stopAutoCaptureJob() {
  if (!autoCaptureJob) return;
  if (autoCaptureJob.timer) clearTimeout(autoCaptureJob.timer);
  if (autoCaptureJob.observer) {
    try {
      autoCaptureJob.observer.disconnect();
    } catch {
      /* ignore */
    }
  }
  autoCaptureJob = null;
}

function sanitizeAssistantText(raw) {
  return String(raw || "")
    .replace(/\bcopy\b/gi, "")
    .replace(/\bthumbs up\b|\bthumbs down\b/gi, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function extractLargestJsonObject(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";

  let depth = 0;
  let start = -1;
  let best = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch !== "}" || depth <= 0) continue;
    depth -= 1;
    if (depth === 0 && start >= 0) {
      const candidate = text.slice(start, i + 1).trim();
      if (candidate.length > best.length) {
        best = candidate;
      }
      start = -1;
    }
  }
  return best;
}

function getLatestAssistantMessageElement() {
  const nodes = Array.from(
    document.querySelectorAll(
      "[data-message-author-role='assistant'], [data-testid*='conversation-turn-assistant'], article[data-testid*='conversation-turn']"
    )
  );
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const el = nodes[i];
    if (!(el instanceof HTMLElement)) continue;
    if (!isVisible(el)) continue;
    const text = sanitizeAssistantText(el.innerText || el.textContent || "");
    const jsonText = extractLargestJsonObject(text);
    if (isUsableSelection(jsonText)) return el;
    if (isUsableSelection(text)) return el;
  }
  return null;
}

function isAssistantLikelyGenerating() {
  const stopSel = [
    "button[aria-label*='Stop' i]",
    "button[data-testid*='stop' i]",
    "[data-testid*='stop-generating' i]",
    "[aria-busy='true']",
  ];
  return stopSel.some((sel) => Boolean(document.querySelector(sel)));
}

function getChatGptComposer() {
  const selectors = [
    "#prompt-textarea",
    "textarea#prompt-textarea",
    "textarea[data-testid='prompt-textarea']",
    "textarea[placeholder*='Message' i]",
    "textarea[placeholder*='Ask' i]",
    "div#prompt-textarea",
    "div[data-testid='prompt-textarea']",
    "div[contenteditable='true'][data-testid='prompt-textarea']",
    "div[contenteditable='true'][role='textbox']",
    "div[contenteditable='true'][tabindex='0']",
  ];
  for (const selector of selectors) {
    const node = document.querySelector(selector);
    if (node instanceof HTMLElement && isVisible(node)) {
      return node;
    }
  }

  for (const form of document.querySelectorAll("form")) {
    const ta = form.querySelector("textarea");
    if (ta instanceof HTMLElement && isVisible(ta)) {
      return ta;
    }
    const ce = form.querySelector("div[contenteditable='true']");
    if (ce instanceof HTMLElement && isVisible(ce)) {
      return ce;
    }
  }

  const main = document.querySelector("main");
  if (main) {
    const ce = main.querySelector("div[contenteditable='true'][role='textbox']");
    if (ce instanceof HTMLElement && isVisible(ce)) {
      return ce;
    }
    const ce2 = main.querySelector("div[contenteditable='true']");
    if (ce2 instanceof HTMLElement && isVisible(ce2)) {
      return ce2;
    }
  }

  return null;
}

function setNativeValue(composer, text) {
  if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
    const proto = Object.getPrototypeOf(composer);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) {
      const tracker = composer._valueTracker;
      if (typeof tracker?.setValue === "function") {
        tracker.setValue("");
      }
      desc.set.call(composer, text);
    } else {
      composer.value = text;
    }
  }
}

function setComposerText(composer, text) {
  try {
    composer.scrollIntoView({ block: "nearest", inline: "nearest" });
  } catch {
    /* ignore */
  }
  composer.focus();

  if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
    setNativeValue(composer, text);
    composer.dispatchEvent(new Event("input", { bubbles: true }));
    composer.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  if (composer.isContentEditable) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    selection?.removeAllRanges();
    selection?.addRange(range);

    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, text);
    } catch {
      inserted = false;
    }
    if (!inserted) {
      try {
        document.execCommand("selectAll", false, null);
        inserted = document.execCommand("insertText", false, text);
      } catch {
        inserted = false;
      }
    }
    if (!inserted) {
      composer.textContent = text;
    }

    composer.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType: "insertText", data: text, cancelable: true })
    );
    composer.dispatchEvent(
      new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: text, cancelable: true })
    );
    composer.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  return false;
}

function findSendButton(composer) {
  const trySels = (root) => {
    if (!root) return null;
    const sels = [
      "button[data-testid='send-button']",
      "button[aria-label='Send prompt']",
      "button[aria-label*='Send' i]",
      "button[title*='Send' i]",
      "button[type='submit']",
    ];
    for (const sel of sels) {
      const el = root.querySelector(sel);
      if (el instanceof HTMLButtonElement) {
        return el;
      }
    }
    return null;
  };

  let el = composer;
  for (let d = 0; d < 12 && el; d += 1) {
    const form = el.tagName === "FORM" ? el : el.closest("form");
    const inForm = trySels(form);
    if (inForm) {
      return inForm;
    }
    const inParent = trySels(el.parentElement);
    if (inParent) {
      return inParent;
    }
    el = el.parentElement;
  }
  return trySels(document.body);
}

function isButtonClickable(btn) {
  if (!(btn instanceof HTMLButtonElement)) return false;
  if (btn.disabled) return false;
  if (btn.getAttribute("aria-disabled") === "true") return false;
  if (btn.getAttribute("data-disabled") === "true") return false;
  return true;
}

async function trySubmitChatGptPrompt(composer) {
  const tryOnce = () => {
    const sendButton = findSendButton(composer);
    if (sendButton && isButtonClickable(sendButton)) {
      sendButton.click();
      return true;
    }
    return false;
  };

  if (tryOnce()) {
    return true;
  }
  await new Promise((r) => setTimeout(r, 120));
  if (tryOnce()) {
    return true;
  }

  composer.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    })
  );
  return true;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("document.execCommand('copy') failed");
}

function showToast(message, variant = "warning", duration = 4200) {
  const container = getToastContainer();
  const toast = document.createElement("div");
  const theme = getToastTheme(variant);
  toast.innerHTML = `
    <span style="${theme.iconStyle}">${theme.icon}</span>
    <span>${escapeHtml(message)}</span>
  `;

  Object.assign(toast.style, {
    display: "flex",
    alignItems: "flex-start",
    gap: "9px",
    background: theme.background,
    color: theme.color,
    border: `1px solid ${theme.border}`,
    padding: "11px 13px",
    borderRadius: "12px",
    fontSize: "13px",
    fontFamily: "Arial, sans-serif",
    lineHeight: "1.35",
    maxWidth: "320px",
    wordBreak: "break-word",
    whiteSpace: "pre-line",
    boxShadow: "0 14px 35px rgba(0,0,0,0.18)",
    opacity: "0",
    transform: "translateX(34px)",
    transition: "opacity 260ms ease, transform 260ms ease",
  });

  container.prepend(toast);

  requestAnimationFrame(() => {
    toast.style.opacity = "1";
    toast.style.transform = "translateX(0)";
  });

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(34px)";
  }, duration);

  setTimeout(() => toast.remove(), duration + 300);
}

function formatWorkflowMessage(workflow) {
  const reasons = Array.isArray(workflow.reasons) ? workflow.reasons.slice(0, 4) : [];
  if (!reasons.length) return workflow.message || "Status updated";
  return `${workflow.message}\n${reasons.map((reason) => `- ${reason}`).join("\n")}`;
}

function getToastContainer() {
  let container = document.getElementById(TOAST_CONTAINER_ID);
  if (container) return container;

  container = document.createElement("div");
  container.id = TOAST_CONTAINER_ID;
  Object.assign(container.style, {
    position: "fixed",
    top: "18px",
    right: "18px",
    zIndex: 2147483647,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-end",
    gap: "10px",
    pointerEvents: "none",
  });
  document.body.appendChild(container);
  return container;
}

function getToastTheme(variant) {
  if (variant === "success") {
    return {
      background: "#ecfdf5",
      border: "#86efac",
      color: "#14532d",
      icon: "✓",
      iconStyle: getToastIconStyle("#16a34a"),
    };
  }

  if (variant === "error") {
    return {
      background: "#fef2f2",
      border: "#fca5a5",
      color: "#7f1d1d",
      icon: "×",
      iconStyle: getToastIconStyle("#dc2626"),
    };
  }

  return {
    background: "#fffbeb",
    border: "#fcd34d",
    color: "#713f12",
    icon: "!",
    iconStyle: getToastIconStyle("#d97706"),
  };
}

function getToastIconStyle(color) {
  return [
    "display:inline-flex",
    "align-items:center",
    "justify-content:center",
    "width:18px",
    "height:18px",
    "min-width:18px",
    "border-radius:999px",
    `background:${color}`,
    "color:#fff",
    "font-size:12px",
    "font-weight:700",
    "line-height:18px",
  ].join(";");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ================= ICONS =================

/** Job description: document with text lines (not a send/plane icon). */
function getJdIcon() {
  return `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" stroke="white" stroke-width="1.75" stroke-linejoin="round" fill="none"/>
      <path d="M14 2v6h6" stroke="white" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      <path d="M8 12h8M8 16h8M8 20h5" stroke="white" stroke-width="1.75" stroke-linecap="round"/>
    </svg>
  `;
}

/** Company + role: office building (grid of windows — different silhouette from the JD “paper” icon). */
function getComRoleIcon() {
  return `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="white" xmlns="http://www.w3.org/2000/svg">
      <rect x="5" y="11" width="14" height="10" rx="1" fill="white"/>
      <rect x="8" y="5" width="8" height="6" rx="0.5" fill="white"/>
      <rect x="7" y="13" width="2.5" height="2.5" fill="#1d4ed8"/>
      <rect x="10.75" y="13" width="2.5" height="2.5" fill="#1d4ed8"/>
      <rect x="14.5" y="13" width="2.5" height="2.5" fill="#1d4ed8"/>
      <rect x="7" y="16.5" width="2.5" height="2.5" fill="#1d4ed8"/>
      <rect x="10.75" y="16.5" width="2.5" height="2.5" fill="#1d4ed8"/>
      <rect x="14.5" y="16.5" width="2.5" height="2.5" fill="#1d4ed8"/>
    </svg>
  `;
}

/** Send selection as GPT result (POST /gpt-result) — filled “send”, not document/building. */
function getGptIcon() {
  return `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="white" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
    </svg>
  `;
}

function getCheckIcon() {
  return `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
      <path d="M20 6L9 17l-5-5" stroke="white" stroke-width="2" fill="none"/>
    </svg>
  `;
}

function getErrorIcon() {
  return `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
      <path d="M6 6l12 12M6 18L18 6" stroke="white" stroke-width="2" fill="none"/>
    </svg>
  `;
}

function getSpinner() {
  return `
    <svg width="18" height="18" viewBox="0 0 50 50">
      <circle
        cx="25"
        cy="25"
        r="20"
        fill="none"
        stroke="white"
        stroke-width="4"
        stroke-linecap="round"
        stroke-dasharray="31.4 31.4"
      >
        <animateTransform
          attributeName="transform"
          type="rotate"
          from="0 25 25"
          to="360 25 25"
          dur="0.8s"
          repeatCount="indefinite"
        />
      </circle>
    </svg>
  `;
}

function getSparkIcon() {
  return `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="white">
      <path d="M12 2l1.7 5.2L19 9l-5.3 1.8L12 16l-1.7-5.2L5 9l5.3-1.8L12 2z"/>
      <path d="M18 14l.9 2.6 2.6.9-2.6.9L18 21l-.9-2.6-2.6-.9 2.6-.9L18 14z"/>
      <path d="M5 13l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2z"/>
    </svg>
  `;
}
