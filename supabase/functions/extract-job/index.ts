import {
  corsHeaders,
  isAllowedOrigin,
  jsonResponse,
} from "../_shared/cors.ts";
import {
  AuthError,
  requireAuthenticatedUser,
} from "../_shared/supabase.ts";

const MAX_REDIRECTS = 5;
const MAX_HTML_BYTES = 2_000_000;
const FETCH_TIMEOUT_MS = 12_000;

type ExtractedJob = {
  company: string;
  position: string;
  location: string;
  salary: string;
  source: string;
  confidence: number;
  extractionMethod: "json-ld" | "metadata" | "heuristic";
  finalUrl: string;
  warnings: string[];
};

type FetchResult = {
  response: Response;
  finalUrl: URL;
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
    // The extractor is available only to signed-in Stepping Stones users.
    await requireAuthenticatedUser(req);

    const body = await readJsonBody(req);
    const rawUrl = typeof body?.url === "string" ? body.url.trim() : "";

    if (!rawUrl) {
      return jsonResponse(req, { error: "A job URL is required." }, 400);
    }

    const initialUrl = parseAndValidatePublicUrl(rawUrl);
    const { response, finalUrl } = await fetchWithSafeRedirects(initialUrl);

    if (!response.ok) {
      return jsonResponse(
        req,
        {
          error: `Job page returned HTTP ${response.status}.`,
          status: response.status,
        },
        422,
      );
    }

    const contentType = (response.headers.get("content-type") || "")
      .toLowerCase();

    if (
      contentType &&
      !contentType.includes("text/html") &&
      !contentType.includes("application/xhtml+xml")
    ) {
      return jsonResponse(
        req,
        {
          error:
            "The supplied URL did not return an HTML job page that can be parsed.",
        },
        422,
      );
    }

    const html = await readResponseTextWithLimit(response, MAX_HTML_BYTES);
    const extracted = extractJobFromHtml(html, finalUrl);

    return jsonResponse(req, extracted);
  } catch (error) {
    console.error("extract-job error:", error);

    if (error instanceof AuthError) {
      return jsonResponse(req, { error: error.message }, error.status);
    }

    if (error instanceof UnsafeUrlError) {
      return jsonResponse(req, { error: error.message }, 400);
    }

    if (error instanceof ResponseTooLargeError) {
      return jsonResponse(req, { error: error.message }, 413);
    }

    return jsonResponse(
      req,
      {
        error: error instanceof Error
          ? error.message
          : "Could not extract this job posting.",
      },
      500,
    );
  }
});

class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

class ResponseTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResponseTooLargeError";
  }
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return await req.json();
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function parseAndValidatePublicUrl(value: string): URL {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new UnsafeUrlError("Enter a valid job posting URL.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new UnsafeUrlError("Only http and https job URLs are supported.");
  }

  if (url.username || url.password) {
    throw new UnsafeUrlError(
      "URLs containing embedded credentials are not allowed.",
    );
  }

  assertPublicHostname(url.hostname);

  return url;
}

function assertPublicHostname(rawHostname: string): void {
  const hostname = rawHostname
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "");

  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".lan") ||
    hostname === "metadata.google.internal"
  ) {
    throw new UnsafeUrlError("Private or local network URLs are not allowed.");
  }

  if (isPrivateIpv4(hostname) || isPrivateIpv6(hostname)) {
    throw new UnsafeUrlError("Private or local network URLs are not allowed.");
  }
}

function isPrivateIpv4(hostname: string): boolean {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);

  if (!match) return false;

  const parts = match.slice(1).map(Number);

  if (parts.some((part) => part < 0 || part > 255)) {
    return true;
  }

  const [a, b] = parts;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(hostname: string): boolean {
  if (!hostname.includes(":")) return false;

  const normalized = hostname.toLowerCase();

  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
}

