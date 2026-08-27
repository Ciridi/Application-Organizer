/* =========================================================
   ApplyTrack - Front-end scaffold
   ---------------------------------------------------------
   What this file already handles:
   - Google OAuth token request
   - Google user profile lookup
   - Per-user Google Sheet creation
   - Header creation
   - Job URL submission to a parser endpoint
   - Editable review form
   - Appending a confirmed job to Google Sheets

   What you still need to configure:
   1. GOOGLE_CLIENT_ID
   2. PARSER_API_URL
   3. Enable Google Sheets API in Google Cloud
   4. Add your site's origin to the Google OAuth client
   ========================================================= */

// -----------------------------
// Configuration
// -----------------------------

const CONFIG = {
  // Replace this with a Google OAuth 2.0 Web Client ID.
  GOOGLE_CLIENT_ID: "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com",

  // Your future backend parser endpoint.
  // Expected request:
  //   POST { url: "https://..." }
  //
  // Expected response:
  // {
  //   company: "...",
  //   position: "...",
  //   location: "...",
  //   salary: "...",
  //   source: "...",
  //   confidence: 0.92
  // }
  PARSER_API_URL: "http://localhost:8000/api/jobs/extract",

  SHEET_TITLE: "ApplyTrack - Job Applications",

  GOOGLE_SCOPES: [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/userinfo.email"
  ].join(" ")
};

const SHEET_HEADERS = [
  "ID",
  "Company",
  "Position",
  "Status",
  "Date Applied",
  "Location",
  "Salary",
  "Job URL",
  "Source",
  "Notes",
  "Created At"
];

// -----------------------------
// Application state
// -----------------------------

const state = {
  accessToken: null,
  tokenClient: null,
  user: null,
  spreadsheetId: null,
  spreadsheetUrl: null,
  currentJobUrl: null,
  recentJobs: []
};

// -----------------------------
// DOM references
// -----------------------------

const loginScreen = document.getElementById("loginScreen");
const appShell = document.getElementById("appShell");

const googleLoginButton = document.getElementById("googleLoginButton");
const logoutButton = document.getElementById("logoutButton");

const loginStatus = document.getElementById("loginStatus");
const extractStatus = document.getElementById("extractStatus");
const saveStatus = document.getElementById("saveStatus");

const userName = document.getElementById("userName");
const userEmail = document.getElementById("userEmail");
const userAvatar = document.getElementById("userAvatar");

const sheetName = document.getElementById("sheetName");
const sheetLink = document.getElementById("sheetLink");

const extractForm = document.getElementById("extractForm");
const jobUrlInput = document.getElementById("jobUrl");
const extractButton = document.getElementById("extractButton");

const resultPanel = document.getElementById("resultPanel");
const confidenceBadge = document.getElementById("confidenceBadge");

const jobForm = document.getElementById("jobForm");
const companyInput = document.getElementById("company");
const positionInput = document.getElementById("position");
const locationInput = document.getElementById("location");
const salaryInput = document.getElementById("salary");
const statusInput = document.getElementById("status");
const dateAppliedInput = document.getElementById("dateApplied");
const sourceInput = document.getElementById("source");
const notesInput = document.getElementById("notes");
const reviewUrl = document.getElementById("reviewUrl");

const saveButton = document.getElementById("saveButton");
const cancelButton = document.getElementById("cancelButton");

const recentJobsBody = document.getElementById("recentJobsBody");

// -----------------------------
// Startup
// -----------------------------

window.addEventListener("load", () => {
  googleLoginButton.addEventListener("click", handleGoogleLogin);
  logoutButton.addEventListener("click", handleLogout);
  extractForm.addEventListener("submit", handleExtract);
  jobForm.addEventListener("submit", handleSaveJob);
  cancelButton.addEventListener("click", resetJobForm);

  // In production, you could initialize Supabase here first.
  //
  // Example future flow:
  //   1. Supabase authenticates the application user.
  //   2. Google OAuth is requested separately when spreadsheet access is needed.
  //
  // initializeSupabaseAuth();

  waitForGoogleIdentityServices();
});

// -----------------------------
// Google authentication
// -----------------------------

function waitForGoogleIdentityServices(attempt = 0) {
  if (window.google?.accounts?.oauth2) {
    initializeGoogleTokenClient();
    return;
  }

  if (attempt > 40) {
    setStatus(
      loginStatus,
      "Google sign-in could not initialize. Check your internet connection.",
      "error"
    );
    return;
  }

  setTimeout(() => waitForGoogleIdentityServices(attempt + 1), 100);
}

