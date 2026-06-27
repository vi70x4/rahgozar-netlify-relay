/**
 * rahgozar Netlify Relay — a drop-in replacement for Google Apps Script
 * (Code.gs) that runs as a Netlify Function.
 *
 * Implements the SAME relay protocol as Code.gs:
 *   - Single:  POST {k, m, u, h, b, ct, r} → {s, h, b}
 *   - Batch:   POST {k, q: [{m,u,h,b,ct,r}, ...]} → {q: [{s,h,b}, ...]}
 *   - Quota:   POST {k, op: "quota"} → {remaining: <high-number>}
 *   - GET /quota?k=<AUTH_KEY> → {remaining: N}  (for ad-hoc curl checks)
 *
 * Deploy on Netlify:
 *   1. Fork / copy this file into a Netlify-connected repo
 *   2. Set AUTH_KEY in Netlify environment variables
 *   3. Deploy via `netlify deploy --prod` or git push
 *   4. Use the function URL as your relay endpoint
 *
 * ── Connecting rahgozar ──────────────────────────────────────────────────
 *
 * The rahgozar Rust client is hardcoded to connect to script.google.com
 * via domain fronting. To route through this Netlify relay instead, you
 * have two options:
 *
 *   A) Deploy a THIN Apps Script passthrough (see Code.passthrough.gs in
 *      the Deno relay directory) that simply forwards every request to
 *      this Netlify Function URL. This preserves the full rahgozar
 *      experience (DPI cover, no Rust modifications).
 *
 *   B) Set the environment variable RAHGOZAR_REDIRECT_TARGET to this
 *      relay's URL and run a local proxy that rewrites script.google.com
 *      connections to your Netlify endpoint.
 *
 *   C) (Requires modifying rahgozar's Rust source) Add a `relay_url`
 *      field to Config that overrides the hardcoded script.google.com
 *      host and path. Patch is minimal — contact the rahgozar maintainers.
 */

// ── Configuration ──────────────────────────────────────────────────────
// Set these via Netlify environment variables (Site settings →
// Environment variables).
//
//   AUTH_KEY          — shared secret, must match rahgozar config's `auth_key`
//                       REQUIRED. Must be changed from the placeholder.
//   DIAGNOSTIC_MODE   — when "true", bad-auth requests return JSON errors
//                       instead of decoy HTML (default: false)
//   QUOTA_CEILING     — what `op: "quota"` reports (default 100000)
//   ALLOWED_ORIGINS   — optional, comma-separated CORS origins
//                       (e.g. "https://example.com,https://app.example.com")
//   CACHE_TTL_MS      — optional in-memory cache TTL in ms (default 60000)
//                       Set to "0" to disable caching.

const AUTH_KEY = process.env.AUTH_KEY || "CHANGE_ME_TO_A_STRONG_SECRET";
const DIAGNOSTIC_MODE = process.env.DIAGNOSTIC_MODE === "true";
const QUOTA_CEILING = parseInt(process.env.QUOTA_CEILING || "100000", 10);
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS || "0", 10);

// Active-probing defense. When false (production default), bad AUTH_KEY
// requests get a decoy HTML page that looks like a placeholder web app
// instead of the JSON `{"e":"unauthorized"}` body. This makes the
// deployment indistinguishable from a forgotten-but-public web app to
// active scanners that POST malformed payloads looking for proxy
// endpoints.
//
// Set DIAGNOSTIC_MODE=true during initial setup to debug auth issues,
// then flip back to false before sharing the URL widely.

// HTML body for the bad-auth decoy. Generic placeholder page; no
// proxy-shaped JSON, nothing distinctive enough for a scanner to
// fingerprint as a tunnel endpoint.
const DECOY_HTML =
  '<!DOCTYPE html><html><head><title>Web App</title></head>' +
  '<body><p>The script completed but did not return anything.</p>' +
  '</body></html>';

// ── Hop-by-hop headers we strip before forwarding to the destination ────
// These MUST NOT be forwarded: they'd either leak the user's IP, break
// framing, or reveal proxy topology.
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "proxy-connection",
  "proxy-authorization",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-forwarded-server",
  "x-forwarded-ssl",
  "forwarded",
  "via",
  "x-real-ip",
  "x-client-ip",
  "x-originating-ip",
  "true-client-ip",
  "cf-connecting-ip",
  "fastly-client-ip",
  "x-cluster-client-ip",
  "client-ip",
  "priority",
  "te",
]);

