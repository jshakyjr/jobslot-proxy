// JobSlot AI — Jobber Proxy Server v15
// 3-month sync | batch quotes | safe token merge | quota-conscious queries

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

let tokenStore = {
  accessToken:  process.env.JOBBER_ACCESS_TOKEN  || null,
  refreshToken: process.env.JOBBER_REFRESH_TOKEN || null,
  expiresAt: 0,
};
let refreshPromise = null;
let lastRefreshFailAt = 0;
const REFRESH_BACKOFF_MS = 60 * 1000;

async function saveTokensToRender(tokens) {
  if (!RENDER_API_KEY || !RENDER_SERVICE_ID) return;
  if (tokens.accessToken === process.env.JOBBER_ACCESS_TOKEN &&
      tokens.refreshToken === process.env.JOBBER_REFRESH_TOKEN) {
    console.log("Tokens unchanged — skipping Render save.");
    return;
  }
  try {
    const getRes = await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`, {
      headers: { "Authorization": `Bearer ${RENDER_API_KEY}`, "Accept": "application/json" },
    });
    let currentVars = [];
    if (getRes.ok) {
      const raw = await getRes.json();
      currentVars = Array.isArray(raw)
        ? raw.map(v => ({ key: v.envVar?.key || v.key, value: v.envVar?.value ?? v.value ?? "" }))
        : [];
    }
    const updates = { JOBBER_ACCESS_TOKEN: tokens.accessToken || "", JOBBER_REFRESH_TOKEN: tokens.refreshToken || "" };
    const merged = currentVars.map(v => updates[v.key] !== undefined ? { key: v.key, value: updates[v.key] } : v);
    Object.entries(updates).forEach(([key, value]) => {
      if (!merged.find(v => v.key === key)) merged.push({ key, value });
    });
    await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${RENDER_API_KEY}`, "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(merged),
    });
    process.env.JOBBER_ACCESS_TOKEN  = tokens.accessToken;
    process.env.JOBBER_REFRESH_TOKEN = tokens.refreshToken;
    console.log("Tokens saved to Render (safe merge).");
  } catch(e) { console.log("Render save error:", e.message); }
}

async function _doRefresh() {
  if (!tokenStore.refreshToken) throw new Error("NO_REFRESH_TOKEN");
  console.log("Refreshing access token...");
  const res = await fetch(JOBBER_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: JOBBER_CLIENT_ID, client_secret: JOBBER_CLIENT_SECRET, refresh_token: tokenStore.refreshToken }),
  });
  if (!res.ok) {
    const txt = await res.text();
    lastRefreshFailAt = Date.now();
    throw new Error(`Refresh failed (${res.status}): ${txt.slice(0,200)}`);
  }
  const data = await res.json();
  tokenStore.accessToken  = data.access_token;
  tokenStore.refreshToken = data.refresh_token || tokenStore.refreshToken;
  tokenStore.expiresAt    = Date.now() + (data.expires_in || 3600) * 1000;
  lastRefreshFailAt = 0;
  await saveTokensToRender(tokenStore);
  console.log(`Token refreshed. Valid for ${Math.round((tokenStore.expiresAt - Date.now()) / 60000)} min.`);
  return tokenStore.accessToken;
}

async function refreshAccessToken() {
  if (refreshPromise) { console.log("Refresh in progress — waiting..."); return refreshPromise; }
  if (lastRefreshFailAt && Date.now() - lastRefreshFailAt < REFRESH_BACKOFF_MS) {
    const waitSec = Math.ceil((REFRESH_BACKOFF_MS - (Date.now() - lastRefreshFailAt)) / 1000);
    throw new Error(`Token refresh on cooldown — try again in ${waitSec}s`);
  }
  refreshPromise = _doRefresh().finally(() => { refreshPromise = null; });
  return refreshPromise;
}

async function getValidToken() {
  if (tokenStore.accessToken && Date.now() < tokenStore.expiresAt - 300000) return tokenStore.accessToken;
  if (tokenStore.refreshToken) return await refreshAccessToken();
  throw new Error("NO_REFRESH_TOKEN");
}

function get3MonthRange() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const end   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 3, 0, 23, 59, 59, 999));
  return { gte: start.toISOString(), lte: end.toISOString() };
}

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(express.json());

