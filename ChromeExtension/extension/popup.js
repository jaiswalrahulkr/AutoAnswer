// Popup script for AutoAnswer AI

const apiKeyInput = document.getElementById("apiKey");
const autoSubmitCheckbox = document.getElementById("autoSubmit");
const providerSelect = document.getElementById("apiProvider");
// captureFillBtn removed
const statusEl = document.getElementById("status");
const openOptions = document.getElementById("openOptions");
const downloadLogBtn = document.getElementById("downloadLogBtn");
const signInBtn = document.getElementById("googleSignInBtn");
const signOutBtn = document.getElementById("googleSignOutBtn");
const userLabel = document.getElementById("userLabel");
const userAvatar = document.getElementById("userAvatar");
const creditsBox = document.getElementById("creditsBox");
const creditsText = document.getElementById("creditsText");
const outOfCredits = document.getElementById("outOfCredits");
const buySmallBtn = document.getElementById("buySmallBtn");
const buyLargeBtn = document.getElementById("buyLargeBtn");
const openScannerLink = document.getElementById("openScannerLink");
const paymentEmailLink = document.getElementById("paymentEmailLink");
let paymentScannerUrlGlobal = null;
const adminOnly = document.getElementById("adminOnly");
const adminDownload = document.getElementById("adminDownload");
const adminLinkRow = document.getElementById("adminLinkRow");
const openAdmin = document.getElementById("openAdmin");
const nonAdminNote = document.getElementById("nonAdminNote");
const signInNote = document.getElementById("signInNote");

async function loadSettings() {
  const { openaiApiKey, geminiApiKey, autoSubmit, apiProvider } = await chrome.storage.sync.get(["openaiApiKey", "geminiApiKey", "autoSubmit", "apiProvider"]);
  const provider = apiProvider || "openai";
  providerSelect.value = provider;
  apiKeyInput.value = (provider === "gemini" ? geminiApiKey : openaiApiKey) || "";
  autoSubmitCheckbox.checked = !!autoSubmit;

  const { sessionToken } = await chrome.storage.local.get(["sessionToken"]);
  const { paymentScannerUrl, paymentSupportEmail } = await chrome.storage.sync.get(["paymentScannerUrl", "paymentSupportEmail"]);
  if (paymentScannerUrl) openScannerLink.href = paymentScannerUrl;
  paymentScannerUrlGlobal = paymentScannerUrl || null;
  if (paymentSupportEmail) {
    paymentEmailLink.href = `mailto:${paymentSupportEmail}`;
    paymentEmailLink.textContent = paymentSupportEmail;
  }
  if (sessionToken) {
    await refreshCreditsUI();
  } else {
    renderSignedOut();
  }
}

async function saveSettings() {
  const key = apiKeyInput.value.trim();
  const autoSubmit = autoSubmitCheckbox.checked;
  const apiProvider = providerSelect.value;
  const toSet = { autoSubmit, apiProvider };
  if (apiProvider === "gemini") toSet.geminiApiKey = key; else toSet.openaiApiKey = key;
  await chrome.storage.sync.set(toSet);
}

function setStatus(msg, isError = false) {
  statusEl.textContent = msg || "";
  statusEl.style.color = isError ? "#b00020" : "#555";
}

function renderSignedIn(user, balance) {
  userLabel.textContent = user?.email || user?.name || "Signed in";
  if (user?.picture) {
    userAvatar.src = user.picture;
    userAvatar.style.display = "inline-block";
  } else {
    userAvatar.style.display = "none";
  }
  signInBtn.style.display = "none";
  signOutBtn.style.display = "block";
  creditsBox.style.display = "block";
  creditsText.textContent = `Credits: ${balance ?? '-'}`;
  outOfCredits.style.display = balance === 0 ? "block" : "none";
}

function renderSignedOut() {
  userLabel.textContent = "Not signed in";
  userAvatar.style.display = "none";
  signInBtn.style.display = "block";
  signOutBtn.style.display = "none";
  creditsBox.style.display = "none";
  if (typeof nonAdminNote !== 'undefined' && nonAdminNote) {
    nonAdminNote.style.display = "none";
  }
  if (typeof signInNote !== 'undefined' && signInNote) {
    signInNote.style.display = "block";
  }
}

const GOOGLE_CLIENT_ID = "744601763484-d7argg79vb27u163456fen6bvie8cbng.apps.googleusercontent.com"; // set by user
const OAUTH_SCOPES = ["openid", "email", "profile"]; // keep minimal