// Response headers that MUST NOT be forwarded — they describe the
// fetch-response framing, not the destination's actual content.
const STRIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
]);

// ── In-memory cache ────────────────────────────────────────────────────
// A simple TTL-based cache for GET responses. Enabled only when
// CACHE_TTL_MS > 0. Not as sophisticated as the Google Sheets cache
// in Code.gs, but handles the common case of repeated identical
// requests (favicons, API polling, etc.) without burning function
// invocations on redundant upstream fetches.
//
// The cache is Vary-aware: Accept-Encoding and Accept-Language are
// hashed into the cache key alongside the URL so that responses with
// different encodings never collide.
const VARY_KEY_HEADERS = ["accept-encoding", "accept-language"];
const CACHE_BUSTING_HEADERS = new Set([
  "authorization",
  "cookie",
  "x-api-key",
  "proxy-authorization",
  "set-cookie",
]);

let _cache = null; // {Map<string, {expiresAt: number, data: object}>}
let _cacheTimer = null;

function initCache() {
  if (CACHE_TTL_MS > 0 && !_cache) {
    _cache = new Map();
    // Evict stale entries every 60 seconds
    _cacheTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of _cache) {
        if (entry.expiresAt <= now) _cache.delete(key);
      }
    }, 60000);
  }
}

function cacheGet(cacheKey) {
  if (!_cache) return null;
  const entry = _cache.get(cacheKey);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    _cache.delete(cacheKey);
    return null;
  }
  return entry.data;
}

function cacheSet(cacheKey, data, ttlMs) {
  if (!_cache) return;
  _cache.set(cacheKey, {
    expiresAt: Date.now() + ttlMs,
    data: data,
  });
  // Enforce a reasonable size limit (10k entries) to prevent memory leaks
  if (_cache.size > 10000) {
    const iter = _cache.keys();
    let oldestKey = iter.next().value;
    // Delete the oldest ~20% of entries
    for (let i = 0; i < 2000 && oldestKey; i++) {
      _cache.delete(oldestKey);
      oldestKey = iter.next().value;
    }
  }
}

/**
 * Compute a compound cache key: MD5(URL|header1:value1|...)
 */
function getCacheKey(url, reqHeaders) {
  const parts = [url];

  if (reqHeaders && typeof reqHeaders === "object") {
    for (const headerName of VARY_KEY_HEADERS) {
      const rawValue = getHeaderCaseInsensitive(reqHeaders, headerName);
      if (rawValue && String(rawValue).trim() !== "") {
        parts.push(headerName + ":" + rawValue.toLowerCase().replace(/\s/g, ""));
      } else {
        parts.push(headerName + ":<none>");
      }
    }
  } else {
    for (const headerName of VARY_KEY_HEADERS) {
      parts.push(headerName + ":<none>");
    }
  }

  return md5Hex(parts.join("|"));
}

function getHeaderCaseInsensitive(headers, targetKey) {
  const target = targetKey.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === target) return headers[k];
  }
  return null;
}

function md5Hex(input) {
  const { createHash } = require("crypto");
  return createHash("md5").update(input).digest("hex");
}

/**
 * Check if a request is cacheable (GET, no body, no auth headers, cache enabled).
 */
