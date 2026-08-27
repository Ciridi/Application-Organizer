/* =========================================================
   Stepping Stones - Front-end
   ---------------------------------------------------------
   Current architecture:
   - Supabase Auth owns the user session
   - Google is the OAuth provider
   - Supabase Postgres is the primary application database
   - Supabase RLS keeps each user's rows private
   - Supabase Edge Functions are the server-side boundary for:
       1. job URL extraction
       2. Google Sheets setup/sync

   IMPORTANT:
   The values below are safe to use in browser JavaScript:
   - Supabase project URL
   - Supabase publishable key

   NEVER place these in this file:
   - Supabase service_role key
   - Google OAuth client secret
   - Google refresh tokens
   ========================================================= */

// -----------------------------
// Configuration
// -----------------------------

const CONFIG = {
  // Supabase Dashboard -> Project Settings / API
  SUPABASE_URL: "https://YOUR_PROJECT_REF.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "YOUR_SUPABASE_PUBLISHABLE_KEY",

  // Edge Function names that will be created next.
  EXTRACT_FUNCTION: "extract-job",
  GOOGLE_SHEETS_FUNCTION: "google-sheets",

  SHEET_TITLE: "Stepping Stones - Job Applications",

  // drive.file limits access to files created/opened for this app rather
  // than requesting access to the user's entire Google Drive.
  GOOGLE_SCOPES: "https://www.googleapis.com/auth/drive.file"
};

// -----------------------------
// Application state
// -----------------------------

const state = {
  supabase: null,
  session: null,
  user: null,
  currentJobUrl: null,
  applications: [],
  spreadsheetId: null,
  spreadsheetUrl: null
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
const sheetStatus = document.getElementById("sheetStatus");
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

window.addEventListener("load", initializeApp);

async function initializeApp() {
  googleLoginButton.addEventListener("click", handleGoogleLogin);
  logoutButton.addEventListener("click", handleLogout);
  extractForm.addEventListener("submit", handleExtract);
  jobForm.addEventListener("submit", handleSaveJob);
  cancelButton.addEventListener("click", resetJobForm);

  if (!window.supabase?.createClient) {
    setStatus(
      loginStatus,
      "Supabase could not load. Check your internet connection.",
      "error"
    );
    return;
  }

  if (!hasSupabaseConfig()) {
    setStatus(
      loginStatus,
      "Add your Supabase project URL and publishable key in app.js.",
      "error"
    );
    return;
  }

  state.supabase = window.supabase.createClient(
    CONFIG.SUPABASE_URL,
    CONFIG.SUPABASE_PUBLISHABLE_KEY,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    }
  );

  /*
    OAuth returns to this page after Google sign-in.
    Register the listener immediately after createClient so provider tokens
    can be handed to the server-side Google Sheets function when available.
  */
  state.supabase.auth.onAuthStateChange((event, session) => {
    window.setTimeout(() => {
      handleAuthStateChange(event, session).catch((error) => {
        console.error("Auth state error:", error);
      });
    }, 0);
  });

  const {
    data: { session },
    error
  } = await state.supabase.auth.getSession();

  if (error) {
    console.error(error);
    setStatus(loginStatus, "Could not restore your session.", "error");
    return;
  }

  if (session) {
    await enterApplication(session);
  }
}

// -----------------------------
// Supabase authentication
// -----------------------------

async function handleGoogleLogin() {
  if (!state.supabase) {
    setStatus(loginStatus, "Supabase has not been configured yet.", "error");
    return;
  }

  setLoading(googleLoginButton, true, "Opening Google...");

  const { error } = await state.supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: window.location.origin,
      scopes: CONFIG.GOOGLE_SCOPES,

      // Google does not return a refresh token by default.
      // These parameters request offline access so the secure Edge Function
      // can refresh Google API access later without exposing secrets here.
      queryParams: {
        access_type: "offline",
        prompt: "consent"
      }
    }
  });

  if (error) {
    console.error(error);
    setStatus(loginStatus, error.message || "Google sign-in failed.", "error");
    setLoading(googleLoginButton, false, "Continue with Google");
  }
}

async function handleAuthStateChange(event, session) {
  if (event === "SIGNED_OUT" || !session) {
    leaveApplication();
    return;
  }

  if (
    event === "SIGNED_IN" ||
    event === "INITIAL_SESSION" ||
    event === "TOKEN_REFRESHED"
  ) {
    await enterApplication(session);

    /*
      provider_token/provider_refresh_token are Google credentials, not
      Supabase database credentials. If they are available, send them once
      to a trusted Edge Function. The function should store/refresh them
      server-side and create the user's sheet.

      If that Edge Function has not been created yet, the application still
      works; Supabase remains the primary database.
    */
    if (session.provider_token) {
      await setupGoogleSheets(session);
    }
  }
}

async function enterApplication(session) {
  state.session = session;
  state.user = session.user;

  renderUser();
  showApplication();

  await Promise.all([
    loadApplications(),
    loadSheetSettings()
  ]);
}

