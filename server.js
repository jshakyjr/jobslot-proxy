// JobSlot AI — Jobber Proxy Server v10
// Saves refresh token back to Render environment variables on every OAuth connect
// Survives sleep cycles AND redeploys permanently

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

// In-memory token store — seeded from environment on startup
let tokenStore = {
  accessToken:  process.env.JOBBER_ACCESS_TOKEN  || null,
  refreshToken: process.env.JOBBER_REFRESH_TOKEN || null,
  expiresAt:    0,
};

// ── Save refresh token to Render env vars (survives redeploys) ─────────────
async function saveTokensToRender(tokens) {
  if (!RENDER_API_KEY || !RENDER_SERVICE_ID) {
    console.log("Render API key or service ID not set — skipping persistent save.");
    return;
  }
  try {
    console.log("Saving tokens to Render environment variables...");
    const res = await fetch(`https://api.render.com/v1/services/${RENDER_SERVICE_ID}/env-vars`, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${RENDER_API_KEY}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify([
        { key: "JOBBER_ACCESS_TOKEN",  value: tokens.accessToken  || "" },
        { key: "JOBBER_REFRESH_TOKEN", value: tokens.refreshToken || "" },
        { key: "JOBBER_CLIENT_ID",     value: JOBBER_CLIENT_ID    || "" },
        { key: "JOBBER_CLIENT_SECRET", value: JOBBER_CLIENT_SECRET|| "" },
        { key: "RENDER_API_KEY",       value: RENDER_API_KEY      || "" },
        { key: "RENDER_SERVICE_ID",    value: RENDER_SERVICE_ID   || "" },
        { key: "MAKE_WEBHOOK_URL",     value: process.env.MAKE_WEBHOOK_URL || "" },
      ]),
    });
    if (res.ok) {
      console.log("Tokens saved to Render successfully.");
    } else {
      const txt = await res.text();
      console.log("Render save failed:", res.status, txt.slice(0, 200));
    }
  } catch (e) {
    console.log("Could not save to Render:", e.message);
  }
}

// ── Token refresh ──────────────────────────────────────────────────────────
async function refreshAccessToken() {
  if (!tokenStore.refreshToken) throw new Error("NO_REFRESH_TOKEN");
  console.log("Refreshing access token...");
  const res = await fetch(JOBBER_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "refresh_token",
      client_id:     JOBBER_CLIENT_ID,
      client_secret: JOBBER_CLIENT_SECRET,
      refresh_token: tokenStore.refreshToken,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Refresh failed (${res.status}): ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  tokenStore.accessToken  = data.access_token;
  tokenStore.refreshToken = data.refresh_token || tokenStore.refreshToken;
  tokenStore.expiresAt    = Date.now() + (data.expires_in || 3300) * 1000;
  await saveTokensToRender(tokenStore);
  console.log("Token refreshed and saved.");
  return tokenStore.accessToken;
}

async function getValidToken() {
  if (tokenStore.accessToken && Date.now() < tokenStore.expiresAt - 120000) {
    return tokenStore.accessToken;
  }
  if (tokenStore.refreshToken) {
    return await refreshAccessToken();
  }
  throw new Error("NO_REFRESH_TOKEN");
}

// ── Helpers ────────────────────────────────────────────────────────────────
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

// ── Health check ───────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  const { gte, lte } = getWeekRange(new Date());
  res.json({
    status: "JobSlot AI Proxy v10 — permanent OAuth2",
    timestamp: new Date().toISOString(),
    currentWeek: { gte, lte },
    connected: !!tokenStore.refreshToken,
    renderPersistenceEnabled: !!(RENDER_API_KEY && RENDER_SERVICE_ID),
  });
});

