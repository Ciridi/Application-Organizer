/* =========================================================
   Stepping Stones - Front-end / bug-test UI build

   IMPORTANT:
   Keep your CURRENT Supabase URL and publishable key below
   when merging this file into the working project.
   ========================================================= */

const CONFIG = {
  SUPABASE_URL: "https://jjrvymojfidmhcawxfjx.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_qgIZCyB101ZjmGCAhP283w_JHc4mQts",

  EXTRACT_FUNCTION: "extract-job",
  GOOGLE_SHEETS_FUNCTION: "google-sheets",
  SHEET_TITLE: "Stepping Stones - Job Applications",
  GOOGLE_SCOPES: "https://www.googleapis.com/auth/drive.file"
};

const STATUS_OPTIONS = [
  "Saved",
  "Applied",
  "Interview",
  "Offer",
  "Rejected",
  "Withdrawn"
];

const APPLICATION_SELECT =
  "id, user_id, company, position, status, date_applied, location, salary, job_url, source, notes, created_at";

const state = {
  supabase: null,
  session: null,
  user: null,
  currentJobUrl: null,
  editingApplicationId: null,
  applications: [],
  spreadsheetId: null,
  spreadsheetUrl: null,
  forceSyncRunning: false
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
const forceSyncButton = document.getElementById("forceSyncButton");
const syncDebugId = document.getElementById("syncDebugId");

const extractForm = document.getElementById("extractForm");
const jobUrlInput = document.getElementById("jobUrl");
const extractButton = document.getElementById("extractButton");

const resultPanel = document.getElementById("resultPanel");
const confidenceBadge = document.getElementById("confidenceBadge");
const reviewEyebrow = document.getElementById("reviewEyebrow");
const reviewTitle = document.getElementById("reviewTitle");
const reviewDescription = document.getElementById("reviewDescription");

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
  forceSyncButton.addEventListener("click", handleForceSync);
  recentJobsBody.addEventListener("change", handleApplicationTableChange);
  recentJobsBody.addEventListener("click", handleApplicationTableClick);

  if (!window.supabase?.createClient) {
    setStatus(loginStatus, "Supabase could not load. Check your internet connection.", "error");
    return;
  }

  if (!hasSupabaseConfig()) {
    setStatus(
      loginStatus,
      "Add your existing Supabase project URL and publishable key in app.js.",
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

  state.supabase.auth.onAuthStateChange((event, session) => {
    window.setTimeout(() => {
      handleAuthStateChange(event, session).catch((error) => {
        console.error("[auth] state error:", error);
      });
    }, 0);
  });

  const {
    data: { session },
    error
  } = await state.supabase.auth.getSession();

  if (error) {
    console.error("[auth] restore failed:", error);
    setStatus(loginStatus, "Could not restore your session.", "error");
    return;
  }

  if (session) {
    await enterApplication(session);
  }
}

// -----------------------------
// Authentication
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
      queryParams: {
        access_type: "offline",
        prompt: "consent"
      }
    }
  });

  if (error) {
    console.error("[auth] google sign-in failed:", error);
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

  await Promise.all([loadApplications(), loadSheetSettings()]);
}

async function handleLogout() {
  if (!state.supabase) return;

  const { error } = await state.supabase.auth.signOut();

  if (error) {
    console.error("[auth] sign-out failed:", error);
    return;
  }

  leaveApplication();
}

function leaveApplication() {
  state.session = null;
  state.user = null;
  state.currentJobUrl = null;
  state.editingApplicationId = null;
  state.applications = [];
  state.spreadsheetId = null;
  state.spreadsheetUrl = null;
  state.forceSyncRunning = false;

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
    .select(APPLICATION_SELECT)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    console.error("[applications] load failed:", error);
    state.applications = [];
    renderApplications(
      "Could not load applications. Confirm table grants and RLS policies."
    );
    return;
  }

  state.applications = data || [];
  renderApplications();
}

