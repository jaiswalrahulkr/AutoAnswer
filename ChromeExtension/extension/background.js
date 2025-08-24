// Background service worker for AutoAnswer AI (Manifest V3)
// Handles lifecycle, keyboard command, and AI API calls

/**
 * Initialize default settings on install/update
 */
chrome.runtime.onInstalled.addListener(async () => {
  const defaults = {
    autoSubmit: false,
    apiProvider: "openai", // "openai" | "gemini"
    openaiApiKey: "",
    openaiModel: "gpt-4o-mini",
    geminiApiKey: "",
    geminiModel: "gemini-1.5-flash"
  };
  const existing = await chrome.storage.sync.get(Object.keys(defaults));
  const toSet = {};
  for (const [k, v] of Object.entries(defaults)) {
    if (existing[k] === undefined) toSet[k] = v;
  }
  if (Object.keys(toSet).length) {
    await chrome.storage.sync.set(toSet);
  }
});

/**
 * Handle keyboard command to trigger autofill in the active tab
 */
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "trigger_autofill") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    const canProceed = await checkCreditsAndMaybeLogUsage(false);
    if (!canProceed) return; // silently do nothing when no credits
    await chrome.tabs.sendMessage(tab.id, { type: "captureAndFill", skipSubmit: true });
    // On success, log usage (deduct 1). If it fails, don't deduct.
    await checkCreditsAndMaybeLogUsage(true, tab);
  } catch (err) {
    // Content script may not be ready; attempt to inject then retry
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
      await chrome.tabs.sendMessage(tab.id, { type: "captureAndFill" });
    } catch (e) {
      console.error("AutoAnswer AI: failed to trigger autofill via command", e);
      try {
        await chrome.tabs.reload(tab.id);
        await new Promise(r => setTimeout(r, 500));
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
        await chrome.tabs.sendMessage(tab.id, { type: "captureAndFill" });
      } catch (_) {}
    }
  }
});

/**
 * Extract JSON object from arbitrary text (handles code fences or prose-wrapped JSON)
 */
function extractJsonObjectFromText(text) {
  if (!text) return null;
  // Try direct JSON first
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") return parsed;
  } catch (_) {}

  // Try to find first JSON object in text via braces balancing
  let start = text.indexOf("{");
  while (start !== -1) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (parsed && typeof parsed === "object") return parsed;
        } catch (_) {}
        break;
      }
    }
    start = text.indexOf("{", start + 1);
  }
  return null;
}

/**
 * Build the standard prompt for providers
 */
function buildPrompt(pageText, inputDescriptors) {
  return `Given this webpage content:\n${pageText}\n\nAnd these inputs:\n${JSON.stringify(inputDescriptors, null, 2)}\n\nReturn ONLY JSON. If there are text fields, provide them under \'fields\' as { key: value }. If there are multiple-choice groups (radio/checkbox), provide them under \'choices\' as { \'group:<type>:<n>\': \'Option Label\' } or { \'group:checkbox:<n>\': [\'Label A\', \"Label B\"] }.\nExample:\n{\n  "fields": { "<fieldId|label|name|id|placeholder>": "<answer>" },\n  "choices": { "group:radio:0": "Yes", "group:checkbox:1": ["Option A", "Option C"] }\n}`;
}

