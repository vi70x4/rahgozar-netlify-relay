# rahgozar Netlify Relay

A drop-in replacement for the rahgozar Google Apps Script relay (`Code.gs`), ported to run as a **Netlify Function**.

Instead of deploying a Google Apps Script and relying on `UrlFetchApp` (with its 20,000 fetches/day quota, 6-minute wall time, and Google datacenter IPs that trigger Cloudflare anti-bot challenges), run this on Netlify's serverless platform — faster, no daily quotas, and deployable from a `git push`.

## Quick comparison

| Feature | Google Apps Script (Code.gs) | This Netlify Function |
|---|---|---|
| **Quota** | 20,000 URL fetches/day | No hard limit (Netlify free: 125K invocations/month) |
| **Timeout** | 6 min per execution | 10s (free), 26s (pro), 900s (blurred/bg) |
| **Response size** | ~50 MB ceiling | 10 MB (free), 25 MB (pro) |
| **Cloudflare anti-bot** | Always flagged (Google IP) | ✓ Uses your provider's IP — less likely to be blocked |
| **Cache** | Google Sheets (optional) | In-memory TTL cache (optional) |
| **Deployment** | Paste code → Deploy | `git push` → Netlify builds |
| **Infra cost** | Free | Free tier (125K requests/mo) |

## How it works

This function implements the **same relay protocol** as the original `Code.gs`:

```
Browser → rahgozar → Netlify Function → Destination (blocked site)
                                      ↕
                              {s, h, b} JSON envelope
```

The rahgozar client (Rust) sends requests wrapped in a JSON envelope:

- **Single**: `POST {k, m, u, h, b, ct, r}` → `{s, h, b}`
- **Batch**: `POST {k, q: [{m,u,h,b,ct,r}, ...]}` → `{q: [{s,h,b}, ...]}`
- **Quota**: `POST {k, op: "quota"}` → `{remaining: N}`

Where:
- `k` = auth key (shared secret)
- `m` = HTTP method (default GET)
- `u` = target URL
- `h` = request headers
- `b` = request body (base64)
- `ct` = content-type override
- `r` = follow redirects (default true)
- `s` = response status code
- `h` = response headers (in the response)
- `b` = response body (base64, in the response)

## Prerequisites