function applicationPayload(job) {
  return {
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
}

async function saveApplicationToSupabase(job) {
  const { data, error } = await state.supabase
    .from("applications")
    .insert(applicationPayload(job))
    .select(APPLICATION_SELECT)
    .single();

  if (error) {
    throw new Error(error.message || "Supabase could not save this application.");
  }

  return data;
}

async function updateApplicationInSupabase(applicationId, job) {
  const payload = applicationPayload(job);

  // user_id is already fixed on the row and does not need to be reassigned.
  delete payload.user_id;

  const { data, error } = await state.supabase
    .from("applications")
    .update(payload)
    .eq("id", applicationId)
    .eq("user_id", state.user.id)
    .select(APPLICATION_SELECT)
    .single();

  if (error) {
    throw new Error(error.message || "Supabase could not update this application.");
  }

  return data;
}

async function updateApplicationStatus(applicationId, newStatus) {
  const { data, error } = await state.supabase
    .from("applications")
    .update({ status: newStatus })
    .eq("id", applicationId)
    .eq("user_id", state.user.id)
    .select(APPLICATION_SELECT)
    .single();

  if (error) {
    throw new Error(error.message || "Could not update application status.");
  }

  return data;
}

async function deleteApplicationFromSupabase(applicationId) {
  const { error } = await state.supabase
    .from("applications")
    .delete()
    .eq("id", applicationId)
    .eq("user_id", state.user.id);

  if (error) {
    throw new Error(error.message || "Could not delete this application.");
  }
}

// -----------------------------
// Google Sheets handoff
// -----------------------------

async function setupGoogleSheets(session) {
  setSheetStatus("Preparing your Google Sheets connection...");
  clearDebugId();

  const response = await invokeSheets({
    action: "setup",
    providerToken: session.provider_token,
    providerRefreshToken: session.provider_refresh_token || null,
    sheetTitle: CONFIG.SHEET_TITLE
  });

  if (!response.ok) {
    console.warn("[sheets] setup failed:", response);
    showSheetFailure(
      response,
      "Google Sheets setup failed. Supabase data is still available."
    );
    sheetName.textContent = "Setup required";
    return;
  }

  const data = response.data || {};

  if (data.spreadsheetId) {
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
    console.warn("[sheets] settings load failed:", error);
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
    return { synced: false, reason: "no-sheet" };
  }

  const response = await invokeSheets({
    action: "sync",
    applicationId
  });

  if (!response.ok) {
    console.warn("[sheets] single-row sync failed:", response);
    return {
      synced: false,
      reason: "sync-error",
      ...response
    };
  }

  return { synced: true, data: response.data };
}

/*
  Bug-test sync:
  This intentionally runs even if nothing has changed. The server clears the
  application rows and rewrites them from Supabase so you can repeatedly test
  the Google OAuth/Sheets path without adding a fake application.
*/
async function handleForceSync() {
  if (state.forceSyncRunning) return;

  if (!state.spreadsheetId) {
    setSheetStatus("Google Sheets is not connected yet.", "error");
    return;
  }

  state.forceSyncRunning = true;
  setForceSyncLoading(true);
  setSheetStatus("Force syncing every application...");
  clearDebugId();

  try {
    const response = await forceSyncAllApplications();

    if (!response.ok) {
      showSheetFailure(response, "Force sync failed.");
      return;
    }

    const count = Number(response.data?.rowCount || 0);
    setSheetStatus(
      `Force sync complete. Rewrote ${count} application${count === 1 ? "" : "s"}.`,
      "success"
    );

    showDebugId(response.data?.debugId);

    // Reload so local UI exactly matches the database snapshot just synced.
    await loadApplications();
  } finally {
    state.forceSyncRunning = false;
    setForceSyncLoading(false);
  }
}

async function forceSyncAllApplications({ quiet = false } = {}) {
  if (!state.spreadsheetId) {
    return { ok: false, reason: "no-sheet" };
  }

  const response = await invokeSheets({
    action: "sync-all",
    force: true
  });

  if (!quiet && !response.ok) {
    showSheetFailure(response, "Google Sheets reconciliation failed.");
  }

  return response;
}

async function invokeSheets(body) {
  if (!state.supabase) {
    return {
      ok: false,
      message: "Supabase is not initialized.",
      stage: "frontend",
      debugId: null
    };
  }

  try {
    const { data, error } = await state.supabase.functions.invoke(
      CONFIG.GOOGLE_SHEETS_FUNCTION,
      { body }
    );

    if (error) {
      const context = await readFunctionErrorContext(error);

      return {
        ok: false,
        message:
          context?.message ||
          error.message ||
          "Google Sheets function request failed.",
        stage: context?.stage || "edge-function",
        debugId: context?.debugId || null,
        status: error.context?.status || null,
        details: context
      };
    }

    if (data?.ok === false) {
      return {
        ok: false,
        message: data.message || "Google Sheets operation failed.",
        stage: data.stage || "unknown",
        debugId: data.debugId || null,
        details: data
      };
    }

    return {
      ok: true,
      data: data || {}
    };
  } catch (error) {
    return {
      ok: false,
      message: error?.message || "Google Sheets request failed.",
      stage: "frontend-exception",
      debugId: null
    };
  }
}

async function readFunctionErrorContext(error) {
  try {
    if (!error?.context) return null;

    // supabase-js FunctionsHttpError exposes a Response as .context.
    if (typeof error.context.json === "function") {
      return await error.context.clone().json();
    }
  } catch (parseError) {
    console.warn("[sheets] could not parse function error body:", parseError);
  }

  return null;
}

function showSheetFailure(response, fallbackMessage) {
  const stage = response?.stage ? ` [${response.stage}]` : "";
  const message = response?.message || fallbackMessage;

  setSheetStatus(`${message}${stage}`, "error");
  showDebugId(response?.debugId);

  console.warn("[sheets-debug]", {
    stage: response?.stage || null,
    debugId: response?.debugId || null,
    status: response?.status || null,
    details: response?.details || null
  });
}

function showDebugId(debugId) {
  if (!debugId) {
    clearDebugId();
    return;
  }

  syncDebugId.textContent = `debug ${debugId}`;
  syncDebugId.classList.remove("hidden");
}

function clearDebugId() {
  syncDebugId.textContent = "";
  syncDebugId.classList.add("hidden");
}

function setSpreadsheet(id, url, title) {
  state.spreadsheetId = id;
  state.spreadsheetUrl =
    url || `https://docs.google.com/spreadsheets/d/${id}/edit`;

  sheetName.textContent = title || CONFIG.SHEET_TITLE;
  sheetLink.href = state.spreadsheetUrl;
  sheetLink.classList.remove("hidden");
  forceSyncButton.disabled = false;

  setSheetStatus("Connected and ready to sync.", "success");
}

function resetSheetCard() {
  state.spreadsheetId = null;
  state.spreadsheetUrl = null;

  sheetName.textContent = "Setup required";
  sheetLink.href = "#";
  sheetLink.classList.add("hidden");
  forceSyncButton.disabled = true;
  clearDebugId();

  setSheetStatus(
    "Supabase is connected. Google Sheets setup is still required."
  );
}

function setSheetStatus(message, type = "") {
  sheetStatus.textContent = message;
  sheetStatus.classList.remove("success", "error");

  if (type) {
    sheetStatus.classList.add(type);
  }
}

function setForceSyncLoading(isLoading) {
  forceSyncButton.disabled = isLoading || !state.spreadsheetId;
  forceSyncButton.classList.toggle("is-spinning", isLoading);
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

  state.editingApplicationId = null;
  state.currentJobUrl = url;

  setLoading(extractButton, true, "Extracting...");
  setStatus(extractStatus, "Reading the job posting...");

  try {
    const extracted = await requestJobExtraction(url);
    fillJobForm(extracted, url);
    setCreateReviewMode();

    resultPanel.classList.remove("hidden");
    resultPanel.scrollIntoView({ behavior: "smooth", block: "start" });

    setStatus(
      extractStatus,
      "Job details extracted. Review them before saving.",
      "success"
    );
  } catch (error) {
    console.error("[extract] failed:", error);

    const fallback = createUrlHeuristicFallback(url);
    fillJobForm(fallback, url);
    setCreateReviewMode();

    resultPanel.classList.remove("hidden");

    setStatus(
      extractStatus,
      "Parser could not finish. A basic URL guess was created for manual review.",
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
    { body: { url } }
  );

  if (error) throw error;

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
  statusInput.value = STATUS_OPTIONS.includes(job.status) ? job.status : "Saved";
  dateAppliedInput.value = job.date_applied || job.dateApplied || "";
  sourceInput.value = job.source || "";
  notesInput.value = job.notes || "";

  state.currentJobUrl = url || job.job_url || "";
  reviewUrl.textContent = state.currentJobUrl;
  reviewUrl.href = state.currentJobUrl || "#";

  updateConfidenceBadge(job.confidence);
}

function updateConfidenceBadge(confidence) {
  if (state.editingApplicationId) {
    confidenceBadge.textContent = "Editing saved application";
    return;
  }

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
// Create / edit confirmed job
// -----------------------------

async function handleSaveJob(event) {
  event.preventDefault();

  if (!state.user || !state.supabase) {
    setStatus(saveStatus, "Sign in before saving an application.", "error");
    return;
  }

  if (!state.currentJobUrl) {
    setStatus(saveStatus, "An original job URL is required.", "error");
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

  const editingId = state.editingApplicationId;

  setLoading(saveButton, true, editingId ? "Updating..." : "Saving...");
  setStatus(
    saveStatus,
    editingId ? "Updating application..." : "Saving application to Stepping Stones..."
  );

  try {
    if (editingId) {
      const updated = await updateApplicationInSupabase(editingId, job);
      replaceApplicationInState(updated);
      renderApplications();

      const syncResult = await forceSyncAllApplications({ quiet: true });

      if (syncResult.ok) {
        setStatus(
          saveStatus,
          "Application updated and Google Sheets reconciled.",
          "success"
        );
      } else {
        setStatus(
          saveStatus,
          "Application updated in Stepping Stones. Google Sheets reconciliation failed.",
          "success"
        );
        showSheetFailure(syncResult, "Google Sheets reconciliation failed.");
      }
    } else {
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
          "Application saved to Stepping Stones. Google Sheets is not configured yet.",
          "success"
        );
      } else {
        setStatus(
          saveStatus,
          "Application saved to Stepping Stones, but Google Sheets could not sync.",
          "success"
        );
        showSheetFailure(syncResult, "Google Sheets sync failed.");
      }
    }

    window.setTimeout(() => {
      resetJobForm();
      jobUrlInput.focus();
    }, 650);
  } catch (error) {
    console.error("[applications] save/update failed:", error);
    setStatus(
      saveStatus,
      error.message || "Could not save the application.",
      "error"
    );
  } finally {
    setLoading(
      saveButton,
      false,
      state.editingApplicationId ? "Update Application" : "Save Application"
    );
  }
}

function replaceApplicationInState(updated) {
  const index = state.applications.findIndex((job) => job.id === updated.id);

  if (index >= 0) {
    state.applications[index] = updated;
  } else {
    state.applications.unshift(updated);
  }
}

// -----------------------------
// Application table interactions
// -----------------------------

async function handleApplicationTableChange(event) {
  const select = event.target.closest("[data-status-application-id]");
  if (!select) return;

  const applicationId = select.dataset.statusApplicationId;
  const previous = state.applications.find((job) => job.id === applicationId);

  if (!previous) return;

  const previousStatus = previous.status;
  const nextStatus = select.value;

  if (nextStatus === previousStatus) return;

  select.disabled = true;

  try {
    const updated = await updateApplicationStatus(applicationId, nextStatus);
    replaceApplicationInState(updated);

    // Reconcile after status changes so the sheet reflects the edited record,
    // rather than relying on the append-only single-row sync behavior.
    const syncResult = await forceSyncAllApplications({ quiet: true });

    if (!syncResult.ok && state.spreadsheetId) {
      showSheetFailure(
        syncResult,
        `Status changed to ${nextStatus}, but Google Sheets did not reconcile.`
      );
    } else if (syncResult.ok) {
      setSheetStatus(
        `Status changed to ${nextStatus}. Google Sheets is current.`,
        "success"
      );
    }
  } catch (error) {
    console.error("[applications] status update failed:", error);
    select.value = previousStatus;
    setSheetStatus(error.message || "Could not update status.", "error");
  } finally {
    select.disabled = false;
  }
}

async function handleApplicationTableClick(event) {
  const editButton = event.target.closest("[data-edit-application-id]");
  if (editButton) {
    openApplicationEditor(editButton.dataset.editApplicationId);
    return;
  }

  const deleteButton = event.target.closest("[data-delete-application-id]");
  if (deleteButton) {
    await handleDeleteApplication(
      deleteButton.dataset.deleteApplicationId,
      deleteButton
    );
  }
}

function openApplicationEditor(applicationId) {
  const application = state.applications.find(
    (job) => job.id === applicationId
  );

  if (!application) return;

  state.editingApplicationId = application.id;
  state.currentJobUrl = application.job_url || "";

  fillJobForm(
    {
      ...application,
      confidence: null
    },
    application.job_url
  );

  setEditReviewMode();
  extractStatus.textContent = "";
  saveStatus.textContent = "";

  resultPanel.classList.remove("hidden");
  resultPanel.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function handleDeleteApplication(applicationId, button) {
  const application = state.applications.find(
    (job) => job.id === applicationId
  );

  if (!application) return;

  const confirmed = window.confirm(
    `Delete ${application.position} at ${application.company}?`
  );

  if (!confirmed) return;

  button.disabled = true;

  try {
    await deleteApplicationFromSupabase(applicationId);

    state.applications = state.applications.filter(
      (job) => job.id !== applicationId
    );
    renderApplications();

    if (state.editingApplicationId === applicationId) {
      resetJobForm();
    }

    const syncResult = await forceSyncAllApplications({ quiet: true });

    if (!syncResult.ok && state.spreadsheetId) {
      showSheetFailure(
        syncResult,
        "Application deleted in Stepping Stones, but Google Sheets did not reconcile."
      );
    } else if (syncResult.ok) {
      setSheetStatus(
        "Application deleted. Google Sheets is current.",
        "success"
      );
    }
  } catch (error) {
    console.error("[applications] delete failed:", error);
    setSheetStatus(error.message || "Could not delete application.", "error");
    button.disabled = false;
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

function setCreateReviewMode() {
  state.editingApplicationId = null;
  reviewEyebrow.textContent = "STEP 2";
  reviewTitle.textContent = "Review extracted details";
  reviewDescription.textContent =
    "Everything below is editable before it is saved.";
  saveButton.textContent = "Save Application";
}

function setEditReviewMode() {
  reviewEyebrow.textContent = "EDIT APPLICATION";
  reviewTitle.textContent = "Modify tracked application";
  reviewDescription.textContent =
    "This is the same review form used after extracting a job link.";
  confidenceBadge.textContent = "Editing saved application";
  saveButton.textContent = "Update Application";
}

function resetJobForm() {
  jobForm.reset();
  extractForm.reset();

  state.currentJobUrl = null;
  state.editingApplicationId = null;

  reviewUrl.textContent = "";
  reviewUrl.href = "#";

  resultPanel.classList.add("hidden");

  extractStatus.textContent = "";
  saveStatus.textContent = "";
  confidenceBadge.textContent = "Review required";
  setCreateReviewMode();
}

function renderApplications(errorMessage = "") {
  if (errorMessage) {
    recentJobsBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="6">${escapeHtml(errorMessage)}</td>
      </tr>
    `;
    return;
  }

  if (!state.applications.length) {
    recentJobsBody.innerHTML = `
      <tr class="empty-row">
        <td colspan="6">No applications tracked yet.</td>
      </tr>
    `;
    return;
  }

  recentJobsBody.innerHTML = state.applications
    .map((job) => {
      const safeId = escapeHtml(job.id);
      const safeCompany = escapeHtml(job.company);
      const safePosition = escapeHtml(job.position);
      const safeDate = escapeHtml(job.date_applied || "—");
      const safeLocation = escapeHtml(job.location || "—");
      const safeLabel = escapeHtml(`${job.position} at ${job.company}`);

      const statusOptions = STATUS_OPTIONS.map((status) => {
        const selected = status === job.status ? " selected" : "";
        return `<option value="${escapeHtml(status)}"${selected}>${escapeHtml(status)}</option>`;
      }).join("");

      return `
        <tr class="application-row" data-application-id="${safeId}">
          <td>${safeCompany}</td>
          <td>${safePosition}</td>
          <td>
            <select
              class="row-status-select"
              data-status-application-id="${safeId}"
              aria-label="Status for ${safeLabel}"
            >
              ${statusOptions}
            </select>
          </td>
          <td>${safeDate}</td>
          <td>${safeLocation}</td>
          <td class="row-actions-cell">
            <span class="row-actions">
              <button
                type="button"
                class="icon-button row-action-icon"
                data-edit-application-id="${safeId}"
                aria-label="Edit ${safeLabel}"
                title="Edit"
              >✎</button>

              <button
                type="button"
                class="icon-button row-action-icon delete"
                data-delete-application-id="${safeId}"
                aria-label="Delete ${safeLabel}"
                title="Delete"
              >⌫</button>
            </span>
          </td>
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
  try {
    return decodeURIComponent(value)
      .replace(/[-_+]/g, " ")
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/\b\w/g, (char) => char.toUpperCase())
      .trim();
  } catch {
    return String(value || "")
      .replace(/[-_+]/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase())
      .trim();
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
