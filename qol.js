/*
  Waystones quality-of-life additions
  -----------------------------------
  Load this file AFTER app.js.

  This stays separate on purpose so the current working application logic,
  Google Sheets sync, Edit, and Remove behavior do not need to be replaced.
*/

(() => {
  const PARSER_RISK_HOSTS = [
    "linkedin.com",
    "indeed.com",
    "glassdoor.com",
    "ziprecruiter.com",
    "joinhandshake.com",
    "handshake.com",
    "monster.com"
  ];

  const SOURCE_WARNING_MESSAGE =
    "The parser had trouble parsing from this source. You can still add it, but some details are incorrect. Remember it's best to apply through the company site!";

  function installStyles() {
    if (document.getElementById("waystonesQolStyles")) return;

    const style = document.createElement("style");
    style.id = "waystonesQolStyles";
    style.textContent = `
      .source-warning {
        max-width: 760px;
        margin-top: 6px;
        line-height: 1.45;
      }

      .actions-heading,
      .row-actions-cell {
        width: 104px;
        min-width: 104px;
      }

      .application-link {
        text-decoration: none;
      }
    `;

    document.head.appendChild(style);
  }

  function installBestPracticeCopy() {
    const heroCopy = document.querySelector(".hero-copy");

    if (!heroCopy) return;

    const sentence = "It is best practice to apply through the company's site.";

    if (heroCopy.textContent.includes(sentence)) return;

    const spacer = document.createTextNode(" ");
    const addition = document.createElement("span");
    addition.className = "best-practice-copy";
    addition.textContent = sentence;

    heroCopy.append(spacer, addition);
  }

  function installSourceWarning() {
    const extractStatus = document.getElementById("extractStatus");

    if (!extractStatus) return null;

    let warning = document.getElementById("sourceWarning");

    if (!warning) {
      warning = document.createElement("p");
      warning.id = "sourceWarning";
      warning.className = "status-message error source-warning hidden";
      warning.setAttribute("aria-live", "polite");
      extractStatus.insertAdjacentElement("afterend", warning);
    }

    return warning;
  }

  function isParserRiskUrl(value) {
    try {
      const hostname = new URL(value).hostname.toLowerCase();

      return PARSER_RISK_HOSTS.some(
        (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
      );
    } catch {
      return false;
    }
  }

  function installParserRiskChecker() {
    const jobUrlInput = document.getElementById("jobUrl");
    const extractForm = document.getElementById("extractForm");
    const sourceWarning = installSourceWarning();

    if (!jobUrlInput || !sourceWarning) return;

    const updateSourceWarning = () => {
      const shouldWarn = isParserRiskUrl(jobUrlInput.value.trim());

      sourceWarning.textContent = shouldWarn ? SOURCE_WARNING_MESSAGE : "";
      sourceWarning.classList.toggle("hidden", !shouldWarn);
    };

    jobUrlInput.addEventListener("input", updateSourceWarning);
    jobUrlInput.addEventListener("change", updateSourceWarning);

    if (extractForm) {
      extractForm.addEventListener("submit", updateSourceWarning, true);
    }

    updateSourceWarning();
  }

  function isSafeExternalJobUrl(value) {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  function getApplicationRows(recentJobsBody) {
    const namedRows = recentJobsBody.querySelectorAll(".application-row");

    if (namedRows.length) {
      return Array.from(namedRows);
    }

    return Array.from(
      recentJobsBody.querySelectorAll("tr:not(.empty-row)")
    );
  }

  function getApplicationForRow(row, index) {
    if (typeof state === "undefined" || !Array.isArray(state.applications)) {
      return null;
    }

    const rowId =
      row.dataset.applicationId ||
      row.dataset.id ||
      row.getAttribute("data-application-id");

    if (rowId) {
      const exactMatch = state.applications.find(
        (application) => String(application.id) === String(rowId)
      );

      if (exactMatch) return exactMatch;
    }

    return state.applications[index] || null;
  }

  function ensureApplicationLinks() {
    const recentJobsBody = document.getElementById("recentJobsBody");

    if (!recentJobsBody) return;

    const rows = getApplicationRows(recentJobsBody);

    rows.forEach((row, index) => {
      const application = getApplicationForRow(row, index);
      const jobUrl = application?.job_url;

      if (!application || !isSafeExternalJobUrl(jobUrl)) return;

      let actions = row.querySelector(".row-actions");

      if (!actions) {
        const actionCell =
          row.querySelector(".row-actions-cell") ||
          row.lastElementChild;

        if (!actionCell) return;

        actions = document.createElement("div");
        actions.className = "row-actions";
        actionCell.appendChild(actions);
      }

      if (actions.querySelector(".application-link")) return;

      const link = document.createElement("a");
      link.className = "icon-button row-action-icon application-link";
      link.href = jobUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = "Open job posting";
      link.setAttribute(
        "aria-label",
        `Open ${application.company || "job"} posting`
      );
      link.textContent = "↗";

      // Action order becomes: Link → Edit → Remove.
      actions.prepend(link);
    });
  }

  function installApplicationLinkButtons() {
    const recentJobsBody = document.getElementById("recentJobsBody");

    if (!recentJobsBody) return;

    const observer = new MutationObserver(() => {
      ensureApplicationLinks();
    });

    observer.observe(recentJobsBody, {
      childList: true,
      subtree: true
    });

    ensureApplicationLinks();
  }

  function initializeQolAdditions() {
    installStyles();
    installBestPracticeCopy();
    installParserRiskChecker();
    installApplicationLinkButtons();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeQolAdditions, {
      once: true
    });
  } else {
    initializeQolAdditions();
  }
})();
