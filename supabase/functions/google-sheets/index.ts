import {
  corsHeaders,
  isAllowedOrigin,
  jsonResponse,
} from "../_shared/cors.ts";
import {
  AuthError,
  requireAuthenticatedUser,
} from "../_shared/supabase.ts";
import {
  decryptSecret,
  encryptSecret,
} from "../_shared/crypto.ts";

const SHEET_TAB_NAME = "Applications";

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
  "Created At",
];

type SetupRequest = {
  action: "setup";
  providerToken?: string;
  providerRefreshToken?: string | null;
  sheetTitle?: string;
};

type SyncRequest = {
  action: "sync";
  applicationId?: string;
};

type GoogleConnectionRow = {
  refresh_token_ciphertext: string;
  refresh_token_iv: string;
  google_email: string;
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders(req),
    });
  }

  if (!isAllowedOrigin(req)) {
    return jsonResponse(req, { error: "Origin not allowed." }, 403);
  }

  if (req.method !== "POST") {
    return jsonResponse(req, { error: "Method not allowed." }, 405);
  }

  try {
    const { user, adminClient } = await requireAuthenticatedUser(req);
    const body = await readJsonBody(req);

    if (body.action === "setup") {
      return await handleSetup(
        req,
        user,
        adminClient,
        body as SetupRequest,
      );
    }

    if (body.action === "sync") {
      return await handleSync(
        req,
        user,
        adminClient,
        body as SyncRequest,
      );
    }

    return jsonResponse(
      req,
      { error: 'action must be either "setup" or "sync".' },
      400,
    );
  } catch (error) {
    console.error("google-sheets error:", error);

    if (error instanceof AuthError) {
      return jsonResponse(req, { error: error.message }, error.status);
    }

    if (error instanceof GoogleReconnectError) {
      return jsonResponse(
        req,
        {
          error: error.message,
          requiresGoogleReconnect: true,
        },
        409,
      );
    }

    if (error instanceof GoogleApiError) {
      return jsonResponse(
        req,
        {
          error: error.message,
          googleStatus: error.status,
          googleDetails: error.safeDetails,
          requiresGoogleReconnect: error.requiresReconnect,
        },
        error.status === 401 ? 409 : 502,
      );
    }

    return jsonResponse(
      req,
      {
        error: error instanceof Error
          ? error.message
          : "Google Sheets operation failed.",
      },
      500,
    );
  }
});

