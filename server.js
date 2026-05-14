// JobSlot AI — Jobber Proxy Server v14
// OAuth2 + persistent tokens + AI scheduling + quote lookup + distance
// Token management: refresh lock, backoff, change-only saves to prevent race conditions

const express = require("express");
const path = require("path");
const app = express();
const PORT = process.env.PORT || 3000;

const JOBBER_CLIENT_ID     = process.env.JOBBER_CLIENT_ID;
const JOBBER_CLIENT_SECRET = process.env.JOBBER_CLIENT_SECRET;
const RENDER_API_KEY       = process.env.RENDER_API_KEY;
const RENDER_SERVICE_ID    = process.env.RENDER_SERVICE_ID;
const JOBBER_API_URL       = "https://api.getjobber.com/api/graphql";
const JOBBER_TOKEN_URL     = "https://api.getjobber.com/api/oauth/token";
const JOBBER_AUTH_URL      = "https://api.getjobber.com/api/oauth/authorize";
const JOBBER_API_VERSION   = "2025-04-16";

// Token store — loaded from env vars on cold start, kept in memory
let tokenStore = {
  accessToken:  process.env.JOBBER_ACCESS_TOKEN  || null,
  refreshToken: process.env.JOBBER_REFRESH_TOKEN || null,
  // On cold start we don't know when the token expires, so set expiresAt=0
  // to trigger one refresh, then cache the result for the full token lifetime
  expiresAt: 0,
};

// Refresh lock — prevents multiple concurrent requests all triggering a refresh
let refreshPromise = null;

// Backoff state — after a failed refresh, wait before retrying
let lastRefreshFailAt = 0;
const REFRESH_BACKOFF_MS = 60 * 1000; // 1 minute cooldown after failure