function initializeGoogleTokenClient() {
  if (CONFIG.GOOGLE_CLIENT_ID.startsWith("YOUR_")) {
    setStatus(
      loginStatus,
      "Add your Google OAuth Client ID in app.js before testing sign-in.",
      "error"
    );
  }

  state.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    scope: CONFIG.GOOGLE_SCOPES,

    callback: async (response) => {
      if (response.error) {
        setStatus(loginStatus, `Google sign-in failed: ${response.error}`, "error");
        return;
      }

      try {
        state.accessToken = response.access_token;

        setStatus(loginStatus, "Google connected. Loading your workspace...");

        await loadGoogleUser();
        await ensureUserSpreadsheet();

        showApplication();
      } catch (error) {
        console.error(error);
        setStatus(
          loginStatus,
          error.message || "Could not finish Google setup.",
          "error"
        );
      }
    }
  });
}

function handleGoogleLogin() {
  if (!state.tokenClient) {
    setStatus(loginStatus, "Google sign-in is still initializing.", "error");
    return;
  }

  state.tokenClient.requestAccessToken({
    prompt: state.accessToken ? "" : "consent"
  });
}

async function loadGoogleUser() {
  const response = await fetch(
    "https://www.googleapis.com/oauth2/v3/userinfo",
    {
      headers: {
        Authorization: `Bearer ${state.accessToken}`
      }
    }
  );

  if (!response.ok) {
    throw new Error("Could not load your Google profile.");
  }

  state.user = await response.json();

  userName.textContent = state.user.name || "Google User";
  userEmail.textContent = state.user.email || "Connected";

  const firstCharacter = (state.user.name || state.user.email || "U")
    .charAt(0)
    .toUpperCase();

  userAvatar.textContent = firstCharacter;
}

function handleLogout() {
  if (state.accessToken && window.google?.accounts?.oauth2) {
    google.accounts.oauth2.revoke(state.accessToken, () => {});
  }

  state.accessToken = null;
  state.user = null;
  state.spreadsheetId = null;
  state.spreadsheetUrl = null;
  state.currentJobUrl = null;
  state.recentJobs = [];

  appShell.classList.add("hidden");
  loginScreen.classList.remove("hidden");

  resetJobForm();
  renderRecentJobs();
  setStatus(loginStatus, "Signed out.", "success");
}

// -----------------------------
// Google Sheets
// -----------------------------

async function ensureUserSpreadsheet() {
  /*
    For this starter version, the sheet ID is stored using the Google user's
    immutable "sub" identifier in localStorage.

    This works well for a prototype, but for a real multi-device product:
    - store the Google spreadsheetId against the authenticated Supabase user
    - never rely only on browser localStorage
  */

  const storageKey = `applytrack_sheet_${state.user.sub}`;
  const existingId = localStorage.getItem(storageKey);

  if (existingId) {
    const existingSheet = await getSpreadsheet(existingId);

    if (existingSheet) {
      setSpreadsheet(existingSheet.spreadsheetId, existingSheet.properties.title);
      return;
    }

    localStorage.removeItem(storageKey);
  }

  const createdSheet = await createSpreadsheet();

  localStorage.setItem(storageKey, createdSheet.spreadsheetId);

  setSpreadsheet(
    createdSheet.spreadsheetId,
    createdSheet.properties.title
  );

  await writeSheetHeaders();
}

async function getSpreadsheet(spreadsheetId) {
  const response = await googleApiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=spreadsheetId,properties.title`
  );

  if (response.status === 404 || response.status === 403) {
    return null;
  }

  if (!response.ok) {
    throw new Error("Could not access your saved spreadsheet.");
  }

  return response.json();
}

async function createSpreadsheet() {
  const response = await googleApiFetch(
    "https://sheets.googleapis.com/v4/spreadsheets",
    {
      method: "POST",
      body: JSON.stringify({
        properties: {
          title: CONFIG.SHEET_TITLE
        },
        sheets: [
          {
            properties: {
              title: "Applications"
            }
          }
        ]
      })
    }
  );

  if (!response.ok) {
    throw new Error("Could not create your Google Sheet.");
  }

  return response.json();
}

async function writeSheetHeaders() {
  const range = encodeURIComponent("Applications!A1:K1");

  const response = await googleApiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${state.spreadsheetId}/values/${range}?valueInputOption=RAW`,
    {
      method: "PUT",
      body: JSON.stringify({
        range: "Applications!A1:K1",
        majorDimension: "ROWS",
        values: [SHEET_HEADERS]
      })
    }
  );

  if (!response.ok) {
    throw new Error("Spreadsheet created, but column headers could not be written.");
  }
}