async function fetchWithSafeRedirects(initialUrl: URL): Promise<FetchResult> {
  let currentUrl = initialUrl;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response: Response;

    try {
      response = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "Accept":
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.7",
          "Accept-Language": "en-US,en;q=0.8",
          "User-Agent":
            "Stepping-Stones-Job-Extractor/1.0",
        },
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error("The job page took too long to respond.");
      }

      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return {
        response,
        finalUrl: currentUrl,
      };
    }

    if (redirectCount === MAX_REDIRECTS) {
      throw new Error("The job URL redirected too many times.");
    }

    const location = response.headers.get("location");

    if (!location) {
      throw new Error("The job page returned an invalid redirect.");
    }

    const nextUrl = new URL(location, currentUrl);
    parseAndValidatePublicUrl(nextUrl.toString());
    currentUrl = nextUrl;
  }

  throw new Error("The job URL redirected too many times.");
}

async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") || "0");

  if (declaredLength > maxBytes) {
    throw new ResponseTooLargeError(
      "The job page is too large to safely process.",
    );
  }

  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { value, done } = await reader.read();

    if (done) break;

    if (value) {
      totalBytes += value.byteLength;

      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new ResponseTooLargeError(
          "The job page is too large to safely process.",
        );
      }

      chunks.push(value);
    }
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(combined);
}

function extractJobFromHtml(html: string, finalUrl: URL): ExtractedJob {
  const warnings: string[] = [];
  const source = detectSource(finalUrl);
  const metadata = extractMetaTags(html);
  const jsonLdJob = findJobPosting(extractJsonLdObjects(html));

  if (jsonLdJob) {
    const company = cleanText(
      getString(jsonLdJob?.hiringOrganization?.name),
    );

    const position = cleanText(getString(jsonLdJob?.title));
    const location = formatJobLocation(jsonLdJob);
    const salary = formatBaseSalary(jsonLdJob?.baseSalary);

    const metadataCompany = cleanText(
      metadata["og:site_name"] ||
        metadata["application-name"] ||
        "",
    );

    const metadataTitle = cleanJobTitle(
      metadata["og:title"] ||
        metadata["twitter:title"] ||
        extractHtmlTitle(html),
      company || metadataCompany,
    );

    const result: ExtractedJob = {
      company: company || metadataCompany || inferCompanyFromUrl(finalUrl),
      position: position || metadataTitle,
      location: location || findLocationFallback(html, metadata),
      salary: salary || findSalaryFallback(html),
      source,
      confidence: 0,
      extractionMethod: "json-ld",
      finalUrl: finalUrl.toString(),
      warnings,
    };

    result.confidence = calculateConfidence(result, true);

    if (!result.company || !result.position) {
      warnings.push(
        "Structured job data was found, but one or more core fields were missing.",
      );
    }

    return result;
  }

  const title = cleanJobTitle(
    metadata["og:title"] ||
      metadata["twitter:title"] ||
      extractHtmlTitle(html),
    metadata["og:site_name"] || metadata["application-name"] || "",
  );

  const providerHints = extractProviderHints(finalUrl, title);

  const company = cleanText(
    metadata["og:site_name"] ||
      metadata["application-name"] ||
      providerHints.company ||
      inferCompanyFromUrl(finalUrl),
  );

  const position = cleanText(
    providerHints.position ||
      cleanJobTitle(title, company),
  );

  const location = findLocationFallback(html, metadata);
  const salary = findSalaryFallback(html);

  const result: ExtractedJob = {
    company,
    position,
    location,
    salary,
    source,
    confidence: 0,
    extractionMethod: title || company ? "metadata" : "heuristic",
    finalUrl: finalUrl.toString(),
    warnings,
  };

  result.confidence = calculateConfidence(result, false);

  if (result.extractionMethod !== "json-ld") {
    warnings.push(
      "No Schema.org JobPosting data was found; review the extracted fields before saving.",
    );
  }

  if (source === "LinkedIn" || source === "Indeed") {
    warnings.push(
      `${source} may restrict automated page fetching, so extraction can be incomplete.`,
    );
  }

  return result;
}