async function handleLogout() {
  if (!state.supabase) return;

  const { error } = await state.supabase.auth.signOut();

  if (error) {
    console.error(error);
    return;
  }

  leaveApplication();
}

function leaveApplication() {
  state.session = null;
  state.user = null;
  state.currentJobUrl = null;
  state.applications = [];
  state.spreadsheetId = null;
  state.spreadsheetUrl = null;

  resetJobForm();
  renderApplications();
  resetSheetCard();

  appShell.classList.add("hidden");
  loginScreen.classList.remove("hidden");

  setLoading(googleLoginButton, false, "Continue with Google");
}

function renderUser() {
  if (!state.user) return;

  const metadata = state.user.user_metadata || {};
  const displayName =
    metadata.full_name ||
    metadata.name ||
    state.user.email?.split("@")[0] ||
    "Stepping Stones User";

  userName.textContent = displayName;
  userEmail.textContent = state.user.email || "Connected";

  const avatarUrl = metadata.avatar_url || metadata.picture;

  if (avatarUrl) {
    userAvatar.textContent = "";
    userAvatar.style.backgroundImage = `url("${avatarUrl}")`;
    userAvatar.style.backgroundSize = "cover";
    userAvatar.style.backgroundPosition = "center";
  } else {
    userAvatar.style.backgroundImage = "";
    userAvatar.textContent = displayName.charAt(0).toUpperCase();
  }
}

// -----------------------------
// Supabase application database
// -----------------------------

async function loadApplications() {
  if (!state.supabase || !state.user) return;

  const { data, error } = await state.supabase
    .from("applications")
    .select(
      "id, user_id, company, position, status, date_applied, location, salary, job_url, source, notes, created_at"
    )
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    console.error("Could not load applications:", error);
    state.applications = [];
    renderApplications(
      "Could not load applications. Confirm the table, grants, and RLS policies are configured."
    );
    return;
  }

  state.applications = data || [];
  renderApplications();
}

async function saveApplicationToSupabase(job) {
  const payload = {
    user_id: state.user.id,
    company: job.company,
    position: job.position,
    status: job.status,
    date_applied: job.dateApplied || null,
    location: job.location || null,
    salary: job.salary || null,
    job_url: job.url,
    source: job.source || null,
    notes: job.notes || null
  };

  const { data, error } = await state.supabase
    .from("applications")
    .insert(payload)
    .select(
      "id, user_id, company, position, status, date_applied, location, salary, job_url, source, notes, created_at"
    )
    .single();

  if (error) {
    throw new Error(error.message || "Supabase could not save this application.");
  }

  return data;
}

// -----------------------------
// Google Sheets server-side handoff
// -----------------------------

async function setupGoogleSheets(session) {
  setSheetStatus("Preparing your Google Sheets connection...");

  const { data, error } = await state.supabase.functions.invoke(
    CONFIG.GOOGLE_SHEETS_FUNCTION,
    {
      body: {
        action: "setup",
        providerToken: session.provider_token,
        providerRefreshToken: session.provider_refresh_token || null,
        sheetTitle: CONFIG.SHEET_TITLE
      }
    }
  );

  /*
    The Edge Function is intentionally optional at this stage.
    Until it exists, database/authentication features continue working.
  */
  if (error) {
    console.warn("Google Sheets setup function is not ready:", error);
    setSheetStatus(
      "Supabase is connected. Create the google-sheets Edge Function to enable spreadsheet sync.",
      "error"
    );
    sheetName.textContent = "Setup required";
    return;
  }

  if (data?.spreadsheetId) {
    setSpreadsheet(
      data.spreadsheetId,
      data.spreadsheetUrl,
      data.sheetTitle || CONFIG.SHEET_TITLE
    );
  } else {
    await loadSheetSettings();
  }
}

async function loadSheetSettings() {
  if (!state.supabase || !state.user) return;

  const { data, error } = await state.supabase
    .from("user_settings")
    .select("google_sheet_id, google_sheet_url")
    .eq("user_id", state.user.id)
    .maybeSingle();

  if (error) {
    console.warn("Sheet settings are not configured yet:", error);
    resetSheetCard();
    return;
  }

  if (data?.google_sheet_id) {
    setSpreadsheet(
      data.google_sheet_id,
      data.google_sheet_url,
      CONFIG.SHEET_TITLE
    );
  } else {
    resetSheetCard();
  }
}

async function syncApplicationToGoogleSheet(applicationId) {
  if (!state.spreadsheetId) {
    return {
      synced: false,
      reason: "no-sheet"
    };
  }

  const { error } = await state.supabase.functions.invoke(
    CONFIG.GOOGLE_SHEETS_FUNCTION,
    {
      body: {
        action: "sync",
        applicationId
      }
    }
  );

  if (error) {
    console.warn("Application saved, but Google Sheets sync failed:", error);
    return {
      synced: false,
      reason: "sync-error"
    };
  }

  return {
    synced: true
  };
}

