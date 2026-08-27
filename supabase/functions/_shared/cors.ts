export function isAllowedOrigin(req: Request): boolean {
  const configured = (Deno.env.get("APP_ALLOWED_ORIGINS") || "*")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (configured.includes("*")) return true;

  const origin = req.headers.get("Origin");

  // Server-to-server calls often do not include Origin.
  if (!origin) return true;

  return configured.includes(origin);
}

export function corsHeaders(req: Request): Record<string, string> {
  const configured = (Deno.env.get("APP_ALLOWED_ORIGINS") || "*")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const origin = req.headers.get("Origin");

  let allowOrigin = "*";

  if (!configured.includes("*")) {
    allowOrigin = origin && configured.includes(origin)
      ? origin
      : configured[0] || "null";
  }

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export function jsonResponse(
  req: Request,
  body: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