async function saveTokensToRender(tokens) {
  if (!RENDER_API_KEY || !RENDER_SERVICE_ID) return;
  // Only save if tokens actually changed from what's in env vars
  // This prevents a dying instance from overwriting a freshly saved token
  if (tokens.accessToken === process.env.JOBBER_ACCESS_TOKEN &&
      tokens.refreshToken === process.env.JOBBER_REFRESH_TOKEN) {
    console.log("Tokens unchanged — skipping Render save.");
    return;
  }
  try {
    await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${RENDER_API_KEY}`, "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify([
        { key: "JOBBER_ACCESS_TOKEN",  value: tokens.accessToken  || "" },
        { key: "JOBBER_REFRESH_TOKEN", value: tokens.refreshToken || "" },
        { key: "JOBBER_CLIENT_ID",     value: JOBBER_CLIENT_ID    || "" },
        { key: "JOBBER_CLIENT_SECRET", value: JOBBER_CLIENT_SECRET|| "" },
        { key: "RENDER_API_KEY",       value: RENDER_API_KEY      || "" },
        { key: "RENDER_SERVICE_ID",    value: RENDER_SERVICE_ID   || "" },
        { key: "ANTHROPIC_API_KEY",    value: process.env.ANTHROPIC_API_KEY || "" },
        { key: "GOOGLE_MAPS_API_KEY",  value: process.env.GOOGLE_MAPS_API_KEY || "" },
      ]),
    });
    // Update process.env so future comparisons are accurate
    process.env.JOBBER_ACCESS_TOKEN  = tokens.accessToken;
    process.env.JOBBER_REFRESH_TOKEN = tokens.refreshToken;
    console.log("Tokens changed — saved to Render.");
  } catch(e) { console.log("Render save error:", e.message); }
}

async function _doRefresh() {
  if (!tokenStore.refreshToken) throw new Error("NO_REFRESH_TOKEN");
  console.log("Refreshing access token...");
  const res = await fetch(JOBBER_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: JOBBER_CLIENT_ID,
      client_secret: JOBBER_CLIENT_SECRET,
      refresh_token: tokenStore.refreshToken,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    lastRefreshFailAt = Date.now();
    throw new Error(`Refresh failed (${res.status}): ${txt.slice(0,200)}`);
  }
  const data = await res.json();
  tokenStore.accessToken  = data.access_token;
  tokenStore.refreshToken = data.refresh_token || tokenStore.refreshToken;
  // Use full token lifetime — don't refresh early unless truly needed
  tokenStore.expiresAt    = Date.now() + (data.expires_in || 3600) * 1000;
  lastRefreshFailAt = 0; // reset backoff on success
  await saveTokensToRender(tokenStore);
  console.log(`Token refreshed. Valid for ${Math.round((tokenStore.expiresAt - Date.now()) / 60000)} min.`);
  return tokenStore.accessToken;
}

async function refreshAccessToken() {
  // If a refresh is already in flight, wait for it instead of firing another
  if (refreshPromise) {
    console.log("Refresh already in progress — waiting...");
    return refreshPromise;
  }
  // Backoff: don't retry within 1 minute of a failure
  if (lastRefreshFailAt && Date.now() - lastRefreshFailAt < REFRESH_BACKOFF_MS) {
    const waitSec = Math.ceil((REFRESH_BACKOFF_MS - (Date.now() - lastRefreshFailAt)) / 1000);
    throw new Error(`Token refresh on cooldown — try again in ${waitSec}s`);
  }
  refreshPromise = _doRefresh().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function getValidToken() {
  // Token is valid and not expiring soon (5 min buffer) — return immediately, no API call
  if (tokenStore.accessToken && Date.now() < tokenStore.expiresAt - 300000) {
    return tokenStore.accessToken;
  }
  if (tokenStore.refreshToken) return await refreshAccessToken();
  throw new Error("NO_REFRESH_TOKEN");
}

function getWeekRange(date) {
  const d = new Date(date);
  const day = d.getUTCDay();
  const diffToMon = (day === 0 ? -6 : 1 - day);
  const mon = new Date(d);
  mon.setUTCDate(d.getUTCDate() + diffToMon);
  mon.setUTCHours(0, 0, 0, 0);
  const fri = new Date(mon);
  fri.setUTCDate(mon.getUTCDate() + 4);
  fri.setUTCHours(23, 59, 59, 999);
  return { gte: mon.toISOString(), lte: fri.toISOString() };
}

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(express.json());

app.get("/", (req, res) => {
  const { gte, lte } = getWeekRange(new Date());
  res.json({ status: "JobSlot AI Proxy v14", timestamp: new Date().toISOString(), currentWeek: { gte, lte }, connected: !!tokenStore.refreshToken });
});

app.get("/connect", (req, res) => {
  const connected = !!tokenStore.refreshToken;
  res.send(`<!DOCTYPE html><html><head><title>Connect Jobber</title>
  <style>body{font-family:'Segoe UI',sans-serif;background:#0c0f1a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .box{background:#0f172a;border:1px solid #1e293b;border-radius:16px;padding:40px;width:420px;text-align:center}
  h1{color:#38bdf8;font-size:22px;margin-bottom:8px}p{color:#64748b;font-size:13px;margin-bottom:24px;line-height:1.6}
  .btn{display:inline-block;padding:12px 28px;background:#0284c7;color:#fff;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px}
  .connected{background:#064e3b;border:1px solid #065f46;border-radius:10px;padding:14px;color:#4ade80;font-size:13px;margin-bottom:16px}
  .reconnect{font-size:12px;color:#475569;margin-top:12px}.reconnect a{color:#38bdf8}</style></head>
  <body><div class="box"><h1>⚡ JobSlot AI</h1>
  <p>Connect your Jobber account once and your schedule syncs automatically forever.</p>
  ${connected
    ? `<div class="connected">✅ Jobber is connected!<br><small style="opacity:.7">Tokens refresh automatically.</small></div>
       <a href="/app" class="btn">Open Scheduler →</a>
       <div class="reconnect"><a href="/auth">Reconnect Jobber</a></div>`
    : `<a href="/auth" class="btn">Connect to Jobber →</a>`}
  </div></body></html>`);
});

app.get("/auth", (req, res) => {
  if (!JOBBER_CLIENT_ID) return res.status(500).send("JOBBER_CLIENT_ID not configured.");
  const redirectUri = "https://jobslot-proxy.onrender.com/auth/callback";
  const scope = "read_clients read_jobs read_visits read_quotes";
  res.redirect(`${JOBBER_AUTH_URL}?client_id=${JOBBER_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}`);
});

app.get("/auth/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.send(`<h2 style="color:red;font-family:sans-serif">Failed: ${error||"No code"}</h2>`);
  try {
    const redirectUri = "https://jobslot-proxy.onrender.com/auth/callback";
    const tokenRes = await fetch(JOBBER_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: JOBBER_CLIENT_ID, client_secret: JOBBER_CLIENT_SECRET, code, redirect_uri: redirectUri }),
    });
    if (!tokenRes.ok) { const txt = await tokenRes.text(); throw new Error(`Token exchange failed (${tokenRes.status}): ${txt.slice(0,300)}`); }
    const data = await tokenRes.json();
    tokenStore.accessToken  = data.access_token;
    tokenStore.refreshToken = data.refresh_token;
    tokenStore.expiresAt    = Date.now() + (data.expires_in || 3300) * 1000;
    await saveTokensToRender(tokenStore);
    console.log("OAuth complete. Tokens saved.");
    res.redirect("/connect");
  } catch(err) { res.status(500).send(`<h2 style="color:red;font-family:sans-serif">Error: ${err.message}</h2>`); }
});

app.get("/app", (req, res) => { res.sendFile(path.join(__dirname, "app.html")); });

// ─── DISTANCE MATRIX ──────────────────────────────────────────────────────────
app.get("/distance", async (req, res) => {
  const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY;
  if (!MAPS_KEY) return res.status(500).json({ error: "GOOGLE_MAPS_API_KEY not configured." });

  const { origin, destination } = req.query;
  if (!origin || !destination) return res.status(400).json({ error: "Missing origin or destination." });

  try {
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?` +
      new URLSearchParams({ origins: origin, destinations: destination, units: "imperial", key: MAPS_KEY });

    const gmRes = await fetch(url);
    if (!gmRes.ok) throw new Error(`Google Maps API ${gmRes.status}`);

    const data = await gmRes.json();
    console.log("Distance Matrix response:", JSON.stringify(data).slice(0, 300));

    if (data.status !== "OK") throw new Error(`Maps API status: ${data.status}`);

    const element = data.rows?.[0]?.elements?.[0];
    if (!element || element.status !== "OK") {
      throw new Error(`No route found: ${element?.status || "unknown"}`);
    }

    // distance.value is in meters — convert to miles
    const meters = element.distance.value;
    const miles = Math.round((meters / 1609.34) * 10) / 10;

    res.json({ success: true, miles, text: element.distance.text, duration: element.duration.text });
  } catch(err) {
    console.error("Distance error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── QUOTE LOOKUP ─────────────────────────────────────────────────────────────
app.get("/quote/:id", async (req, res) => {
  try {
    const token = await getValidToken();
    const quoteNumber = req.params.id;
    console.log(`Looking up quote: ${quoteNumber}`);

    // Jobber requires quoteNumber as IntRangeInput: { min: N, max: N }
    const qNum = parseInt(quoteNumber);
    // Keep query minimal — Jobber charges per field, lineItems are expensive
    const searchQuery = `{
      quotes(filter: { quoteNumber: { min: ${qNum}, max: ${qNum} } }) {
        nodes {
          id
          quoteNumber
          title
          amounts { total }
          client { name companyName }
          property { address { street city province postalCode } }
          lineItems(first: 20) {
            nodes { name unitPrice quantity totalPrice }
          }
        }
      }
    }`;

    const jobberRes = await fetch(JOBBER_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-JOBBER-GRAPHQL-VERSION": JOBBER_API_VERSION
      },
      body: JSON.stringify({ query: searchQuery }),
    });

    if (!jobberRes.ok) {
      const t = await jobberRes.text();
      throw new Error(`Jobber API ${jobberRes.status}: ${t.slice(0,200)}`);
    }

    const raw = await jobberRes.json();
    console.log("Quote raw response:", JSON.stringify(raw).slice(0, 500));

    if (raw.errors) {
      const msg = raw.errors[0]?.message || "Unknown GraphQL error";
      console.error("Full GraphQL errors:", JSON.stringify(raw.errors));
      throw new Error(`Jobber GraphQL: ${msg}`);
    }

    const nodes = raw?.data?.quotes?.nodes || [];
    if (nodes.length === 0) {
      return res.status(404).json({ error: `Quote #${quoteNumber} not found in Jobber.` });
    }

    const q = nodes[0];
    const addr = q.property?.address;
    const addressStr = addr
      ? [addr.street, addr.city, addr.province, addr.postalCode].filter(Boolean).join(", ")
      : "";

    const lineItems = (q.lineItems?.nodes || []).map(li => ({
      desc: li.name || "",
      cost: parseFloat(li.totalPrice || 0),
      unitPrice: parseFloat(li.unitPrice || 0),
      quantity: parseFloat(li.quantity || 1),
    }));

    const clientName = q.client?.companyName || q.client?.name || "";
    const total = parseFloat(q.amounts?.total || 0);

    res.json({
      success: true,
      quote: {
        id: q.id,
        quoteNumber: q.quoteNumber,
        title: q.title || "",
        message: q.message || "",
        clientName,
        address: addressStr,
        total,
        lineItems,
      }
    });

  } catch(err) {
    console.error("Quote lookup error:", err.message);
    if (err.message === "NO_REFRESH_TOKEN") {
      return res.status(401).json({ error: "NOT_CONNECTED", message: "Visit /connect to authorize." });
    }
    res.status(500).json({ error: err.message });
  }
});

// ─── JOBBER SCHEDULE SYNC ─────────────────────────────────────────────────────
app.get("/jobber/schedule", async (req, res) => {
  try {
    const token = await getValidToken();
    const targetDate = req.query.week ? new Date(req.query.week) : new Date();
    const { gte, lte } = getWeekRange(targetDate);
    console.log(`Syncing Jobber: ${gte} → ${lte}`);
    const query = `{ visits(filter: { startAt: { after: "${gte}", before: "${lte}" } }) { nodes { id title startAt duration client { name } job { total } } } }`;
    const jobberRes = await fetch(JOBBER_API_URL, {
      method: "POST",
      headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "X-JOBBER-GRAPHQL-VERSION": JOBBER_API_VERSION },
      body: JSON.stringify({ query }),
    });
    if (!jobberRes.ok) { const t = await jobberRes.text(); throw new Error(`Jobber API ${jobberRes.status}: ${t.slice(0,200)}`); }
    const raw = await jobberRes.json();
    if (raw.errors) {
      const msg = raw.errors[0]?.message || "Unknown error";
      if (msg.toLowerCase().includes("throttl")) return res.status(429).json({ error: "Rate limit — wait 2 minutes." });
      throw new Error(`Jobber GraphQL: ${msg}`);
    }
    const jobs = normalizeJobberResponse(raw?.data?.visits?.nodes || []);
    console.log(`Returning ${jobs.length} jobs`);
    res.json({ success: true, weekStart: gte, weekEnd: lte, count: jobs.length, jobs });
  } catch(err) {
    console.error("Sync error:", err.message);
    if (err.message === "NO_REFRESH_TOKEN") return res.status(401).json({ error: "NOT_CONNECTED", message: "Visit /connect to authorize." });
    res.status(500).json({ error: err.message });
  }
});

// ─── AI SCHEDULING ────────────────────────────────────────────────────────────
app.post("/ai/schedule", async (req, res) => {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured." });
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 1000, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await aiRes.json();
    res.json(data);
  } catch(err) {
    console.error("AI error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── NORMALIZE JOBBER VISITS ──────────────────────────────────────────────────
function normalizeJobberResponse(nodes) {
  const DAY_MAP = ["SUN","MON","TUE","WED","THU","FRI","SAT"];
  function getEasternOffset(date) {
    const year = date.getUTCFullYear();
    const mar = new Date(Date.UTC(year, 2, 1));
    const dstStart = new Date(Date.UTC(year, 2, 8 + (7 - mar.getUTCDay()) % 7, 7));
    const nov = new Date(Date.UTC(year, 10, 1));
    const dstEnd = new Date(Date.UTC(year, 10, 1 + (7 - nov.getUTCDay()) % 7, 6));
    return (date >= dstStart && date < dstEnd) ? -4 : -5;
  }
  return nodes.map(item => {
    if (!item.startAt) return null;
    const utcStart  = new Date(item.startAt);
    const offset    = getEasternOffset(utcStart);
    const localDate = new Date(utcStart.getTime() + offset * 3600000);
    const dayShort  = DAY_MAP[localDate.getUTCDay()];
    const startHour = localDate.getUTCHours();
    const estHours  = item.duration ? Math.round((item.duration / 60) * 2) / 2 : 2;
    const revenue   = parseFloat(item.job?.total || 0);
    const name      = item.client?.name || item.title?.split(" - ")[0] || "Jobber Job";
    return { id: item.id, name, service: "Jobber Job", address: "", revenue, estimatedHours: estHours, distanceMiles: 0, preferredDay: "", preferredTime: "", lineItems: [], scheduledDay: dayShort, scheduledHour: startHour, fromJobber: true };
  }).filter(j => j && j.scheduledDay && j.scheduledHour !== null);
}

app.listen(PORT, () => console.log(`JobSlot AI Proxy v14 on port ${PORT}`));