// ── Connect page ───────────────────────────────────────────────────────────
app.get("/connect", (req, res) => {
  const connected = !!tokenStore.refreshToken;
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Connect Jobber — JobSlot AI</title>
  <style>
    body{font-family:'Segoe UI',sans-serif;background:#0c0f1a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
    .box{background:#0f172a;border:1px solid #1e293b;border-radius:16px;padding:40px;width:420px;text-align:center}
    h1{color:#38bdf8;font-size:22px;margin-bottom:8px}
    p{color:#64748b;font-size:13px;margin-bottom:24px;line-height:1.6}
    .btn{display:inline-block;padding:12px 28px;background:#0284c7;color:#fff;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px}
    .btn:hover{background:#0369a1}
    .connected{background:#064e3b;border:1px solid #065f46;border-radius:10px;padding:14px;color:#4ade80;font-size:13px;margin-bottom:16px}
    .reconnect{font-size:12px;color:#475569;margin-top:12px}
    .reconnect a{color:#38bdf8}
  </style>
</head>
<body>
  <div class="box">
    <h1>⚡ JobSlot AI</h1>
    <p>Connect your Jobber account once and your schedule syncs automatically forever.</p>
    ${connected
      ? `<div class="connected">✅ Jobber is connected!<br><small style="opacity:.7">Tokens are saved permanently.</small></div>
         <a href="/app" class="btn">Open Scheduler →</a>
         <div class="reconnect"><a href="/auth">Reconnect Jobber</a></div>`
      : `<a href="/auth" class="btn">Connect to Jobber →</a>`
    }
  </div>
</body>
</html>`);
});

// ── OAuth Step 2 ───────────────────────────────────────────────────────────
app.get("/auth", (req, res) => {
  if (!JOBBER_CLIENT_ID) return res.status(500).send("JOBBER_CLIENT_ID not configured.");
  const redirectUri = "https://jobslot-proxy.onrender.com/auth/callback";
  const authUrl = `${JOBBER_AUTH_URL}?client_id=${JOBBER_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code`;
  res.redirect(authUrl);
});

// ── OAuth Step 3 ───────────────────────────────────────────────────────────
app.get("/auth/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.send(`<h2 style="color:red;font-family:sans-serif">Authorization failed: ${error || "No code"}</h2>`);
  try {
    const redirectUri = "https://jobslot-proxy.onrender.com/auth/callback";
    const tokenRes = await fetch(JOBBER_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type:    "authorization_code",
        client_id:     JOBBER_CLIENT_ID,
        client_secret: JOBBER_CLIENT_SECRET,
        code,
        redirect_uri:  redirectUri,
      }),
    });
    if (!tokenRes.ok) {
      const txt = await tokenRes.text();
      throw new Error(`Token exchange failed (${tokenRes.status}): ${txt.slice(0, 300)}`);
    }
    const data = await tokenRes.json();
    tokenStore.accessToken  = data.access_token;
    tokenStore.refreshToken = data.refresh_token;
    tokenStore.expiresAt    = Date.now() + (data.expires_in || 3300) * 1000;
    await saveTokensToRender(tokenStore);
    console.log("OAuth complete. Tokens saved permanently to Render.");
    res.redirect("/connect");
  } catch (err) {
    console.error("OAuth callback error:", err.message);
    res.status(500).send(`<h2 style="color:red;font-family:sans-serif">Error: ${err.message}</h2>`);
  }
});

// ── Debug endpoint — see raw Jobber data ──────────────────────────────────
app.get("/jobber/debug", async (req, res) => {
  try {
    const token = await getValidToken();
    const { gte, lte } = getWeekRange(new Date());
    const query = `{
      visits(filter: { startAt: { after: "${gte}", before: "${lte}" } }) {
        nodes {
          id title startAt endAt duration
          client { name }
          job { total }
        }
      }
    }`;
    const jobberRes = await fetch(JOBBER_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-JOBBER-GRAPHQL-VERSION": JOBBER_API_VERSION,
      },
      body: JSON.stringify({ query }),
    });
    const raw = await jobberRes.json();
    res.json(raw);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AI scheduling endpoint ─────────────────────────────────────────────────
app.post("/ai/schedule", async (req, res) => {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured." });
  }
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await aiRes.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Serve app ──────────────────────────────────────────────────────────────
app.get("/app", (req, res) => {
  res.sendFile(path.join(__dirname, "app.html"));
});

// ── Sync endpoint ──────────────────────────────────────────────────────────
app.get("/jobber/schedule", async (req, res) => {
  try {
    const token = await getValidToken();
    const targetDate = req.query.week ? new Date(req.query.week) : new Date();
    const { gte, lte } = getWeekRange(targetDate);
    console.log(`Syncing Jobber: ${gte} → ${lte}`);

    const query = `{
      visits(filter: { startAt: { after: "${gte}", before: "${lte}" } }) {
        nodes {
          id
          title
          startAt
          duration
          client { name }
          job { total }
        }
      }
    }`;

    const jobberRes = await fetch(JOBBER_API_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-JOBBER-GRAPHQL-VERSION": JOBBER_API_VERSION,
      },
      body: JSON.stringify({ query }),
    });

    if (!jobberRes.ok) {
      const errText = await jobberRes.text();
      throw new Error(`Jobber API returned ${jobberRes.status}: ${errText.slice(0, 200)}`);
    }

    const raw = await jobberRes.json();
    if (raw.errors) {
      const msg = raw.errors[0]?.message || "Unknown error";
      if (msg.toLowerCase().includes("throttl")) {
        return res.status(429).json({ error: "Rate limit hit. Please wait 2 minutes and try again." });
      }
      throw new Error(`Jobber GraphQL error: ${msg}`);
    }

    const nodes = raw?.data?.visits?.nodes || [];
    const jobs = normalizeJobberResponse(nodes);
    console.log(`Returning ${jobs.length} jobs`);
    res.json({ success: true, weekStart: gte, weekEnd: lte, count: jobs.length, jobs });

  } catch (err) {
    console.error("Sync error:", err.message);
    if (err.message === "NO_REFRESH_TOKEN") {
      return res.status(401).json({
        error: "NOT_CONNECTED",
        message: "Visit https://jobslot-proxy.onrender.com/connect to authorize Jobber."
      });
    }
    res.status(500).json({ error: err.message });
  }
});

// ── Normalize ──────────────────────────────────────────────────────────────
function normalizeJobberResponse(nodes) {
  const DAY_MAP = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  // Eastern time offset: UTC-4 in summer (EDT), UTC-5 in winter (EST)
  // Detect DST: EDT runs from 2nd Sunday in March to 1st Sunday in November
  function getEasternOffset(date) {
    const year = date.getUTCFullYear();
    // 2nd Sunday in March
    const mar = new Date(Date.UTC(year, 2, 1));
    const dstStart = new Date(Date.UTC(year, 2, 8 + (7 - mar.getUTCDay()) % 7, 7));
    // 1st Sunday in November
    const nov = new Date(Date.UTC(year, 10, 1));
    const dstEnd = new Date(Date.UTC(year, 10, 1 + (7 - nov.getUTCDay()) % 7, 6));
    return (date >= dstStart && date < dstEnd) ? -4 : -5;
  }

  return nodes.map((item) => {
    if (!item.startAt) return null;
    const utcStart  = new Date(item.startAt);
    const offset    = getEasternOffset(utcStart);
    // Convert to Eastern local time
    const localMs   = utcStart.getTime() + offset * 3600000;
    const localDate = new Date(localMs);
    const dayShort  = DAY_MAP[localDate.getUTCDay()];
    const startHour = localDate.getUTCHours();
    // Duration is in minutes
    const estHours  = item.duration ? Math.round((item.duration / 60) * 2) / 2 : 2;
    const revenue   = parseFloat(item.job?.total || 0);
    // Clean up title — remove address/description after client name
    const name = item.client?.name || item.title?.split(" - ")[0] || "Jobber Job";
    return {
      id: item.id, name, service: "Jobber Job", address: "", revenue,
      estimatedHours: estHours, distanceMiles: 0,
      preferredDay: "", preferredTime: "", lineItems: [],
      scheduledDay: dayShort, scheduledHour: startHour, fromJobber: true,
    };
  }).filter(j => j && j.scheduledDay && j.scheduledHour !== null);
}

app.listen(PORT, () => console.log(`JobSlot AI Proxy v10 on port ${PORT}`));