// ─── STARTUP TOKEN VALIDATION ─────────────────────────────────────────────────
// On cold start, attempt a token refresh so we know immediately if it's expired
// rather than failing silently on the first real request.
async function validateTokenOnStartup() {
  if (!tokenStore.refreshToken) return;
  try {
    await getValidToken();
    console.log("Startup token validation OK.");
  } catch(e) {
    console.warn("Startup token validation failed:", e.message);
    console.warn("Visit https://jobslot-proxy.onrender.com/auth to reconnect Jobber.");
  }
}
// Run after a short delay to not block server startup
setTimeout(validateTokenOnStartup, 3000);

app.get("/", (req, res) => {
  const { gte, lte } = get3MonthRange();
  res.json({ status: "JobSlot AI Proxy v15", timestamp: new Date().toISOString(), range: { gte, lte }, connected: !!tokenStore.refreshToken });
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
    ? '<div class="connected">✅ Jobber is connected!<br><small style="opacity:.7">Tokens refresh automatically.</small></div><a href="/app" class="btn">Open Scheduler →</a><div class="reconnect"><a href="/auth">Reconnect Jobber</a></div>'
    : '<a href="/auth" class="btn">Connect to Jobber →</a>'}
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
    if (data.status !== "OK") throw new Error(`Maps API status: ${data.status}`);
    const element = data.rows?.[0]?.elements?.[0];
    if (!element || element.status !== "OK") throw new Error(`No route found: ${element?.status || "unknown"}`);
    const miles = Math.round((element.distance.value / 1609.34) * 10) / 10;
    res.json({ success: true, miles, text: element.distance.text, duration: element.duration.text });
  } catch(err) {
    console.error("Distance error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

async function fetchQuote(token, quoteNumber) {
  const qNum = parseInt(quoteNumber);
  if (!qNum) throw new Error(`Invalid quote number: ${quoteNumber}`);
  const query = `{
    quotes(filter: { quoteNumber: { min: ${qNum}, max: ${qNum} } }) {
      nodes {
        id quoteNumber title
        amounts { total }
        client { name companyName }
        property { address { street city province postalCode } }
        lineItems(first: 15) { nodes { name unitPrice quantity totalPrice } }
      }
    }
  }`;
  const res = await fetch(JOBBER_API_URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "X-JOBBER-GRAPHQL-VERSION": JOBBER_API_VERSION },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`Jobber API ${res.status}: ${t.slice(0,200)}`); }
  const raw = await res.json();
  if (raw.errors) {
    const msg = raw.errors[0]?.message || "GraphQL error";
    console.error("Quote GraphQL errors:", JSON.stringify(raw.errors));
    throw new Error(`Jobber GraphQL: ${msg}`);
  }
  const nodes = raw?.data?.quotes?.nodes || [];
  if (!nodes.length) throw new Error(`Quote #${quoteNumber} not found`);
  const q = nodes[0];
  const addr = q.property?.address;
  return {
    id: q.id,
    quoteNumber: q.quoteNumber,
    title: q.title || "",
    clientName: q.client?.companyName || q.client?.name || "",
    address: addr ? [addr.street, addr.city, addr.province, addr.postalCode].filter(Boolean).join(", ") : "",
    total: parseFloat(q.amounts?.total || 0),
    lineItems: (q.lineItems?.nodes || []).map(li => ({
      desc: li.name || "",
      cost: parseFloat(li.totalPrice || 0),
      unitPrice: parseFloat(li.unitPrice || 0),
      quantity: parseFloat(li.quantity || 1),
    })),
  };
}

app.get("/quote/:id", async (req, res) => {
  try {
    const token = await getValidToken();
    console.log(`Quote lookup: ${req.params.id}`);
    const quote = await fetchQuote(token, req.params.id);
    res.json({ success: true, quote });
  } catch(err) {
    console.error("Quote lookup error:", err.message);
    if (err.message === "NO_REFRESH_TOKEN") return res.status(401).json({ error: "NOT_CONNECTED" });
    res.status(500).json({ error: err.message });
  }
});

