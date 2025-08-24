// Content script for AutoAnswer AI
// Extracts visible text and form fields, asks background to call AI, and fills answers

/**
 * Generate a short stable-ish ID for a field in this session
 */
function generateFieldId(element, index) {
  const parts = [];
  if (element.id) parts.push(`id:${element.id}`);
  if (element.name) parts.push(`name:${element.name}`);
  const aria = element.getAttribute("aria-label");
  if (aria) parts.push(`aria:${aria}`);
  const placeholder = element.getAttribute("placeholder");
  if (placeholder) parts.push(`ph:${placeholder}`);
  const type = element.getAttribute("type") || element.tagName.toLowerCase();
  parts.push(`type:${type}`);
  parts.push(`idx:${index}`);
  return parts.join("|");
}

/**
 * Attempt to find a human-readable label for an input-like element
 */
function getLabelForElement(el) {
  // <label for="id"> pattern
  if (el.id) {
    const byFor = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (byFor?.innerText?.trim()) return byFor.innerText.trim();
  }
  // implicit label wrapper
  const wrapperLabel = el.closest("label");
  if (wrapperLabel?.innerText?.trim()) return wrapperLabel.innerText.trim();
  // aria-label / placeholder / aria-labelledby
  const aria = el.getAttribute("aria-label");
  if (aria) return aria.trim();
  const ariaLabelledBy = el.getAttribute("aria-labelledby");
  if (ariaLabelledBy) {
    const byId = ariaLabelledBy.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean);
    const text = byId.map(n => n.innerText || n.textContent || "").join(" ").trim();
    if (text) return text;
  }
  const ph = el.getAttribute("placeholder");
  if (ph) return ph.trim();
  // previous sibling text
  const prev = el.previousElementSibling;
  if (prev?.innerText?.trim()) return prev.innerText.trim();
  // MUI pattern: input inside label; the label text is a sibling span with Typography classes
  const parentLabel = el.closest('label');
  if (parentLabel) {
    const textSpans = parentLabel.querySelectorAll('span');
    for (const s of textSpans) {
      const t = (s.innerText || '').trim();
      if (t) return t;
    }
  }
  // nearest heading or strong text above
  const candidate = el.closest("div, section, td, th, li, p, form");
  if (candidate) {
    const heading = candidate.querySelector("h1,h2,h3,h4,strong,b");
    if (heading?.innerText?.trim()) return heading.innerText.trim();
  }
  // fallback to name or id
  if (el.name) return el.name;
  if (el.id) return el.id;
  return el.tagName.toLowerCase();
}

/**
 * Determine if element is visible in DOM
 */
function isVisible(el) {
  const style = window.getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none" || parseFloat(style.opacity || "1") === 0) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isChoiceElementVisible(el) {
  if (isVisible(el)) return true;
  const label = el.closest('label');
  if (label && isVisible(label)) return true;
  const cont = el.parentElement;
  if (cont && isVisible(cont)) return true;
  return false;
}

/**
 * Collect page visible text
 */
function collectPageText() {
  let text = document.body?.innerText || "";
  text = text.replace(/\s+/g, " ").trim();
  return text.slice(0, 20000); // cap to avoid massive payloads
}

/**
 * Collect text-like fields and choice groups (radio/checkbox)
 */