async function readJsonBody(req: Request): Promise<Record<string, any>> {
  try {
    return await req.json();
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

async function handleSetup(
  req: Request,
  user: any,
  adminClient: any,
  body: SetupRequest,
): Promise<Response> {
  const providerToken =
    typeof body.providerToken === "string" ? body.providerToken.trim() : "";

  const providerRefreshToken =
    typeof body.providerRefreshToken === "string"
      ? body.providerRefreshToken.trim()
      : "";

  if (!providerToken) {
    throw new GoogleReconnectError(
      "Google did not provide an access token. Sign out and connect Google again.",
    );
  }

  const googleProfile = await getGoogleProfile(providerToken);
  const supabaseEmail = String(user.email || "").toLowerCase();
  const googleEmail = String(googleProfile.email || "").toLowerCase();

  if (
    !googleEmail ||
    !supabaseEmail ||
    googleEmail !== supabaseEmail
  ) {
    throw new Error(
      "The connected Google account does not match the signed-in Stepping Stones account.",
    );
  }

  // Store the long-lived refresh token only on the server, encrypted at rest.
  // On later sign-ins Google may omit the refresh token; keep the one already
  // stored instead of overwriting it with null.
  if (providerRefreshToken) {
    const encrypted = await encryptSecret(providerRefreshToken);

    const { error: connectionError } = await adminClient
      .from("google_connections")
      .upsert(
        {
          user_id: user.id,
          google_email: googleEmail,
          refresh_token_ciphertext: encrypted.ciphertext,
          refresh_token_iv: encrypted.iv,
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: "user_id",
        },
      );

    if (connectionError) {
      throw new Error(
        `Could not securely store Google connection: ${connectionError.message}`,
      );
    }
  } else {
    const { data: existingConnection, error: connectionLookupError } =
      await adminClient
        .from("google_connections")
        .select("user_id")
        .eq("user_id", user.id)
        .maybeSingle();

    if (connectionLookupError) {
      throw new Error(
        `Could not read Google connection: ${connectionLookupError.message}`,
      );
    }

    if (!existingConnection) {
      throw new GoogleReconnectError(
        "Google did not return a refresh token. Reconnect Google so Stepping Stones can keep your Sheet synchronized after the current access token expires.",
      );
    }
  }

  const { data: existingSettings, error: settingsLookupError } =
    await adminClient
      .from("user_settings")
      .select("google_sheet_id, google_sheet_url")
      .eq("user_id", user.id)
      .maybeSingle();

  if (settingsLookupError) {
    throw new Error(
      `Could not read spreadsheet settings: ${settingsLookupError.message}`,
    );
  }

  if (existingSettings?.google_sheet_id) {
    const spreadsheetId = existingSettings.google_sheet_id;
    const spreadsheetUrl =
      existingSettings.google_sheet_url ||
      `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;

    return jsonResponse(req, {
      spreadsheetId,
      spreadsheetUrl,
      sheetTitle: sanitizeSheetTitle(body.sheetTitle),
      existing: true,
    });
  }

  const sheetTitle = sanitizeSheetTitle(body.sheetTitle);

  const created = await createSpreadsheet(providerToken, sheetTitle);
  const spreadsheetId = created.spreadsheetId;
  const firstSheetId = created.sheets?.[0]?.properties?.sheetId;

  if (!spreadsheetId) {
    throw new Error("Google created a spreadsheet without returning an ID.");
  }

  await writeHeaderRow(providerToken, spreadsheetId);

  if (typeof firstSheetId === "number") {
    await formatSpreadsheet(providerToken, spreadsheetId, firstSheetId);
  }

  const spreadsheetUrl =
    created.spreadsheetUrl ||
    `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;

  const { error: saveSettingsError } = await adminClient
    .from("user_settings")
    .upsert(
      {
        user_id: user.id,
        google_sheet_id: spreadsheetId,
        google_sheet_url: spreadsheetUrl,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "user_id",
      },
    );

  if (saveSettingsError) {
    throw new Error(
      `Sheet was created, but its ID could not be saved: ${saveSettingsError.message}`,
    );
  }

  return jsonResponse(req, {
    spreadsheetId,
    spreadsheetUrl,
    sheetTitle,
    existing: false,
  });
}

async function handleSync(
  req: Request,
  user: any,
  adminClient: any,
  body: SyncRequest,
): Promise<Response> {
  const applicationId =
    typeof body.applicationId === "string" ? body.applicationId.trim() : "";

  if (!isUuid(applicationId)) {
    return jsonResponse(req, { error: "A valid applicationId is required." }, 400);
  }

  const { data: application, error: applicationError } = await adminClient
    .from("applications")
    .select(
      [
        "id",
        "user_id",
        "company",
        "position",
        "status",
        "date_applied",
        "location",
        "salary",
        "job_url",
        "source",
        "notes",
        "created_at",
        "google_sheet_synced_at",
        "google_sheet_row",
      ].join(","),
    )
    .eq("id", applicationId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (applicationError) {
    throw new Error(
      `Could not read the application: ${applicationError.message}`,
    );
  }

  if (!application) {
    return jsonResponse(req, { error: "Application not found." }, 404);
  }

  if (application.google_sheet_synced_at) {
    return jsonResponse(req, {
      synced: true,
      alreadySynced: true,
      row: application.google_sheet_row || null,
    });
  }

  const { data: settings, error: settingsError } = await adminClient
    .from("user_settings")
    .select("google_sheet_id, google_sheet_url")
    .eq("user_id", user.id)
    .maybeSingle();

  if (settingsError) {
    throw new Error(
      `Could not read spreadsheet settings: ${settingsError.message}`,
    );
  }

  if (!settings?.google_sheet_id) {
    return jsonResponse(
      req,
      {
        error: "No Google Sheet is connected yet.",
        requiresSetup: true,
      },
      409,
    );
  }

  const { data: connection, error: connectionError } = await adminClient
    .from("google_connections")
    .select(
      "refresh_token_ciphertext, refresh_token_iv, google_email",
    )
    .eq("user_id", user.id)
    .maybeSingle();

  if (connectionError) {
    throw new Error(
      `Could not read the Google connection: ${connectionError.message}`,
    );
  }

  if (!connection) {
    throw new GoogleReconnectError(
      "Your Google connection needs to be refreshed before Sheets can sync.",
    );
  }

  const refreshToken = await decryptSecret({
    ciphertext: (connection as GoogleConnectionRow).refresh_token_ciphertext,
    iv: (connection as GoogleConnectionRow).refresh_token_iv,
  });

  const accessToken = await refreshGoogleAccessToken(refreshToken);

  /*
    External writes cannot participate in the same database transaction as
    Postgres. Before appending, check column A for this application's UUID.
    This makes retries idempotent even if a prior Sheet append succeeded but
    the database sync metadata update failed afterward.
  */
  const existingRow = await findApplicationRow(
    accessToken,
    settings.google_sheet_id,
    application.id,
  );

  if (existingRow) {
    const recoveredAt = new Date().toISOString();

    await adminClient
      .from("applications")
      .update({
        google_sheet_synced_at: recoveredAt,
        google_sheet_row: existingRow,
      })
      .eq("id", application.id)
      .eq("user_id", user.id);

    return jsonResponse(req, {
      synced: true,
      alreadySynced: true,
      recovered: true,
      row: existingRow,
      syncedAt: recoveredAt,
    });
  }

  const appendResult = await appendApplicationRow(
    accessToken,
    settings.google_sheet_id,
    application,
  );

  const rowNumber = parseRowNumber(
    appendResult?.updates?.updatedRange || "",
  );

  const syncedAt = new Date().toISOString();

  const { error: markSyncedError } = await adminClient
    .from("applications")
    .update({
      google_sheet_synced_at: syncedAt,
      google_sheet_row: rowNumber,
    })
    .eq("id", application.id)
    .eq("user_id", user.id);

  if (markSyncedError) {
    console.error(
      "Row appended but sync metadata could not be saved:",
      markSyncedError,
    );

    // Do not append again automatically because the external write already
    // succeeded. Return success and surface a warning for logs/monitoring.
    return jsonResponse(req, {
      synced: true,
      row: rowNumber,
      warning:
        "The spreadsheet row was written, but local sync metadata could not be updated.",
    });
  }

  return jsonResponse(req, {
    synced: true,
    alreadySynced: false,
    row: rowNumber,
    syncedAt,
  });
}

async function getGoogleProfile(accessToken: string): Promise<any> {
  const response = await fetch(
    "https://www.googleapis.com/oauth2/v3/userinfo",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!response.ok) {
    throw new GoogleReconnectError(
      "Google access is no longer valid. Reconnect your Google account.",
    );
  }

  return response.json();
}

async function refreshGoogleAccessToken(
  refreshToken: string,
): Promise<string> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");

  if (!clientId || !clientSecret) {
    throw new Error(
      "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured as Edge Function secrets.",
    );
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const data = await safeJson(response);

  if (!response.ok || typeof data?.access_token !== "string") {
    const description =
      typeof data?.error_description === "string"
        ? data.error_description
        : "Google refresh token was rejected.";

    if (data?.error === "invalid_grant") {
      throw new GoogleReconnectError(
        "Google authorization expired or was revoked. Reconnect Google to resume spreadsheet sync.",
      );
    }

    throw new GoogleApiError(
      `Could not refresh Google access: ${description}`,
      response.status,
      data,
      true,
    );
  }

  return data.access_token;
}

async function createSpreadsheet(
  accessToken: string,
  title: string,
): Promise<any> {
  const response = await googleFetch(
    accessToken,
    "https://sheets.googleapis.com/v4/spreadsheets",
    {
      method: "POST",
      body: JSON.stringify({
        properties: {
          title,
        },
        sheets: [
          {
            properties: {
              title: SHEET_TAB_NAME,
              gridProperties: {
                frozenRowCount: 1,
              },
            },
          },
        ],
      }),
    },
  );

  return response.json();
}

async function writeHeaderRow(
  accessToken: string,
  spreadsheetId: string,
): Promise<void> {
  const range = encodeURIComponent(`${SHEET_TAB_NAME}!A1:K1`);

  await googleFetch(
    accessToken,
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=RAW`,
    {
      method: "PUT",
      body: JSON.stringify({
        range: `${SHEET_TAB_NAME}!A1:K1`,
        majorDimension: "ROWS",
        values: [SHEET_HEADERS],
      }),
    },
  );
}

async function formatSpreadsheet(
  accessToken: string,
  spreadsheetId: string,
  sheetId: number,
): Promise<void> {
  await googleFetch(
    accessToken,
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    {
      method: "POST",
      body: JSON.stringify({
        requests: [
          {
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: 0,
                endRowIndex: 1,
                startColumnIndex: 0,
                endColumnIndex: SHEET_HEADERS.length,
              },
              cell: {
                userEnteredFormat: {
                  textFormat: {
                    bold: true,
                  },
                },
              },
              fields: "userEnteredFormat.textFormat.bold",
            },
          },
          {
            autoResizeDimensions: {
              dimensions: {
                sheetId,
                dimension: "COLUMNS",
                startIndex: 0,
                endIndex: SHEET_HEADERS.length,
              },
            },
          },
        ],
      }),
    },
  );
}

async function findApplicationRow(
  accessToken: string,
  spreadsheetId: string,
  applicationId: string,
): Promise<number | null> {
  const range = encodeURIComponent(`${SHEET_TAB_NAME}!A:A`);

  const response = await googleFetch(
    accessToken,
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`,
    {
      method: "GET",
    },
  );

  const data = await response.json();
  const rows = Array.isArray(data?.values) ? data.values : [];

  for (let index = 0; index < rows.length; index += 1) {
    if (String(rows[index]?.[0] ?? "") === applicationId) {
      // Sheets rows are 1-indexed.
      return index + 1;
    }
  }

  return null;
}

async function appendApplicationRow(
  accessToken: string,
  spreadsheetId: string,
  application: any,
): Promise<any> {
  const range = encodeURIComponent(`${SHEET_TAB_NAME}!A:K`);

  const response = await googleFetch(
    accessToken,
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: "POST",
      body: JSON.stringify({
        majorDimension: "ROWS",
        values: [
          [
            spreadsheetSafeValue(application.id),
            spreadsheetSafeValue(application.company),
            spreadsheetSafeValue(application.position),
            spreadsheetSafeValue(application.status),
            spreadsheetSafeValue(application.date_applied || ""),
            spreadsheetSafeValue(application.location || ""),
            spreadsheetSafeValue(application.salary || ""),
            spreadsheetSafeValue(application.job_url),
            spreadsheetSafeValue(application.source || ""),
            spreadsheetSafeValue(application.notes || ""),
            spreadsheetSafeValue(application.created_at),
          ],
        ],
      }),
    },
  );

  return response.json();
}

function spreadsheetSafeValue(value: unknown): string {
  const stringValue = String(value ?? "");

  /*
    USER_ENTERED lets Google recognize dates and normal values, but cells
    beginning with =, +, -, or @ can be interpreted as formulas. Prefix those
    user-controlled values with an apostrophe to prevent formula injection.
  */
  if (/^[=+\-@]/.test(stringValue)) {
    return `'${stringValue}`;
  }

  return stringValue;
}

async function googleFetch(
  accessToken: string,
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const data = await safeJson(response);

    const message =
      data?.error?.message ||
      data?.error_description ||
      `Google API returned HTTP ${response.status}.`;

    const requiresReconnect =
      response.status === 401 ||
      data?.error === "invalid_grant";

    throw new GoogleApiError(
      message,
      response.status,
      data,
      requiresReconnect,
    );
  }

  return response;
}

async function safeJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function sanitizeSheetTitle(value: unknown): string {
  const title =
    typeof value === "string" && value.trim()
      ? value.trim()
      : "Stepping Stones - Job Applications";

  return title.slice(0, 100);
}

function parseRowNumber(updatedRange: string): number | null {
  const match = updatedRange.match(/!A(\d+):/i);
  return match ? Number(match[1]) : null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

class GoogleReconnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleReconnectError";
  }
}

class GoogleApiError extends Error {
  status: number;
  safeDetails: unknown;
  requiresReconnect: boolean;

  constructor(
    message: string,
    status: number,
    safeDetails: unknown,
    requiresReconnect = false,
  ) {
    super(message);
    this.name = "GoogleApiError";
    this.status = status;
    this.safeDetails = sanitizeGoogleError(safeDetails);
    this.requiresReconnect = requiresReconnect;
  }
}

function sanitizeGoogleError(value: any): unknown {
  if (!value || typeof value !== "object") {
    return null;
  }

  return {
    error: value.error?.status || value.error || null,
    message: value.error?.message || value.error_description || null,
  };
}
