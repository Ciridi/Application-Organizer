import {
  createClient,
  type SupabaseClient,
  type User,
} from "npm:@supabase/supabase-js@2";

function readNamedKey(jsonEnvName: string, legacyEnvName: string): string {
  const jsonValue = Deno.env.get(jsonEnvName);

  if (jsonValue) {
    try {
      const parsed = JSON.parse(jsonValue);
      const defaultKey = parsed?.default;

      if (typeof defaultKey === "string" && defaultKey) {
        return defaultKey;
      }
    } catch {
      // Fall through to legacy env var.
    }
  }

  const legacy = Deno.env.get(legacyEnvName);

  if (!legacy) {
    throw new Error(
      `Missing ${jsonEnvName} (or legacy ${legacyEnvName}) environment variable.`,
    );
  }

  return legacy;
}

export type AuthContext = {
  user: User;
  userClient: SupabaseClient;
  adminClient: SupabaseClient;
};

export class AuthError extends Error {
  status: number;

  constructor(message: string, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

export async function requireAuthenticatedUser(
  req: Request,
): Promise<AuthContext> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");

  if (!supabaseUrl) {
    throw new Error("SUPABASE_URL is not configured.");
  }

  const authHeader = req.headers.get("Authorization");

  if (!authHeader?.startsWith("Bearer ")) {
    throw new AuthError("Missing Supabase user authorization.", 401);
  }

  const userToken = authHeader.slice("Bearer ".length).trim();

  if (!userToken) {
    throw new AuthError("Missing Supabase user token.", 401);
  }

  const publishableKey = readNamedKey(
    "SUPABASE_PUBLISHABLE_KEYS",
    "SUPABASE_ANON_KEY",
  );

  const secretKey = readNamedKey(
    "SUPABASE_SECRET_KEYS",
    "SUPABASE_SERVICE_ROLE_KEY",
  );

  // This client inherits the caller's Supabase JWT, so normal queries
  // remain subject to that user's RLS policies.
  const userClient = createClient(supabaseUrl, publishableKey, {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  const {
    data: { user },
    error: userError,
  } = await userClient.auth.getUser(userToken);

  if (userError || !user) {
    throw new AuthError("Invalid or expired Supabase user session.", 401);
  }

  // Admin access is only used for server-owned records such as encrypted
  // Google refresh tokens and sheet sync metadata.
  const adminClient = createClient(supabaseUrl, secretKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return {
    user,
    userClient,
    adminClient,
  };
}