app.post("/quotes/batch", async (req, res) => {
  const { quoteNumbers } = req.body;
  if (!Array.isArray(quoteNumbers) || !quoteNumbers.length)
    return res.status(400).json({ error: "Missing quoteNumbers array" });
  if (quoteNumbers.length > 10)
    return res.status(400).json({ error: "Max 10 quotes per batch" });
  try {
    const token = await getValidToken();
    const results = [], errors = [];
    for (let i = 0; i < quoteNumbers.length; i++) {
      try {
        const quote = await fetchQuote(token, quoteNumbers[i].toString().trim());
        results.push({ quoteNumber: quoteNumbers[i], success: true, quote });
      } catch(e) {
        errors.push({ quoteNumber: quoteNumbers[i], error: e.message });
      }
      if (i < quoteNumbers.length - 1) await new Promise(r => setTimeout(r, 350));
    }
    console.log(`Batch: ${results.length} ok, ${errors.length} failed`);
    res.json({ success: true, results, errors });
  } catch(err) {
    console.error("Batch quote error:", err.message);
    if (err.message === "NO_REFRESH_TOKEN") return res.status(401).json({ error: "NOT_CONNECTED" });
    res.status(500).json({ error: err.message });
  }
});

app.get("/jobber/schedule", async (req, res) => {
  try {
    const token = await getValidToken();
    const { gte, lte } = get3MonthRange();
    console.log(`Syncing Jobber 3 months: ${gte} to ${lte}`);
    const now = new Date();
    const mid = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();

    async function fetchChunk(after, before) {
      const query = `{ visits(filter: { startAt: { after: "${after}", before: "${before}" } }) { nodes { id title startAt duration client { name } job { total } } } }`;
      const r = await fetch(JOBBER_API_URL, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "X-JOBBER-GRAPHQL-VERSION": JOBBER_API_VERSION },
        body: JSON.stringify({ query }),
      });
      if (!r.ok) { const t = await r.text(); throw new Error(`Jobber API ${r.status}: ${t.slice(0,200)}`); }
      const raw = await r.json();
      if (raw.errors) {
        const msg = raw.errors[0]?.message || "Unknown";
        if (msg.toLowerCase().includes("throttl")) throw new Error("THROTTLED");
        throw new Error(`Jobber GraphQL: ${msg}`);
      }
      return raw?.data?.visits?.nodes || [];
    }

    let nodes = [];
    try {
      nodes = nodes.concat(await fetchChunk(gte, mid));
      await new Promise(r => setTimeout(r, 300));
      nodes = nodes.concat(await fetchChunk(mid, lte));
    } catch(e) {
      if (e.message === "THROTTLED") return res.status(429).json({ error: "Rate limit — wait 2 minutes." });
      throw e;
    }

    const jobs = normalizeJobberResponse(nodes);
    console.log(`Returning ${jobs.length} jobs`);
    res.json({ success: true, rangeStart: gte, rangeEnd: lte, count: jobs.length, jobs });
  } catch(err) {
    console.error("Sync error:", err.message);
    if (err.message === "NO_REFRESH_TOKEN") return res.status(401).json({ error: "NOT_CONNECTED", message: "Visit /connect to authorize." });
    res.status(500).json({ error: err.message });
  }
});

app.post("/ai/schedule", async (req, res) => {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured." });
  try {
    const { prompt, max_tokens } = req.body;
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: max_tokens||1500, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await aiRes.json();
    res.json(data);
  } catch(err) {
    console.error("AI error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

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
    return {
      id: item.id, name, service: "Jobber Job", address: "",
      revenue, estimatedHours: estHours, distanceMiles: 0,
      preferredDay: "", preferredTime: "", lineItems: [],
      scheduledDay: dayShort, scheduledHour: startHour,
      scheduledDate: localDate.toISOString().split("T")[0],
      fromJobber: true,
    };
  }).filter(j => j && j.scheduledDay && j.scheduledHour !== null);
}

app.listen(PORT, () => {
  console.log(`JobSlot AI Proxy v15 on port ${PORT}`);
  // Ping self every 10 min to prevent Render free tier spin-down
  setInterval(async () => {
    try { await fetch("https://jobslot-proxy.onrender.com/"); }
    catch(e) { console.log("Self-ping failed:", e.message); }
  }, 10 * 60 * 1000);
});