function canUseCache(req) {
  if (CACHE_TTL_MS <= 0) return false;
  if ((req.m || "GET") !== "GET") return false;
  if (req.b) return false;
  if (!req.u || !/^https?:\/\//i.test(req.u)) return false;

  if (req.h && typeof req.h === "object") {
    for (const k of Object.keys(req.h)) {
      if (CACHE_BUSTING_HEADERS.has(k.toLowerCase())) return false;
    }
  }

  return true;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function decodeBase64(input) {
  return Buffer.from(input, "base64");
}

function encodeBase64(bytes) {
  if (bytes instanceof Uint8Array || bytes instanceof Buffer) {
    return Buffer.from(bytes).toString("base64");
  }
  return Buffer.from(bytes).toString("base64");
}

/**
 * Create a response object for the Netlify Function handler.
 */
function jsonResponse(data, statusCode = 200, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(data),
  };
}

/**
 * Return decoy HTML or JSON error based on DIAGNOSTIC_MODE.
 */
function decoyOrError(jsonBody, status) {
  if (DIAGNOSTIC_MODE) return jsonResponse(jsonBody, status);
  return {
    statusCode: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: DECOY_HTML,
  };
}

/**
 * Strip hop-by-hop and IP-leak headers from the client's forwarded headers.
 */
function sanitizeRequestHeaders(h) {
  const out = {};
  if (!h || typeof h !== "object") return out;
  for (const [k, v] of Object.entries(h)) {
    if (!k) continue;
    if (STRIP_REQUEST_HEADERS.has(k.toLowerCase())) continue;
    out[k] = String(v ?? "");
  }
  return out;
}

/**
 * Convert a fetch Response's Headers to a plain object, stripping
 * framing headers that describe the fetch transport rather than the
 * destination's actual response.
 */
function responseHeadersToRecord(headers) {
  const out = {};
  if (typeof headers.forEach === "function") {
    headers.forEach((value, key) => {
      const lk = key.toLowerCase();
      if (STRIP_RESPONSE_HEADERS.has(lk)) return;
      out[key] = value;
    });
  }
  return out;
}

// ── Single Request Handler ─────────────────────────────────────────────

async function handleSingle(req) {
  const url = String(req.u ?? "");
  if (!url.match(/^https?:\/\//i)) {
    return jsonResponse({ e: "bad url" }, 400);
  }

  const method = String(req.m ?? "GET").toUpperCase();
  const headers = sanitizeRequestHeaders(req.h);
  const followRedirects = req.r !== false;

  // Base64-encoded body
  let body = null;
  if (typeof req.b === "string" && req.b.length > 0) {
    try {
      body = decodeBase64(req.b);
    } catch {
      return jsonResponse({ e: "bad base64" }, 400);
    }
  }

  // Content type override
  let contentType = null;
  if (typeof req.ct === "string" && req.ct.length > 0) {
    contentType = req.ct;
  }

  // ── Optional cache path ──────────────────────────────────
  // Only entered when CACHE_TTL_MS is configured and the request
  // qualifies as a public, cacheable GET.
  if (canUseCache(req)) {
    const cacheKey = getCacheKey(url, headers);
    const cached = cacheGet(cacheKey);
    if (cached) {
      return jsonResponse({
        s: cached.status,
        h: JSON.parse(cached.headersJson),
        b: cached.bodyB64,
        cached: true,
      });
    }
  }

  // Build the fetch options
  const fetchOpts = {
    method,
    headers,
    redirect: followRedirects ? "follow" : "manual",
  };

  if (body) {
    fetchOpts.body = body;
    if (contentType) {
      fetchOpts.headers["content-type"] = contentType;
    }
  }

  try {
    const resp = await fetch(url, fetchOpts);
    const data = new Uint8Array(await resp.arrayBuffer());
    const respHeaders = responseHeadersToRecord(resp.headers);
    const bodyB64 = encodeBase64(data);

    // Store in cache if applicable
    if (canUseCache(req) && resp.status >= 200 && resp.status < 500) {
      // Determine TTL from Cache-Control if possible
      let ttlMs = CACHE_TTL_MS;
      const cc = resp.headers.get("cache-control");
      if (cc) {
        const maxAge = cc.match(/max-age=(\d+)/);
        if (maxAge) {
          ttlMs = Math.min(parseInt(maxAge[1], 10) * 1000, CACHE_TTL_MS);
        }
        if (/no-cache|no-store|private/i.test(cc)) {
          ttlMs = 0;
        }
      }
      if (ttlMs > 0) {
        cacheSet(getCacheKey(url, headers), {
          status: resp.status,
          headersJson: JSON.stringify(respHeaders),
          bodyB64: bodyB64,
        }, ttlMs);
      }
    }

    return jsonResponse({
      s: resp.status,
      h: respHeaders,
      b: bodyB64,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse({ e: "fetch failed: " + message }, 502);
  }
}

// ── Batch Request Handler ──────────────────────────────────────────────

async function handleBatch(items) {
  const results = [];

  for (const item of items) {
    if (!item || typeof item !== "object") {
      results.push({ e: "bad item" });
      continue;
    }

    const obj = item;
    const url = String(obj.u ?? "");

    if (!url.match(/^https?:\/\//i)) {
      results.push({ e: "bad url" });
      continue;
    }

    try {
      const method = String(obj.m ?? "GET").toUpperCase();
      const headers = sanitizeRequestHeaders(obj.h);
      const followRedirects = obj.r !== false;

      let body = null;
      if (typeof obj.b === "string" && obj.b.length > 0) {
        try {
          body = decodeBase64(obj.b);
        } catch {
          results.push({ e: "bad base64" });
          continue;
        }
      }

      let contentType = null;
      if (typeof obj.ct === "string" && obj.ct.length > 0) {
        contentType = obj.ct;
      }

      const fetchOpts = {
        method,
        headers,
        redirect: followRedirects ? "follow" : "manual",
      };

      if (body) {
        fetchOpts.body = body;
        if (contentType) {
          fetchOpts.headers["content-type"] = contentType;
        }
      }

      const resp = await fetch(url, fetchOpts);
      const data = new Uint8Array(await resp.arrayBuffer());
      const respHeaders = responseHeadersToRecord(resp.headers);

      results.push({
        s: resp.status,
        h: respHeaders,
        b: encodeBase64(data),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ e: "fetch failed: " + message });
    }
  }

  return jsonResponse({ q: results });
}

// ── Request Router ────────────────────────────────────────────────────

/**
 * Main request handler for the Netlify Function.
 *
 * Netlify Functions receive an `event` object with:
 *   - event.httpMethod  (string): GET, POST, etc.
 *   - event.body        (string): raw request body (JSON string)
 *   - event.headers     (object): request headers
 *   - event.path        (string): the URL path
 *   - event.queryStringParameters (object): parsed query params
 */
exports.handler = async function (event, context) {
  // ── CORS headers ──────────────────────────────────────────
  // Compute allowed origin from the request's Origin header
  const corsHeaders = {};
  const origin = event.headers.origin || event.headers.Origin;
  if (origin) {
    if (
      ALLOWED_ORIGINS.length === 0 ||
      ALLOWED_ORIGINS.includes(origin) ||
      ALLOWED_ORIGINS.includes("*")
    ) {
      corsHeaders["access-control-allow-origin"] = origin;
      corsHeaders["access-control-allow-methods"] = "POST, GET, OPTIONS";
      corsHeaders["access-control-allow-headers"] = "content-type";
    }
  }

  // Handle CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: corsHeaders,
      body: "",
    };
  }

  // ── GET /quota?k=<AUTH_KEY> — diagnostic endpoint ─────────
  if (event.httpMethod === "GET") {
    const queryParams = event.queryStringParameters || {};
    if (queryParams.k === AUTH_KEY && AUTH_KEY !== "CHANGE_ME_TO_A_STRONG_SECRET") {
      return jsonResponse({ remaining: QUOTA_CEILING }, 200, corsHeaders);
    }
    return {
      statusCode: 200,
      headers: { "content-type": "text/html; charset=utf-8", ...corsHeaders },
      body: DECOY_HTML,
    };
  }

  // Only POST for the relay protocol
  if (event.httpMethod !== "POST") {
    return decoyOrError({ e: "method_not_allowed" }, 405);
  }

  // Fail-closed if AUTH_KEY is still the placeholder
  if (AUTH_KEY === "CHANGE_ME_TO_A_STRONG_SECRET") {
    return jsonResponse(
      { e: "configure AUTH_KEY in environment variables" },
      503,
      corsHeaders,
    );
  }

  // Initialize the in-memory cache on first request
  initCache();

  // Parse JSON body — failures are probe-shaped, decoy them
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return decoyOrError({ e: "bad_json" }, 400);
  }
  if (!body || typeof body !== "object") {
    return decoyOrError({ e: "bad_json" }, 400);
  }

  // Auth check
  if (body.k !== AUTH_KEY) {
    return decoyOrError({ e: "unauthorized" }, 401);
  }

  // Quota probe: { k, op: "quota" }
  if (body.op === "quota") {
    return jsonResponse({ remaining: QUOTA_CEILING }, 200, corsHeaders);
  }

  // Batch mode: { k, q: [...] }
  if (Array.isArray(body.q)) {
    const resp = await handleBatch(body.q);
    resp.headers = { ...resp.headers, ...corsHeaders };
    return resp;
  }

  // Single mode
  const resp = await handleSingle(body);
  resp.headers = { ...resp.headers, ...corsHeaders };
  return resp;
};