- A [Netlify](https://www.netlify.com/) account (free tier works)
- This repo forked / cloned to your GitHub account
- [Netlify CLI](https://docs.netlify.com/cli/get-started/) (optional, for local dev)
- Node.js 18+ (for local testing)

## Deployment

### Deploy from Netlify Dashboard (easiest — no CLI needed)

1. Go to **https://app.netlify.com/start**
2. Click **Import existing project** → **GitHub**
3. Authorize Netlify to access your repos if prompted
4. Search and select `vi70x4/rahgozar-netlify-relay` (or your fork)
5. Configure deploy settings — Netlify auto-detects everything from `netlify.toml`:
   - **Branch to deploy**: `main`
   - **Build command**: leave blank or `exit 0`
   - **Publish directory**: `.`
6. Click **Show advanced** → **Environment variables** → **Add variable** and set:

   | Variable | Required | Value |
   |---|---|---|
   | `AUTH_KEY` | **Yes** | Your secret (must match `auth_key` in rahgozar `config.json`). Generate one with `openssl rand -hex 32`. |
   | `CACHE_TTL_MS` | No | `60000` for 60s in-memory caching (optional) |
   | `QUOTA_CEILING` | No | What the `op: "quota"` probe reports (default `100000`) |

7. Click **Deploy**

Netlify deploys the function in ~30 seconds. Your relay is immediately live at:

```
https://<your-site>.netlify.app/.netlify/functions/relay
```

For a cleaner URL, uncomment the `[[redirects]]` block in `netlify.toml` and redeploy. Then you can use:

```
https://<your-site>.netlify.app/relay
```

### Deploy via Netlify CLI

```bash
# Install CLI
npm install -g netlify-cli

# Clone the repo
git clone https://github.com/vi70x4/rahgozar-netlify-relay.git
cd rahgozar-netlify-relay

# Deploy
netlify deploy --prod --build
```

You'll be prompted to log in and create a new site. Then set `AUTH_KEY` and other variables in the Netlify dashboard (Site settings → Environment variables).

## Connecting rahgozar

The rahgozar Rust client is hardcoded to connect to `script.google.com` via domain fronting. To route through this Netlify relay instead, you have several options:

### Option A — Thin Apps Script passthrough (recommended)

Deploy a minimal Apps Script that simply forwards every request to your Netlify Function. This preserves the full rahgozar experience (DPI cover, no Rust modifications).

Create a new Apps Script project with this code:

```javascript
function doPost(e) {
  var NETLIFY_URL = "https://your-site.netlify.app/.netlify/functions/relay";
  var payload = e.postData.contents;
  var resp = UrlFetchApp.fetch(NETLIFY_URL, {
    method: "POST",
    payload: payload,
    contentType: "application/json",
    muteHttpExceptions: true,
  });
  return ContentService
    .createTextOutput(resp.getContentText())
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService
    .createTextOutput("OK")
    .setMimeType(ContentService.MimeType.TEXT);
}
```

Deploy as a web app (same way as Code.gs), then point rahgozar at *this* Apps Script's deployment ID.

### Option B — Local proxy

Set `RAHGOZAR_REDIRECT_TARGET` to your Netlify Function URL and run a local proxy that rewrites `script.google.com` connections to your endpoint.

### Option C — Modify rahgozar source

Add a `relay_url` field to rahgozar's `Config` that overrides the hardcoded `script.google.com` host and path.

## Testing locally

```bash
# Install Netlify CLI
npm install -g netlify-cli

# Start local dev server
netlify dev

# Your function will be at http://localhost:8888/.netlify/functions/relay
```

Test with curl:

```bash
# Replace with your actual AUTH_KEY
AUTH_KEY="your-secret-key"

# Single request
curl -X POST http://localhost:8888/.netlify/functions/relay \
  -H "Content-Type: application/json" \
  -d "{\"k\":\"$AUTH_KEY\",\"u\":\"https://httpbin.org/get\"}"

# Quota check
curl -X POST http://localhost:8888/.netlify/functions/relay \
  -H "Content-Type: application/json" \
  -d "{\"k\":\"$AUTH_KEY\",\"op\":\"quota\"}"

# Batch request
curl -X POST http://localhost:8888/.netlify/functions/relay \
  -H "Content-Type: application/json" \
  -d "{\"k\":\"$AUTH_KEY\",\"q\":[{\"u\":\"https://httpbin.org/get\"},{\"u\":\"https://example.com\"}]}"

# GET quota
curl "http://localhost:8888/.netlify/functions/relay?k=$AUTH_KEY"
```

## Security

- **Change `AUTH_KEY`** from the placeholder before deploying. The function returns a 503 error as long as the placeholder is set.
- **Active-probing defense**: Unauthenticated requests get a decoy HTML page that looks like a placeholder web app — indistinguishable from a forgotten deployment to automated scanners.
- **Header sanitization**: Hop-by-hop headers (`X-Forwarded-For`, `Via`, `Forwarded`, etc.) are stripped before forwarding to prevent IP leakage.
- **No open proxy**: Only requests carrying the correct `AUTH_KEY` are relayed.

## Caching

When `CACHE_TTL_MS` is set to a positive value, an in-memory cache stores responses from GET requests and serves them on repeat visits. This reduces upstream fetch overhead for frequently-accessed URLs (API endpoints, favicons, etc.).

The cache is:
- **Vary-aware**: `Accept-Encoding` and `Accept-Language` are hashed into the cache key
- **Size-limited**: capped at 10,000 entries (oldest entries evicted first)
- **TTL-based**: entries expire after `CACHE_TTL_MS` milliseconds
- **Not persistent**: the cache lives in function memory and resets between cold starts

For production use with significant traffic, consider disabling the cache (leave `CACHE_TTL_MS=0`) to avoid per-instance memory bloat.

## Migration from Code.gs

If you're migrating from the Google Apps Script version:

1. Choose a connection method (see "Connecting rahgozar" above)
2. Keep the same `AUTH_KEY` you used in Code.gs
3. Deploy this function
4. The client protocol is identical — no changes needed on the rahgozar side

## Limitations

- **No raw mode**: The `raw: true` flag (used for exit-node outer hop) is not supported in this port. Raw mode is only needed when chaining exit nodes behind a relay, which is a separate deployment pattern.
- **No spreadsheet cache**: The optional Google Sheets cache from Code.gs is replaced with a simpler in-memory cache.
- **Function timeout**: Netlify Functions have a 10s timeout on the free tier. Large page downloads or slow upstreams may hit this limit. Upgrade to a paid plan for 26s or use background functions for 900s.

## Credits

This is a port of the rahgozar project's Google Apps Script relay (`Code.gs`). The original project is by:

- **masterking32/MasterHttpRelayVPN** — the original Python project
- **therealaleph/MasterHttpRelayVPN-RUST** — the Rust port (`mhrv-rs`)
- **dazzling-no-more/rahgozar** — community-maintained fork

See the upstream repos for the full project history and to support the original authors.

## License

MIT — same as the upstream rahgozar project.