function collectSchema() {
  const all = Array.from(document.querySelectorAll("input, textarea, [contenteditable=''], [contenteditable='true']"));
  const textCandidates = all.filter((el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      const allowed = ["text", "search", "email", "url", "password", "tel", "number"];
      return allowed.includes(type) && isVisible(el);
    }
    if (tag === "textarea" || el.hasAttribute("contenteditable")) return isVisible(el);
    return false;
  });

  const textFields = [];
  textCandidates.forEach((el, idx) => {
    const fieldId = generateFieldId(el, idx);
    el.setAttribute("data-autoanswer-id", fieldId);
    const label = getLabelForElement(el);
    const name = el.getAttribute("name") || "";
    const htmlId = el.getAttribute("id") || "";
    const placeholder = el.getAttribute("placeholder") || "";
    const type = (el.getAttribute("type") || el.tagName.toLowerCase()).toLowerCase();
    textFields.push({ id: fieldId, label, name, htmlId, placeholder, type });
  });

  // Choice groups (input radios/checkboxes and role-based toggles)
  function collectChoiceGroupsInContainer(container) {
    const elements = [
      ...Array.from(container.querySelectorAll("input[type='radio'], input[type='checkbox']")),
      ...Array.from(container.querySelectorAll("[role='radio'], [role='checkbox']"))
    ].filter(isChoiceElementVisible);

    const groupMap = new Map();
    function findGroupKey(el) {
      const role = (el.getAttribute("role") || "").toLowerCase();
      const type = role === "radio" || role === "checkbox" ? role : (el.getAttribute("type") || "").toLowerCase();
      const name = el.getAttribute("name") || "";
      const radiogroup = el.closest("[role='radiogroup']");
      const ariaGroupLabel = radiogroup?.getAttribute("aria-label") || radiogroup?.getAttribute("aria-labelledby") || "";
      const fieldset = el.closest("fieldset");
      const legend = fieldset?.querySelector("legend")?.innerText?.trim() || "";
      const cont = el.closest("section, div, form, table") || document.body;
      const heading = cont.querySelector("h1,h2,h3,h4,strong,b")?.innerText?.trim() || "";
      const base = name || ariaGroupLabel || legend || heading || getLabelForElement(el) || "group";
      return `${type}:${base}`;
    }

    elements.forEach((el) => {
      const key = findGroupKey(el);
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key).push(el);
    });

    const groups = [];
    let idx = 0;
    for (const [key, els] of groupMap.entries()) {
      if (!els || els.length === 0) continue;
      const [kind] = key.split(":");
      const first = els[0];
      const fieldset = first.closest("fieldset");
      const legend = fieldset?.querySelector("legend")?.innerText?.trim();
      const cont = first.closest("section, div, form, table") || container;
      const heading = cont.querySelector("h1,h2,h3,h4,strong,b")?.innerText?.trim();
      const question = legend || heading || getLabelForElement(first) || "";
      const groupId = `group:${kind}:${idx++}`;
      const options = els.map((el, i) => {
        const optId = generateFieldId(el, i);
        el.setAttribute("data-autoanswer-id", optId);
        el.setAttribute("data-autoanswer-group", groupId);
        const label = getLabelForElement(el) || el.getAttribute("aria-label") || el.textContent?.trim() || el.value || `Option ${i + 1}`;
        return { id: optId, label };
      });
      groups.push({ groupId, groupType: kind === "radio" ? "radio" : "checkbox", question, options });
    }
    return groups;
  }

  const choiceGroups = collectChoiceGroupsInContainer(document);

  return { textFields, choiceGroups };
}

/**
 * Fill answers into fields; optionally submit surrounding forms
 */