function buildGoogleAuthUrl(redirectUri, state) {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    response_type: "token", // implicit; backend uses access token with /userinfo
    redirect_uri: redirectUri,
    scope: OAUTH_SCOPES.join(" "),
    include_granted_scopes: "true",
    prompt: "select_account",
    state
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function parseUrlFragment(fragment) {
  const params = new URLSearchParams(fragment.startsWith("#") ? fragment.slice(1) : fragment);
  const obj = {};
  for (const [k, v] of params.entries()) obj[k] = v;
  return obj;
}

async function launchGoogleOAuthInteractive() {
  const redirectUri = chrome.identity.getRedirectURL(); // https://<ext-id>.chromiumapp.org/
  const state = Math.random().toString(36).slice(2) + Date.now();
  const authUrl = buildGoogleAuthUrl(redirectUri, state);
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, (responseUrl) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) return reject(new Error(lastError.message || "Auth failed"));
      if (!responseUrl) return reject(new Error("No redirect URL"));
      try {
        const url = new URL(responseUrl);
        const frag = parseUrlFragment(url.hash || "");
        if (frag.state && frag.state !== state) return reject(new Error("State mismatch"));
        const accessToken = frag.access_token;
        if (!accessToken) return reject(new Error("No access token"));
        resolve({ accessToken, idToken: frag.id_token });
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function backendFetch(path, options = {}) {
  const base = "http://127.0.0.1:3001"; // dev default; replace in production
  const { sessionToken } = await chrome.storage.local.get(["sessionToken"]);
  const headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
  if (sessionToken) headers["Authorization"] = `Bearer ${sessionToken}`;
  const resp = await fetch(base + path, Object.assign({}, options, { headers }));
  if (resp.status === 401) {
    throw new Error("Unauthorized");
  }
  return resp;
}

async function signInWithGoogle() {
  try {
    setStatus("Signing in...");
    const { accessToken } = await launchGoogleOAuthInteractive();
    // Backend accepts this token to call Google userinfo
    const resp = await backendFetch("/auth/google", { method: "POST", body: JSON.stringify({ idToken: accessToken }) });
    if (!resp.ok) throw new Error(`Auth failed ${resp.status}`);
    const data = await resp.json();
    await chrome.storage.local.set({ sessionToken: data.sessionToken });
    await refreshCreditsUI();
    setStatus("Signed in");
    setTimeout(() => setStatus(""), 1200);
  } catch (e) {
    setStatus(String(e), true);
  }
}

async function signOutGoogle() {
  try {
    await chrome.storage.local.remove(["sessionToken"]);
    renderSignedOut();
  } catch (e) {
    setStatus(String(e), true);
  }
}

async function refreshCreditsUI() {
  try {
    const resp = await backendFetch("/user/me", { method: "GET" });
    if (!resp.ok) throw new Error(`User fetch ${resp.status}`);
    const me = await resp.json();
    renderSignedIn(me, me.creditsBalance);
    const isAdmin = !!me.isAdmin;
    adminOnly.style.display = isAdmin ? "block" : "none";
    adminDownload.style.display = isAdmin ? "flex" : "none";
    adminLinkRow.style.display = isAdmin ? "flex" : "none";
    nonAdminNote.style.display = isAdmin ? "none" : "block";
  } catch (e) {
    renderSignedOut();
  }
}

async function initiatePayment(packId) {
  try {
    setStatus("Opening checkout...");
    const resp = await backendFetch("/payment/initiate", { method: "POST", body: JSON.stringify({ packId }) });
    if (!resp.ok) throw new Error(`Payment init ${resp.status}`);
    const { checkoutUrl } = await resp.json();
    await chrome.tabs.create({ url: checkoutUrl });
    setStatus("");
  } catch (e) {
    setStatus(String(e), true);
  }
}

// removed captureFillBtn handler

openOptions.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

apiKeyInput.addEventListener("change", saveSettings);
autoSubmitCheckbox.addEventListener("change", saveSettings);
providerSelect.addEventListener("change", async () => {
  const apiProvider = providerSelect.value;
  await chrome.storage.sync.set({ apiProvider });
  const { openaiApiKey, geminiApiKey } = await chrome.storage.sync.get(["openaiApiKey", "geminiApiKey"]);
  apiKeyInput.value = (apiProvider === "gemini" ? geminiApiKey : openaiApiKey) || "";
});

downloadLogBtn.addEventListener("click", async () => {
  try {
    const { __logBuffer = [] } = await chrome.storage.local.get(["__logBuffer"]);
    const blob = new Blob([JSON.stringify(__logBuffer, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const filename = `autoanswer-log-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    await chrome.downloads.download({ url, filename, saveAs: true });
    setStatus("Log downloaded");
    setTimeout(() => setStatus(""), 1500);
  } catch (e) {
    setStatus(String(e), true);
  }
});

signInBtn.addEventListener("click", signInWithGoogle);
signOutBtn.addEventListener("click", signOutGoogle);
buySmallBtn.addEventListener("click", async (e) => {
  e.preventDefault();
  try {
    // Temporarily prefer showing scanner directly if configured
    if (paymentScannerUrlGlobal) {
      await chrome.tabs.create({ url: paymentScannerUrlGlobal });
      return;
    }
    await initiatePayment("pack_small");
  } catch (_) {
    if (paymentScannerUrlGlobal) {
      await chrome.tabs.create({ url: paymentScannerUrlGlobal });
    }
  }
});
buyLargeBtn.addEventListener("click", async (e) => {
  e.preventDefault();
  try {
    // Temporarily prefer showing scanner directly if configured
    if (paymentScannerUrlGlobal) {
      await chrome.tabs.create({ url: paymentScannerUrlGlobal });
      return;
    }
    await initiatePayment("pack_large");
  } catch (_) {
    if (paymentScannerUrlGlobal) {
      await chrome.tabs.create({ url: paymentScannerUrlGlobal });
    }
  }
});

openAdmin.addEventListener("click", async () => {
  try {
    const base = "http://127.0.0.1:3001"; // align with backend
    const { sessionToken } = await chrome.storage.local.get(["sessionToken"]);
    const url = sessionToken ? `${base}/admin#token=${encodeURIComponent(sessionToken)}` : `${base}/admin`;
    await chrome.tabs.create({ url });
  } catch (_) {}
});

loadSettings();