function setSpreadsheet(id, url, title) {
  state.spreadsheetId = id;
  state.spreadsheetUrl =
    url || `https://docs.google.com/spreadsheets/d/${id}/edit`;

  sheetName.textContent = title || CONFIG.SHEET_TITLE;
  sheetLink.href = state.spreadsheetUrl;
  sheetLink.classList.remove("hidden");

  setSheetStatus("Connected and ready to sync.", "success");
}

function resetSheetCard() {
  state.spreadsheetId = null;
  state.spreadsheetUrl = null;

  sheetName.textContent = "Setup required";
  sheetLink.href = "#";
  sheetLink.classList.add("hidden");

  setSheetStatus(
    "Supabase is connected. Google Sheets sync is the next server-side setup step."
  );
}

function setSheetStatus(message, type = "") {
  sheetStatus.textContent = message;
  sheetStatus.classList.remove("success", "error");

  if (type) {
    sheetStatus.classList.add(type);
  }
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
      Until the extract-job Edge Function exists, keep the interface usable
      by making a basic guess from the URL. The user can manually correct it.
    */
    const fallback = createUrlHeuristicFallback(url);
    fillJobForm(fallback, url);

    resultPanel.classList.remove("hidden");

    setStatus(
      extractStatus,
      "Parser is not ready yet. A basic URL guess was created for manual review.",
      "error"
    );
  } finally {
    setLoading(extractButton, false, "Extract");
  }
}

async function requestJobExtraction(url) {
  if (!state.supabase) {
    throw new Error("Supabase is not initialized.");
  }

  const { data, error } = await state.supabase.functions.invoke(
    CONFIG.EXTRACT_FUNCTION,
    {
      body: { url }
    }
  );

  if (error) {
    throw error;
  }

  return {
    company: data?.company || "",
    position: data?.position || data?.title || "",
    location: data?.location || "",
    salary: data?.salary || "",
    source: data?.source || detectSourceFromUrl(url),
    confidence:
      typeof data?.confidence === "number" ? data.confidence : null
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

  if (!state.user || !state.supabase) {
    setStatus(saveStatus, "Sign in before saving an application.", "error");
    return;
  }

  if (!state.currentJobUrl) {
    setStatus(saveStatus, "Extract a job URL before saving.", "error");
    return;
  }

  if (!companyInput.value.trim() || !positionInput.value.trim()) {
    setStatus(saveStatus, "Company and position are required.", "error");
    return;
  }

  const job = {
    company: companyInput.value.trim(),
    position: positionInput.value.trim(),
    status: statusInput.value,
    dateApplied: dateAppliedInput.value,
    location: locationInput.value.trim(),
    salary: salaryInput.value.trim(),
    url: state.currentJobUrl,
    source: sourceInput.value.trim(),
    notes: notesInput.value.trim()
  };

  setLoading(saveButton, true, "Saving...");
  setStatus(saveStatus, "Saving application to Stepping Stones...");

  try {
    const savedApplication = await saveApplicationToSupabase(job);

    state.applications.unshift(savedApplication);
    renderApplications();

    const syncResult = await syncApplicationToGoogleSheet(savedApplication.id);

    if (syncResult.synced) {
      setStatus(
        saveStatus,
        "Application saved to Stepping Stones and synced to Google Sheets.",
        "success"
      );
    } else if (syncResult.reason === "no-sheet") {
      setStatus(
        saveStatus,
        "Application saved to Stepping Stones. Google Sheets sync is not configured yet.",
        "success"
      );
    } else {
      setStatus(
        saveStatus,
        "Application saved to Stepping Stones, but Google Sheets could not sync.",
        "success"
      );
    }

    window.setTimeout(() => {
      resetJobForm();
      jobUrlInput.focus();
    }, 850);
  } catch (error) {
    console.error(error);
    setStatus(
      saveStatus,
      error.message || "Could not save the application.",
      "error"
    );
  } finally {
    setLoading(saveButton, false, "Save Application");
  }
}

// -----------------------------
// UI helpers
// -----------------------------

function showApplication() {
  loginScreen.classList.add("hidden");
  appShell.classList.remove("hidden");

  loginStatus.textContent = "";
  setLoading(googleLoginButton, false, "Continue with Google");
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

function renderApplications(errorMessage = "") {
  if (errorMessage) {
    recentJobsBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="5">${escapeHtml(errorMessage)}</td>
      </tr>
    `;
    return;
  }

  if (!state.applications.length) {
    recentJobsBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="5">No applications tracked yet.</td>
      </tr>
    `;
    return;
  }

  recentJobsBody.innerHTML = state.applications
    .map((job) => {
      const safeCompany = escapeHtml(job.company);
      const safePosition = escapeHtml(job.position);
      const safeStatus = escapeHtml(job.status);
      const safeDate = escapeHtml(job.date_applied || "—");
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

function hasSupabaseConfig() {
  return (
    CONFIG.SUPABASE_URL.startsWith("https://") &&
    !CONFIG.SUPABASE_URL.includes("YOUR_PROJECT_REF") &&
    !CONFIG.SUPABASE_PUBLISHABLE_KEY.startsWith("YOUR_")
  );
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