function normalizeKey(s) {
  if (!s) return "";
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function setElementValue(el, value, options = {}) {
  const tag = el.tagName.toLowerCase();
  const v = typeof value === "string" ? value : JSON.stringify(value);
  if (tag === "textarea" || tag === "input") {
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    if (!options.suppressSubmit) {
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  } else if (el.hasAttribute("contenteditable")) {
    el.textContent = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
}

function ensureChecked(el, isRadio = false, options = {}) {
  const role = (el.getAttribute('role') || '').toLowerCase();
  const kind = role === 'radio' || role === 'checkbox' ? role : (el.getAttribute('type') || '').toLowerCase();
  if (kind === 'radio' || isRadio) {
    // Uncheck siblings in the same name or radiogroup
    const name = el.getAttribute('name');
    const group = name ? document.querySelectorAll(`input[type='radio'][name='${CSS.escape(name)}']`) : el.closest("[role='radiogroup']")?.querySelectorAll("[role='radio']");
    if (group) {
      group.forEach((node) => {
        if (node !== el) {
          if (node.hasAttribute('role')) node.setAttribute('aria-checked', 'false');
          else node.checked = false;
        }
      });
    }
  }
  if (el.hasAttribute('role')) {
    el.setAttribute('aria-checked', 'true');
    if (!options.suppressSubmit) {
      el.dispatchEvent(new Event('click', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  } else {
    // Set checked state without triggering click/change to avoid navigation
    const willChange = !el.checked;
    el.checked = true;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    if (!options.suppressSubmit) {
      // Only dispatch change if allowed
      if (!willChange) {
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (!options.suppressSubmit) {
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
  }
}

function deriveGroupQuestionFromElement(el) {
  const fieldset = el.closest("fieldset");
  const legend = fieldset?.querySelector("legend")?.innerText?.trim();
  if (legend) return legend;
  const container = el.closest("section, div, form, table") || document.body;
  const heading = container.querySelector("h1,h2,h3,h4,strong,b")?.innerText?.trim();
  if (heading) return heading;
  return getLabelForElement(el) || "";
}

function buildFieldIndex() {
  const inputs = Array.from(document.querySelectorAll("[data-autoanswer-id]"));
  const byId = new Map();
  const byLabel = new Map();
  const byName = new Map();
  const byHtmlId = new Map();
  const byPlaceholder = new Map();
  const byGroup = new Map(); // groupId -> { type, question, options: [{el,label,id}] }
  const byGroupQuestion = new Map(); // normalized question -> groupId
  for (const el of inputs) {
    const fieldId = el.getAttribute("data-autoanswer-id");
    if (fieldId) byId.set(fieldId, el);
    const label = normalizeKey(getLabelForElement(el));
    if (label && !byLabel.has(label)) byLabel.set(label, el);
    const name = normalizeKey(el.getAttribute("name"));
    if (name && !byName.has(name)) byName.set(name, el);
    const htmlId = normalizeKey(el.getAttribute("id"));
    if (htmlId && !byHtmlId.has(htmlId)) byHtmlId.set(htmlId, el);
    const placeholder = normalizeKey(el.getAttribute("placeholder"));
    if (placeholder && !byPlaceholder.has(placeholder)) byPlaceholder.set(placeholder, el);
    if (label) el.setAttribute("data-autoanswer-label", label);

    const groupId = el.getAttribute("data-autoanswer-group");
    if (groupId) {
      if (!byGroup.has(groupId)) {
        const type = (el.getAttribute("type") || "").toLowerCase();
        const question = deriveGroupQuestionFromElement(el);
        const qNorm = normalizeKey(question);
        byGroup.set(groupId, { type, question, options: [] });
        if (qNorm && !byGroupQuestion.has(qNorm)) byGroupQuestion.set(qNorm, groupId);
      }
      byGroup.get(groupId).options.push({ el, label: getLabelForElement(el) || "", id: fieldId });
    }
  }
  return { byId, byLabel, byName, byHtmlId, byPlaceholder, byGroup, byGroupQuestion };
}

async function fillAnswers(answers, options = {}) {
  if (!answers) return { filled: 0, submitted: false };
  let filledCount = 0;
  const touchedForms = new Set();
  const index = buildFieldIndex();

  function applyTo(el, value) {
    if (!el) return false;
    setElementValue(el, value, { suppressSubmit: !!options.skipSubmit });
    filledCount++;
    const form = el.closest("form");
    if (form) touchedForms.add(form);
    return true;
  }

  // Case 1: answers is an array of objects
  if (Array.isArray(answers)) {
    for (const item of answers) {
      if (!item) continue;
      const value = item.answer ?? item.value ?? item.text;
      if (item.id || item.fieldId) {
        const el = index.byId.get(item.id || item.fieldId);
        if (applyTo(el, value)) continue;
      }
      if (item.selector) {
        const el = document.querySelector(item.selector);
        if (applyTo(el, value)) continue;
      }
      const keyLabel = normalizeKey(item.label);
      if (keyLabel) {
        const el = index.byLabel.get(keyLabel);
        if (applyTo(el, value)) continue;
      }
      const keyName = normalizeKey(item.name);
      if (keyName) {
        const el = index.byName.get(keyName);
        if (applyTo(el, value)) continue;
      }
      const keyHtmlId = normalizeKey(item.htmlId || item.idAttr);
      if (keyHtmlId) {
        const el = index.byHtmlId.get(keyHtmlId);
        if (applyTo(el, value)) continue;
      }
    }
  } else if (typeof answers === "object") {
    // Case 2: answers is an object mapping
    if (answers.choices && typeof answers.choices === 'object') {
      for (const [groupKey, value] of Object.entries(answers.choices)) {
        let group = index.byGroup.get(groupKey);
        if (!group) {
          const altGroupId = index.byGroupQuestion.get(normalizeKey(groupKey));
          if (altGroupId) group = index.byGroup.get(altGroupId);
        }
        if (!group) continue;
        const selectBy = (val) => {
          if (val == null) return null;
          const exact = String(val).trim();
          const keepPunctLower = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
          const rawLower = keepPunctLower(val);
          const norm = normalizeKey(val);

          // Case-sensitive tie-breaker: if multiple option labels are the same ignoring case,
          // prefer exact-case match; otherwise prefer the capitalized one (useful for Java 'String').
          const sameCaseInsensitive = (label) => keepPunctLower(label) === rawLower;
          const csCandidates = group.options.filter(o => sameCaseInsensitive(o.label));
          if (csCandidates.length >= 2) {
            const exactCase = csCandidates.find(o => (o.label || '').trim() === exact);
            if (exactCase) return exactCase;
            const capitalized = csCandidates.find(o => /^[A-Z]/.test((o.label || '').trim()));
            if (capitalized) return capitalized;
          }

          let best = null;
          let bestScore = -1;

          for (const o of group.options) {
            // Strongest: exact id or exact label (case & punctuation preserved)
            if (o.id === val) return o;
            const labelExact = (o.label || '').trim();
            if (labelExact === exact) return o;

            // Compute features
            const labelLower = keepPunctLower(o.label);
            const lNorm = normalizeKey(o.label);
            const labelNode = o.el.closest('label');
            const around = (labelNode?.innerText || o.el.parentElement?.innerText || '').trim();
            const aroundLower = keepPunctLower(around);
            const aroundNorm = normalizeKey(around);

            // Score matches in descending strength
            let score = 0;
            if (labelLower === rawLower) score = 90;
            else if (labelLower && (labelLower.includes(rawLower) || rawLower.includes(labelLower))) score = 80;
            else if (around === exact) score = 78;
            else if (aroundLower === rawLower) score = 75;
            else if (lNorm === norm) score = 60;
            else if (lNorm && (lNorm.includes(norm) || norm.includes(lNorm))) score = 50;
            else if (aroundNorm && (aroundNorm.includes(norm) || norm.includes(aroundNorm))) score = 40;

            if (score > bestScore) { best = o; bestScore = score; }
          }
          return best;
        };
        if (Array.isArray(value)) {
          // Multi-select (checkbox)
          value.forEach(v => {
            const opt = selectBy(v);
            if (opt?.el) {
              ensureChecked(opt.el, false, { suppressSubmit: !!options.skipSubmit });
              filledCount++;
              const form = opt.el.closest('form');
              if (form) touchedForms.add(form);
            }
          });
        } else if (typeof value === 'string') {
          // Single select (radio)
          const opt = selectBy(value);
          if (opt?.el) {
            ensureChecked(opt.el, true, { suppressSubmit: !!options.skipSubmit });
            filledCount++;
            const form = opt.el.closest('form');
            if (form) touchedForms.add(form);
          }
        }
      }
    }

    if (answers.fields && typeof answers.fields === 'object') {
      for (const [key, value] of Object.entries(answers.fields)) {
        let el = index.byId.get(key) || index.byLabel.get(normalizeKey(key)) || index.byName.get(normalizeKey(key)) || index.byHtmlId.get(normalizeKey(key)) || index.byPlaceholder.get(normalizeKey(key));
        if (el) applyTo(el, value);
      }
    } else {
      // Backwards compatibility: flat map
      for (const [key, value] of Object.entries(answers)) {
        let el = index.byId.get(key) || index.byLabel.get(normalizeKey(key)) || index.byName.get(normalizeKey(key)) || index.byHtmlId.get(normalizeKey(key)) || index.byPlaceholder.get(normalizeKey(key));
        if (el) applyTo(el, value);
      }
    }
  }

  const { autoSubmit } = await chrome.storage.sync.get(["autoSubmit"]);
  let submitted = false;
  const skipSubmit = !!options.skipSubmit;
  const shouldSubmit = !!autoSubmit && !skipSubmit;
  if (shouldSubmit && touchedForms.size > 0) {
    const form = touchedForms.values().next().value;
    try {
      const submitBtn = form.querySelector('[type="submit"]') || form.querySelector("button, input[type='submit']");
      if (submitBtn) {
        submitBtn.click();
      } else if (typeof form.submit === "function") {
        form.submit();
      }
      submitted = true;
    } catch (_) {}
  }

  return { filled: filledCount, submitted };
}

function showToast(_) { /* disabled per request */ }

/**
 * Orchestrate: collect content, call background AI, fill results
 */
async function captureAndFill(includeScreenshot = false, skipSubmit = false) {
  let pageText = collectPageText();
  const { textFields, choiceGroups } = collectSchema();
  let inputs = [...textFields, ...choiceGroups.map(g => ({ id: g.groupId, label: g.question, type: g.groupType, options: g.options }))];

  // Trim context for MCQs: if we only detected choice groups and no text fields,
  // reduce the page text to the nearest question block and send only groups.
  if ((!textFields || textFields.length === 0) && choiceGroups && choiceGroups.length > 0) {
    try {
      const firstOptId = choiceGroups[0]?.options?.[0]?.id;
      const el = firstOptId ? document.querySelector(`[data-autoanswer-id="${CSS.escape(firstOptId)}"]`) : null;
      const block = el?.closest('fieldset, section, article, li, div, form, table') || document.body;
      const selectionText = (block.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
      if (selectionText) pageText = selectionText;
      inputs = choiceGroups.map(g => ({ id: g.groupId, label: g.question, type: g.groupType, options: g.options }));
    } catch (_) {}
  }

  const response = await chrome.runtime.sendMessage({ type: "callAi", pageText, inputs, includeScreenshot });
  if (!response?.ok) throw new Error(response?.error || "AI request failed");
  const answers = response.answers;
  console.debug("AutoAnswer AI: Received answers", answers);
  const result = await fillAnswers(answers, { skipSubmit });
  if (result.filled === 0) {
    console.warn("AutoAnswer AI: No fields filled. Inputs detected:", inputs);
  }
  return result;
}

/**
 * Focus-aware fill: if a field is focused or mouse is hovering, generate answer only for it
 */
async function fillFocusedFieldIfAny() {
  const active = document.activeElement;
  let target = null;
  if (active && (active.matches('input, textarea') || active.hasAttribute('contenteditable'))) {
    target = active;
  }
  if (!target) return { ok: false };

  const pageText = collectPageText();
  const idx = 0;
  const fieldId = generateFieldId(target, idx);
  target.setAttribute('data-autoanswer-id', fieldId);
  const descriptor = {
    id: fieldId,
    label: getLabelForElement(target),
    name: target.getAttribute('name') || '',
    htmlId: target.getAttribute('id') || '',
    placeholder: target.getAttribute('placeholder') || '',
    type: (target.getAttribute('type') || target.tagName.toLowerCase()).toLowerCase()
  };
  const resp = await chrome.runtime.sendMessage({ type: 'callAiFocused', pageText, focused: descriptor });
  if (!resp?.ok) throw new Error(resp?.error || 'AI focused request failed');
  setElementValue(target, resp.answer || '');
  return { ok: true };
}

/**
 * If the user has a selection around an MCQ area, detect radio/checkbox groups inside and let AI decide.
 */
async function fillSelectionChoicesIfAny(skipSubmit = false) {
  try {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return { ok: false };
    const range = sel.getRangeAt(0);
    let container = range.commonAncestorContainer;
    if (container && container.nodeType === Node.TEXT_NODE) container = container.parentElement;
    if (!container || !(container instanceof Element)) return { ok: false };

    // Expand to a reasonable container that may include the whole MCQ block
    let block = container.closest('fieldset, section, article, li, div, form, table') || container;
    // Find radios/checkboxes within the block
    const inputs = Array.from(block.querySelectorAll("input[type='radio'], input[type='checkbox']")).filter(isVisible);
    if (inputs.length === 0) return { ok: false };

    // Build groups similarly to collectSchema
    const groupMap = new Map();
    function findGroupKey(el) {
      const type = (el.getAttribute('type') || '').toLowerCase();
      const name = el.getAttribute('name') || '';
      const fieldset = el.closest('fieldset');
      const legend = fieldset?.querySelector('legend')?.innerText?.trim() || '';
      const containerEl = el.closest('section, div, form, table') || document.body;
      const heading = containerEl.querySelector('h1,h2,h3,h4,strong,b')?.innerText?.trim() || '';
      const base = name || legend || heading || getLabelForElement(el) || 'group';
      return `${type}:${base}`;
    }
    inputs.forEach((el, idx) => {
      const key = findGroupKey(el);
      if (!groupMap.has(key)) groupMap.set(key, []);
      groupMap.get(key).push(el);
    });

    const choiceGroups = [];
    let groupIndex = 0;
    for (const [key, elements] of groupMap.entries()) {
      if (!elements || elements.length === 0) continue;
      const [kind] = key.split(":");
      const first = elements[0];
      const fieldset = first.closest('fieldset');
      const legend = fieldset?.querySelector('legend')?.innerText?.trim();
      const containerEl = first.closest('section, div, form, table') || block;
      const heading = containerEl.querySelector('h1,h2,h3,h4,strong,b')?.innerText?.trim();
      const question = legend || heading || getLabelForElement(first) || '';
      const groupId = `sel:${kind}:${groupIndex++}`;
      const options = elements.map((el, i) => {
        const optId = generateFieldId(el, i);
        el.setAttribute('data-autoanswer-id', optId);
        el.setAttribute('data-autoanswer-group', groupId);
        const label = getLabelForElement(el) || el.value || `Option ${i + 1}`;
        return { id: optId, label };
      });
      choiceGroups.push({ groupId, groupType: kind === 'radio' ? 'radio' : 'checkbox', question, options });
    }
    if (choiceGroups.length === 0) return { ok: false };

    const selectionText = (block.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
    const response = await chrome.runtime.sendMessage({ type: 'callAiChoicesForSelection', selectionText, groups: choiceGroups });
    if (!response?.ok) throw new Error(response?.error || 'AI selection request failed');
    const choices = response.choices || {};
    const fillRes = await fillAnswers({ choices }, { skipSubmit });
    return { ok: fillRes.filled > 0 };
  } catch (_) {
    return { ok: false };
  }
}

/**
 * If no selection exists, try to detect the most relevant visible choice group near viewport center.
 */
async function fillViewportChoicesIfAny(skipSubmit = false) {
  try {
    const { choiceGroups } = collectSchema();
    if (!choiceGroups || choiceGroups.length === 0) return { ok: false };

    // Map groupId -> first option element to compute position
    const groupInfo = choiceGroups.map((g) => {
      const firstOptId = g.options?.[0]?.id;
      const el = firstOptId ? document.querySelector(`[data-autoanswer-id="${CSS.escape(firstOptId)}"]`) : null;
      const rect = el?.getBoundingClientRect();
      return { group: g, el, rect };
    }).filter(x => x.el && x.rect && isVisible(x.el));
    if (groupInfo.length === 0) return { ok: false };

    const viewportCenter = window.innerHeight / 2;
    groupInfo.sort((a, b) => {
      const da = Math.abs((a.rect.top + a.rect.bottom) / 2 - viewportCenter);
      const db = Math.abs((b.rect.top + b.rect.bottom) / 2 - viewportCenter);
      return da - db;
    });
    const best = groupInfo[0];
    if (!best) return { ok: false };

    // Build a concise context from the group's container (column) side
    const block = best.el.closest('fieldset, section, article, li, div, form, table') || document.body;
    const selectionText = (block.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
    const response = await chrome.runtime.sendMessage({ type: 'callAiChoicesForSelection', selectionText, groups: [best.group] });
    if (!response?.ok) throw new Error(response?.error || 'AI viewport selection request failed');
    const choices = response.choices || {};
    const fillRes = await fillAnswers({ choices }, { skipSubmit });
    return { ok: fillRes.filled > 0 };
  } catch (_) {
    return { ok: false };
  }
}

// Listen for messages (from popup or background)
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message?.type === "captureAndFill") {
      try {
        // Prefer selection-based MCQ, then focused text, then full page
        const selResult = await fillSelectionChoicesIfAny(!!message.skipSubmit);
        if (selResult.ok) {
          sendResponse({ ok: true, result: { filled: 1, submitted: false } });
          return;
        }
        const viewResult = await fillViewportChoicesIfAny(!!message.skipSubmit);
        if (viewResult.ok) {
          sendResponse({ ok: true, result: { filled: 1, submitted: false } });
          return;
        }
        const focusedResult = await fillFocusedFieldIfAny();
        const result = focusedResult.ok ? { filled: 1, submitted: false } : await captureAndFill(message.includeScreenshot, !!message.skipSubmit);
        sendResponse({ ok: true, result });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
      return;
    }
  })();
  return true; // async
});