function sanitizePlainTextAnswer(text) {
  if (!text) return "";
  let t = String(text).trim();
  const fenced = t.match(/^```[a-zA-Z0-9_+.#-]*\s*[\r\n]+([\s\S]*?)\s*```$/);
  if (fenced) t = fenced[1];
  t = t.replace(/^```[a-zA-Z0-9_+.#-]*\s*[\r\n]+/, "");
  t = t.replace(/[\r\n]+```\s*$/, "");
  t = t.replace(/^[a-zA-Z][\w.+#-]*\s*\r?\n/, "");
  t = t.replace(/```/g, "");
  return t.trim();
}

/**
 * Append a log entry both to storage (rolling buffer) and trigger a file download (optional manual)
 */
async function writeLog(entry) {
  try {
    const logEntry = { ts: new Date().toISOString(), ...entry };
    const { __logBuffer = [] } = await chrome.storage.local.get(["__logBuffer"]);
    // prune entries older than 60 days
    const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000; // 60 days in ms
    const pruned = __logBuffer.filter(e => {
      const t = Date.parse(e?.ts || "");
      return Number.isFinite(t) ? t >= cutoff : true;
    });
    const next = pruned.concat([logEntry]).slice(-200); // keep last 200 recent events
    await chrome.storage.local.set({ __logBuffer: next });
  } catch (_) {}
}

async function callOpenAI(prompt, model, apiKey) {
  if (!apiKey) throw new Error("OpenAI API key is missing in Options");
  const url = "https://api.openai.com/v1/chat/completions";
  const body = {
    model: model || "gpt-4o-mini",
    temperature: 0.2,
    max_tokens: 512,
    messages: [
      { role: "system", content: "You generate JSON only. Do not include backticks or commentary. If unsure, leave fields blank strings." },
      { role: "user", content: prompt }
    ]
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });
  await writeLog({ provider: 'openai', endpoint: url, request: body, status: resp.status });
  if (!resp.ok) {
    const t = await resp.text();
    await writeLog({ provider: 'openai', endpoint: url, error: t });
    throw new Error(`OpenAI error ${resp.status}: ${t}`);
  }
  const data = await resp.json();
  await writeLog({ provider: 'openai', endpoint: url, response: data });
  const content = data?.choices?.[0]?.message?.content || "";
  const obj = extractJsonObjectFromText(content);
  if (!obj || typeof obj !== "object") throw new Error("OpenAI returned no parseable JSON");
  return obj;
}

async function callOpenAIText(prompt, model, apiKey) {
  if (!apiKey) throw new Error("OpenAI API key is missing in Options");
  const url = "https://api.openai.com/v1/chat/completions";
  const body = {
    model: model || "gpt-4o-mini",
    temperature: 0.2,
    max_tokens: 256,
    messages: [
      { role: "system", content: "Return ONLY the final answer as plain text. No JSON, no code fences, no commentary." },
      { role: "user", content: prompt }
    ]
  };
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify(body)
  });
  await writeLog({ provider: 'openai', endpoint: url, request: body, status: resp.status });
  if (!resp.ok) {
    const t = await resp.text();
    await writeLog({ provider: 'openai', endpoint: url, error: t });
    throw new Error(`OpenAI error ${resp.status}: ${t}`);
  }
  const data = await resp.json();
  await writeLog({ provider: 'openai', endpoint: url, response: data });
  return sanitizePlainTextAnswer(data?.choices?.[0]?.message?.content || "");
}

async function callGemini(prompt, model, apiKey) {
  if (!apiKey) throw new Error("Gemini API key is missing in Options");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: { temperature: 0.25 }
  };
  const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  await writeLog({ provider: 'gemini', endpoint: url, request: body, status: resp.status });
  if (!resp.ok) {
    const t = await resp.text();
    await writeLog({ provider: 'gemini', endpoint: url, error: t });
    throw new Error(`Gemini error ${resp.status}: ${t}`);
  }
  const data = await resp.json();
  await writeLog({ provider: 'gemini', endpoint: url, response: data });
  const candidates = data?.candidates || [];
  const textParts = [];
  for (const c of candidates) {
    const parts = c?.content?.parts || [];
    for (const p of parts) {
      if (p?.text) textParts.push(p.text);
    }
  }
  const combined = textParts.join("\n").trim();
  const obj = extractJsonObjectFromText(combined);
  if (!obj || typeof obj !== "object") throw new Error("Gemini returned no parseable JSON");
  return obj;
}

async function callGeminiText(prompt, model, apiKey) {
  if (!apiKey) throw new Error("Gemini API key is missing in Options");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0 } };
  const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  await writeLog({ provider: 'gemini', endpoint: url, request: body, status: resp.status });
  if (!resp.ok) {
    const t = await resp.text();
    await writeLog({ provider: 'gemini', endpoint: url, error: t });
    throw new Error(`Gemini error ${resp.status}: ${t}`);
  }
  const data = await resp.json();
  await writeLog({ provider: 'gemini', endpoint: url, response: data });
  const candidates = data?.candidates || [];
  const parts = candidates.flatMap(c => (c?.content?.parts || []));
  const text = parts.map(p => p?.text || "").join("\n");
  return sanitizePlainTextAnswer(text);
}

/**
 * Call the AI provider with the page text and input labels
 */
async function callAiApi(pageText, inputDescriptors) {
  const { apiProvider, openaiApiKey, openaiModel, geminiApiKey, geminiModel } = await chrome.storage.sync.get([
    "apiProvider", "openaiApiKey", "openaiModel", "geminiApiKey", "geminiModel"
  ]);
  const prompt = buildPrompt(pageText, inputDescriptors) + "\n\nReturn ONLY JSON. You may use either { id->answer } or an array of { id|label|name|htmlId|selector, answer }.";
  if (apiProvider === "gemini") {
    if (!geminiApiKey) throw new Error("Gemini API key missing. Set it in Options or Popup.");
    return await callGemini(prompt, geminiModel || "gemini-1.5-flash", geminiApiKey);
  }
  if (!openaiApiKey) throw new Error("OpenAI API key missing. Set it in Options or Popup.");
  return await callOpenAI(prompt, openaiModel || "gpt-4o-mini", openaiApiKey);
}

/**
 * Call provider to generate a single text answer for one focused field
 */
async function callAiForFocused(pageText, focusedDescriptor) {
  const { apiProvider, openaiApiKey, openaiModel, geminiApiKey, geminiModel } = await chrome.storage.sync.get([
    "apiProvider", "openaiApiKey", "openaiModel", "geminiApiKey", "geminiModel"
  ]);
  const prompt = `Given this webpage content (trimmed):\n${pageText}\n\nAnd this input field:\n${JSON.stringify(focusedDescriptor, null, 2)}\n\nWrite the most suitable, concise answer for this field ONLY. Return only the final answer as plain text.`;
  if (apiProvider === "gemini") {
    if (!geminiApiKey) throw new Error("Gemini API key missing. Set it in Options or Popup.");
    return await callGeminiText(prompt, geminiModel || "gemini-1.5-flash", geminiApiKey);
  }
  if (!openaiApiKey) throw new Error("OpenAI API key missing. Set it in Options or Popup.");
  return await callOpenAIText(prompt, openaiModel || "gpt-4o-mini", openaiApiKey);
}

/**
 * Optionally capture a visible-page screenshot (returns dataUrl)
 */
async function captureVisibleScreenshot(windowId) {
  return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
}

/**
 * Message handler from content or popup
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === "callAi") {
      const { pageText, inputs, includeScreenshot } = message;
      let screenshotDataUrl = null;
      try {
        if (includeScreenshot && sender?.tab?.windowId != null) {
          screenshotDataUrl = await captureVisibleScreenshot(sender.tab.windowId);
        }
      } catch (err) {
        console.warn("AutoAnswer AI: screenshot capture failed", err);
      }

      try {
        const startedAt = Date.now();
        const answers = await callAiApi(pageText, inputs);
        const elapsedMs = Date.now() - startedAt;
        console.log("AutoAnswer AI: AI answers", { elapsedMs, inputsCount: inputs?.length || 0, sample: Object.keys(answers || {}).slice(0, 3) });
        sendResponse({ ok: true, answers, screenshotDataUrl, debug: { elapsedMs } });
      } catch (error) {
        console.error("AutoAnswer AI: AI call failed", error);
        sendResponse({ ok: false, error: String(error) });
      }
      return; // keep message channel open
    }

    if (message?.type === 'callAiChoicesForSelection') {
      try {
        const { selectionText, groups } = message;
        const prompt = `Given this question block:\n${selectionText}\n\nAnd these choice groups:\n${JSON.stringify(groups, null, 2)}\n\nReturn ONLY JSON under 'choices' mapping groupId to selected option label(s). For radio: string label. For checkbox: array of labels.`;
        const answers = await callAiApi(selectionText, groups);
        // Accept both direct 'choices' or flat map
        const choices = answers?.choices || answers || {};
        sendResponse({ ok: true, choices });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
      return;
    }

    if (message?.type === "callAiFocused") {
      const { pageText, focused } = message;
      try {
        const startedAt = Date.now();
        const answer = await callAiForFocused(pageText, focused);
        const elapsedMs = Date.now() - startedAt;
        console.log("AutoAnswer AI: Focused answer", { elapsedMs, sample: (answer || "").slice(0, 80) });
        sendResponse({ ok: true, answer });
      } catch (error) {
        console.error("AutoAnswer AI: AI focused call failed", error);
        sendResponse({ ok: false, error: String(error) });
      }
      return;
    }

    if (message?.type === "triggerAutofillActiveTab") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return sendResponse({ ok: false, error: "No active tab" });
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "captureAndFill" });
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
      return;
    }

    // Unknown message
    sendResponse({ ok: false, error: "Unknown message type" });
  })();
  return true; // indicate async response
});

async function backendFetch(path, options = {}) {
  const base = "http://localhost:3001"; // dev default; replace in production
  const { sessionToken } = await chrome.storage.local.get(["sessionToken"]);
  const headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
  if (sessionToken) headers["Authorization"] = `Bearer ${sessionToken}`;
  const resp = await fetch(base + path, Object.assign({}, options, { headers }));
  return resp;
}

async function checkCreditsAndMaybeLogUsage(logAfterSuccess, tabCtx) {
  try {
    const meResp = await backendFetch("/user/me", { method: "GET" });
    if (!meResp.ok) return false;
    const me = await meResp.json();
    if (!me || typeof me.creditsBalance !== 'number' || me.creditsBalance <= 0) return false;
    if (logAfterSuccess) {
      const reqId = cryptoRandomId();
      const pageUrl = tabCtx?.url || '';
      await backendFetch("/usage/log", { method: "POST", body: JSON.stringify({ actionType: "autofill", requestId: reqId, pageUrl }) });
    }
    return true;
  } catch (_) {
    return false;
  }
}

function cryptoRandomId() {
  try {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch (_) {
    return String(Date.now()) + Math.random().toString(16).slice(2);
  }
}