function extractJsonLdObjects(html: string): unknown[] {
  const objects: unknown[] = [];
  const scriptRegex =
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json(?:\s*;[^"']*)?["'][^>]*>([\s\S]*?)<\/script>/gi;

  let match: RegExpExecArray | null;

  while ((match = scriptRegex.exec(html)) !== null) {
    const raw = match[1]
      .replace(/^\s*<!--/, "")
      .replace(/-->\s*$/, "")
      .trim();

    if (!raw) continue;

    try {
      objects.push(JSON.parse(raw));
    } catch {
      // Some sites include malformed JSON-LD. Ignore it and continue
      // with other structured blocks / metadata fallbacks.
    }
  }

  return objects;
}

function findJobPosting(nodes: unknown[]): any | null {
  for (const node of nodes) {
    const found = findJobPostingRecursive(node);

    if (found) return found;
  }

  return null;
}

function findJobPostingRecursive(node: unknown): any | null {
  if (!node || typeof node !== "object") {
    return null;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findJobPostingRecursive(item);

      if (found) return found;
    }

    return null;
  }

  const record = node as Record<string, unknown>;
  const type = record["@type"];

  if (
    type === "JobPosting" ||
    (Array.isArray(type) && type.includes("JobPosting"))
  ) {
    return record;
  }

  for (const value of Object.values(record)) {
    const found = findJobPostingRecursive(value);

    if (found) return found;
  }

  return null;
}

function extractMetaTags(html: string): Record<string, string> {
  const metadata: Record<string, string> = {};
  const metaRegex = /<meta\b[^>]*>/gi;

  for (const match of html.matchAll(metaRegex)) {
    const tag = match[0];
    const attributes = parseHtmlAttributes(tag);

    const key = (
      attributes.property ||
      attributes.name ||
      attributes.itemprop ||
      ""
    ).toLowerCase();

    const content = decodeHtmlEntities(attributes.content || "").trim();

    if (key && content && !(key in metadata)) {
      metadata[key] = content;
    }
  }

  return metadata;
}

function parseHtmlAttributes(tag: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const attributeRegex =
    /([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

  let match: RegExpExecArray | null;

  while ((match = attributeRegex.exec(tag)) !== null) {
    attributes[match[1].toLowerCase()] =
      match[2] ?? match[3] ?? match[4] ?? "";
  }

  return attributes;
}

function extractHtmlTitle(html: string): string {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return cleanText(match?.[1] || "");
}

function extractProviderHints(
  url: URL,
  pageTitle: string,
): { company: string; position: string } {
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);

  const greenhouseMatch = pageTitle.match(
    /job application for\s+(.+?)\s+at\s+(.+)$/i,
  );

  if (greenhouseMatch) {
    return {
      position: cleanText(greenhouseMatch[1]),
      company: cleanText(greenhouseMatch[2]),
    };
  }

  if (host.includes("greenhouse.io")) {
    const slug = parts.find((part) => !["jobs", "job"].includes(part.toLowerCase()));

    return {
      company: slug ? formatSlug(slug) : "",
      position: "",
    };
  }

  if (host.includes("lever.co") || host.includes("ashbyhq.com")) {
    return {
      company: parts[0] ? formatSlug(parts[0]) : "",
      position: "",
    };
  }

  if (host.includes("myworkdayjobs.com")) {
    const firstHostPart = host.split(".")[0];

    return {
      company: formatSlug(
        firstHostPart.replace(/\.wd\d+$/i, "").replace(/^wd\d+$/i, ""),
      ),
      position: "",
    };
  }

  return {
    company: "",
    position: "",
  };
}

function cleanJobTitle(title: string, company: string): string {
  let cleaned = cleanText(title);

  if (!cleaned) return "";

  if (company) {
    const escapedCompany = escapeRegExp(cleanText(company));

    cleaned = cleaned
      .replace(new RegExp(`\\s*[|–—-]\\s*${escapedCompany}\\s*$`, "i"), "")
      .replace(new RegExp(`\\s+at\\s+${escapedCompany}\\s*$`, "i"), "");
  }

  cleaned = cleaned
    .replace(/\s*[|–—]\s*(careers?|jobs?|open positions?)\s*$/i, "")
    .replace(/\s*[|–—]\s*job details?\s*$/i, "")
    .replace(/^job application for\s+/i, "")
    .trim();

  return cleaned;
}

function formatJobLocation(job: any): string {
  if (
    String(job?.jobLocationType || "").toUpperCase() === "TELECOMMUTE"
  ) {
    return "Remote";
  }

  const locations = Array.isArray(job?.jobLocation)
    ? job.jobLocation
    : job?.jobLocation
    ? [job.jobLocation]
    : [];

  const formatted = locations
    .map((location: any) => formatAddress(location?.address || location))
    .filter(Boolean);

  return [...new Set(formatted)].slice(0, 3).join(" / ");
}

function formatAddress(address: any): string {
  if (!address) return "";

  if (typeof address === "string") {
    return cleanText(address);
  }

  const locality = cleanText(getString(address.addressLocality));
  const region = cleanText(getString(address.addressRegion));
  const country = cleanText(
    getString(address.addressCountry?.name || address.addressCountry),
  );

  const cityRegion = [locality, region].filter(Boolean).join(", ");

  if (cityRegion) return cityRegion;
  if (country) return country;

  return cleanText(getString(address.streetAddress));
}

function formatBaseSalary(baseSalary: any): string {
  if (baseSalary == null) return "";

  if (typeof baseSalary === "string" || typeof baseSalary === "number") {
    return cleanText(String(baseSalary));
  }

  const currency = cleanText(getString(baseSalary.currency || "USD"));
  const value = baseSalary.value ?? baseSalary;

  if (typeof value === "number" || typeof value === "string") {
    return `${currencyPrefix(currency)}${formatNumber(value)}`;
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const minValue = value.minValue;
  const maxValue = value.maxValue;
  const singleValue = value.value;
  const unitText = cleanText(getString(value.unitText));

  let amount = "";

  if (minValue != null && maxValue != null) {
    amount =
      `${currencyPrefix(currency)}${formatNumber(minValue)} – ` +
      `${currencyPrefix(currency)}${formatNumber(maxValue)}`;
  } else if (singleValue != null) {
    amount = `${currencyPrefix(currency)}${formatNumber(singleValue)}`;
  } else if (minValue != null) {
    amount = `From ${currencyPrefix(currency)}${formatNumber(minValue)}`;
  } else if (maxValue != null) {
    amount = `Up to ${currencyPrefix(currency)}${formatNumber(maxValue)}`;
  }

  if (!amount) return "";

  return unitText ? `${amount} / ${normalizeSalaryUnit(unitText)}` : amount;
}

function currencyPrefix(currency: string): string {
  const normalized = currency.toUpperCase();

  const symbols: Record<string, string> = {
    USD: "$",
    CAD: "CA$",
    GBP: "£",
    EUR: "€",
    AUD: "A$",
  };

  return symbols[normalized] || `${normalized} `;
}

function normalizeSalaryUnit(unit: string): string {
  const normalized = unit.toUpperCase();

  const map: Record<string, string> = {
    HOUR: "hour",
    DAY: "day",
    WEEK: "week",
    MONTH: "month",
    YEAR: "year",
  };

  return map[normalized] || unit.toLowerCase();
}

function formatNumber(value: unknown): string {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return cleanText(String(value ?? ""));
  }

  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: Number.isInteger(number) ? 0 : 2,
  }).format(number);
}