async function appendJobToSheet(job) {
  const range = encodeURIComponent("Applications!A:K");

  const response = await googleApiFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${state.spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      body: JSON.stringify({
        values: [
          [
            job.id,
            job.company,
            job.position,
            job.status,
            job.dateApplied,
            job.location,
            job.salary,
            job.url,
            job.source,
            job.notes,
            job.createdAt
          ]
        ]
      })
    }
  );

  if (!response.ok) {
    const details = await safeJson(response);
    console.error("Google Sheets error:", details);
    throw new Error("Google Sheets could not save this application.");
  }

  return response.json();
}

function setSpreadsheet(id, title) {
  state.spreadsheetId = id;
  state.spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${id}/edit`;

  sheetName.textContent = title || CONFIG.SHEET_TITLE;
  sheetLink.href = state.spreadsheetUrl;
  sheetLink.classList.remove("hidden");
}

async function googleApiFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${state.accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
}

// -----------------------------
// Job extraction
// -----------------------------

async function handleExtract(event) {
  event.preventDefault();

  const url = jobUrlInput.value.trim();

  if (!url) {
    setStatus(extractStatus, "Enter a job posting URL.", "error");
    return;
  }

  if (!isValidHttpUrl(url)) {
    setStatus(extractStatus, "Enter a valid http or https URL.", "error");
    return;
  }

  state.currentJobUrl = url;

  setLoading(extractButton, true, "Extracting...");
  setStatus(extractStatus, "Reading the job posting...");

  try {
    const extracted = await requestJobExtraction(url);

    fillJobForm(extracted, url);

    resultPanel.classList.remove("hidden");
    resultPanel.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });

    setStatus(
      extractStatus,
      "Job details extracted. Review them before saving.",
      "success"
    );
  } catch (error) {
    console.error(error);

    /*
      Development fallback:
      If the backend is not running yet, create a rough editable result from
      the URL instead of leaving the interface unusable.

      Remove this fallback in production if you want failed extraction to be
      a hard error.
    */
    const fallback = createUrlHeuristicFallback(url);
    fillJobForm(fallback, url);

    resultPanel.classList.remove("hidden");

    setStatus(
      extractStatus,
      "Parser unavailable. A basic URL guess was created for manual review.",
      "error"
    );
  } finally {
    setLoading(extractButton, false, "Extract");
  }
}

async function requestJobExtraction(url) {
  const response = await fetch(CONFIG.PARSER_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ url })
  });

  if (!response.ok) {
    throw new Error(`Parser returned HTTP ${response.status}`);
  }

  const data = await response.json();

  return {
    company: data.company || "",
    position: data.position || data.title || "",
    location: data.location || "",
    salary: data.salary || "",
    source: data.source || detectSourceFromUrl(url),
    confidence:
      typeof data.confidence === "number" ? data.confidence : null
  };
}

function createUrlHeuristicFallback(url) {
  const parsed = new URL(url);

  const hostname = parsed.hostname
    .replace(/^www\./, "")
    .replace(/^careers\./, "")
    .replace(/^jobs\./, "");

  const companyGuess = formatSlug(hostname.split(".")[0]);

  const pathParts = parsed.pathname
    .split("/")
    .filter(Boolean)
    .filter((part) => !/^\d+$/.test(part));

  const possibleTitle = pathParts.at(-1) || "";

  return {
    company: companyGuess,
    position: formatSlug(possibleTitle),
    location: "",
    salary: "",
    source: detectSourceFromUrl(url),
    confidence: 0.25
  };
}

function detectSourceFromUrl(url) {
  const host = new URL(url).hostname.toLowerCase();

  if (host.includes("linkedin")) return "LinkedIn";
  if (host.includes("greenhouse")) return "Greenhouse";
  if (host.includes("lever")) return "Lever";
  if (host.includes("workday")) return "Workday";
  if (host.includes("indeed")) return "Indeed";
  if (host.includes("handshake")) return "Handshake";

  return "Company Website";
}

function fillJobForm(job, url) {
  companyInput.value = job.company || "";
  positionInput.value = job.position || "";
  locationInput.value = job.location || "";
  salaryInput.value = job.salary || "";
  sourceInput.value = job.source || "";

  statusInput.value = "Saved";
  dateAppliedInput.value = "";
  notesInput.value = "";

  reviewUrl.textContent = url;
  reviewUrl.href = url;

  updateConfidenceBadge(job.confidence);
}

function updateConfidenceBadge(confidence) {
  if (confidence == null) {
    confidenceBadge.textContent = "Review required";
    return;
  }

  const percent = Math.round(confidence * 100);

  if (percent >= 85) {
    confidenceBadge.textContent = `High confidence · ${percent}%`;
  } else if (percent >= 60) {
    confidenceBadge.textContent = `Check details · ${percent}%`;
  } else {
    confidenceBadge.textContent = `Low confidence · ${percent}%`;
  }
}

// -----------------------------
// Save confirmed job
// -----------------------------

async function handleSaveJob(event) {
  event.preventDefault();

  if (!state.spreadsheetId) {
    setStatus(
      saveStatus,
      "No spreadsheet is connected. Sign in with Google again.",
      "error"
    );
    return;
  }

  if (!companyInput.value.trim() || !positionInput.value.trim()) {
    setStatus(saveStatus, "Company and position are required.", "error");
    return;
  }

  const job = {
    id: crypto.randomUUID(),
    company: companyInput.value.trim(),
    position: positionInput.value.trim(),
    status: statusInput.value,
    dateApplied: dateAppliedInput.value,
    location: locationInput.value.trim(),
    salary: salaryInput.value.trim(),
    url: state.currentJobUrl,
    source: sourceInput.value.trim(),
    notes: notesInput.value.trim(),
    createdAt: new Date().toISOString()
  };

  setLoading(saveButton, true, "Saving...");
  setStatus(saveStatus, "Writing application to Google Sheets...");

  try {
    await appendJobToSheet(job);

    state.recentJobs.unshift(job);
    renderRecentJobs();

    setStatus(saveStatus, "Application saved to your spreadsheet.", "success");

    setTimeout(() => {
      resetJobForm();
      jobUrlInput.focus();
    }, 750);
  } catch (error) {
    console.error(error);
    setStatus(
      saveStatus,
      error.message || "Could not save the application.",
      "error"
    );
  } finally {
    setLoading(saveButton, false, "Save to Spreadsheet");
  }
}

// -----------------------------
// UI helpers
// -----------------------------

function showApplication() {
  loginScreen.classList.add("hidden");
  appShell.classList.remove("hidden");
  loginStatus.textContent = "";
}

function resetJobForm() {
  jobForm.reset();
  extractForm.reset();

  state.currentJobUrl = null;

  reviewUrl.textContent = "";
  reviewUrl.href = "#";

  resultPanel.classList.add("hidden");

  extractStatus.textContent = "";
  saveStatus.textContent = "";
  confidenceBadge.textContent = "Review required";
}

function renderRecentJobs() {
  if (!state.recentJobs.length) {
    recentJobsBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="5">No jobs saved during this session yet.</td>
      </tr>
    `;
    return;
  }

  recentJobsBody.innerHTML = state.recentJobs
    .map((job) => {
      const safeCompany = escapeHtml(job.company);
      const safePosition = escapeHtml(job.position);
      const safeStatus = escapeHtml(job.status);
      const safeDate = escapeHtml(job.dateApplied || "—");
      const safeLocation = escapeHtml(job.location || "—");

      return `
        <tr>
          <td>${safeCompany}</td>
          <td>${safePosition}</td>
          <td>${safeStatus}</td>
          <td>${safeDate}</td>
          <td>${safeLocation}</td>
        </tr>
      `;
    })
    .join("");
}

function setStatus(element, message, type = "") {
  element.textContent = message;
  element.classList.remove("error", "success");

  if (type) {
    element.classList.add(type);
  }
}

function setLoading(button, isLoading, label) {
  button.disabled = isLoading;
  button.textContent = label;
}

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function formatSlug(value) {
  return decodeURIComponent(value)
    .replace(/[-_+]/g, " ")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}