function findLocationFallback(
  html: string,
  metadata: Record<string, string>,
): string {
  const explicitMeta =
    metadata["job:location"] ||
    metadata["job-location"] ||
    metadata["location"];

  if (explicitMeta) {
    return cleanText(explicitMeta);
  }

  const text = htmlToPlainText(html).slice(0, 250_000);

  const remoteMatch = text.match(
    /(?:job\s+location|work\s+location|location)\s*[:\-]?\s*(remote(?:\s*[-/]\s*[A-Za-z ,.]+)?)/i,
  );

  if (remoteMatch) {
    return cleanText(remoteMatch[1]);
  }

  const cityStateMatch = text.match(
    /(?:job\s+location|work\s+location|location)\s*[:\-]?\s*([A-Z][A-Za-z.' -]{1,55},\s*[A-Z]{2})(?=\s|$)/,
  );

  return cleanText(cityStateMatch?.[1] || "");
}

function findSalaryFallback(html: string): string {
  const text = htmlToPlainText(html).slice(0, 350_000);

  const rangeMatch = text.match(
    /(?:salary|compensation|pay range|base pay|base salary)[^\n$]{0,100}(\$\s?\d[\d,]*(?:\.\d+)?\s*(?:-|–|—|to)\s*\$?\s?\d[\d,]*(?:\.\d+)?(?:\s*(?:\/|per)\s*(?:hour|hr|year|yr|month|week))?)/i,
  );

  if (rangeMatch) {
    return cleanText(rangeMatch[1]);
  }

  const singleMatch = text.match(
    /(?:salary|compensation|base pay|base salary)[^\n$]{0,80}(\$\s?\d[\d,]*(?:\.\d+)?(?:\s*(?:\/|per)\s*(?:hour|hr|year|yr|month|week))?)/i,
  );

  return cleanText(singleMatch?.[1] || "");
}

function htmlToPlainText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
      .replace(
        /<\/?(?:p|div|section|article|li|br|h1|h2|h3|h4|tr|td|th)\b[^>]*>/gi,
        "\n",
      )
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function inferCompanyFromUrl(url: URL): string {
  const host = url.hostname.toLowerCase();
  const provider = detectSource(url);

  if (provider !== "Company Website") {
    const providerHints = extractProviderHints(url, "");

    if (providerHints.company) {
      return providerHints.company;
    }
  }

  const ignored = new Set([
    "www",
    "jobs",
    "job",
    "careers",
    "career",
    "apply",
    "work",
  ]);

  const labels = host.split(".").filter((label) => !ignored.has(label));

  if (!labels.length) return "";

  // For most common company-owned domains the final non-TLD label is the brand.
  const candidate = labels.length >= 2 ? labels[labels.length - 2] : labels[0];

  return formatSlug(candidate);
}

function detectSource(url: URL): string {
  const host = url.hostname.toLowerCase();

  if (host.includes("greenhouse.io")) return "Greenhouse";
  if (host.includes("lever.co")) return "Lever";
  if (host.includes("myworkdayjobs.com") || host.includes("workdayjobs.com")) {
    return "Workday";
  }
  if (host.includes("linkedin.com")) return "LinkedIn";
  if (host.includes("indeed.com")) return "Indeed";
  if (host.includes("ashbyhq.com")) return "Ashby";
  if (host.includes("smartrecruiters.com")) return "SmartRecruiters";
  if (host.includes("icims.com")) return "iCIMS";
  if (host.includes("jobvite.com")) return "Jobvite";
  if (host.includes("workable.com")) return "Workable";
  if (host.includes("bamboohr.com")) return "BambooHR";
  if (host.includes("handshake.com")) return "Handshake";

  return "Company Website";
}

function calculateConfidence(
  result: ExtractedJob,
  structured: boolean,
): number {
  let score = structured ? 0.55 : 0.25;

  if (result.company) score += structured ? 0.12 : 0.16;
  if (result.position) score += structured ? 0.16 : 0.22;
  if (result.location) score += 0.08;
  if (result.salary) score += 0.05;
  if (result.source !== "Company Website") score += 0.02;

  return Math.min(structured ? 0.98 : 0.78, Number(score.toFixed(2)));
}

function getString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

function cleanText(value: string): string {
  return decodeHtmlEntities(value)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  const entities: Record<string, string> = {
    "&amp;": "&",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&lt;": "<",
    "&gt;": ">",
    "&nbsp;": " ",
    "&#x2F;": "/",
  };

  return value
    .replace(
      /&(amp|quot|#39|apos|lt|gt|nbsp|#x2F);/gi,
      (match) => entities[match] ?? entities[match.toLowerCase()] ?? match,
    )
    .replace(/&#(\d+);/g, (_, code) => {
      const number = Number(code);
      return Number.isFinite(number) ? String.fromCharCode(number) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      const number = Number.parseInt(code, 16);
      return Number.isFinite(number) ? String.fromCharCode(number) : _;
    });
}

function formatSlug(value: string): string {
  return decodeURIComponent(value)
    .replace(/[-_+]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
