// JobSlot AI — Jobber Proxy Server v8
// Full OAuth2 flow with refresh tokens — connect once, works forever

const express = require("express");
const path = require("path");
const app = express();
const PORT = process.env.PORT || 3000;

const JOBBER_CLIENT_ID     = process.env.JOBBER_CLIENT_ID;
const JOBBER_CLIENT_SECRET = process.env.JOBBER_CLIENT_SECRET;
const JOBBER_API_URL       = "https://api.getjobber.com/api/graphql";
const JOBBER_TOKEN_URL     = "https://api.getjobber.com/api/oauth/token";
const JOBBER_AUTH_URL      = "https://api.getjobber.com/api/oauth/authorize";
const JOBBER_API_VERSION   = "2025-04-16";

// In-memory token store (persists as long as server is running)
// On Render free tier, this resets when server sleeps — handled by re-auth check
let tokenStore = {
  accessToken:  process.env.JOBBER_ACCESS_TOKEN || null,
  refreshToken: process.env.JOBBER_REFRESH_TOKEN || null,
  expiresAt:    0,
};

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(express.json());

// ── Token management ───────────────────────────────────────────────────────
async function refreshAccessToken() {
  if (!tokenStore.refreshToken) throw new Error("NO_REFRESH_TOKEN");
  console.log("Refreshing access token using refresh token...");
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
  console.log("Token refreshed successfully.");
  return tokenStore.accessToken;
}

async function getValidToken() {
  // If access token is still valid (2 min buffer), use it
  if (tokenStore.accessToken && Date.now() < tokenStore.expiresAt - 120000) {
    return tokenStore.accessToken;
  }
  // Try refresh token
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

// ── Health check ───────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  const { gte, lte } = getWeekRange(new Date());
  res.json({
    status: "JobSlot AI Proxy v8 — OAuth2",
    timestamp: new Date().toISOString(),
    currentWeek: { gte, lte },
    connected: !!tokenStore.refreshToken,
    tokenExpiry: tokenStore.expiresAt ? new Date(tokenStore.expiresAt).toISOString() : "not set",
  });
});

// ── OAuth: Step 1 — Connect page ───────────────────────────────────────────
app.get("/connect", (req, res) => {
  const connected = !!tokenStore.refreshToken;
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Connect Jobber — JobSlot AI</title>
  <style>
    body{font-family:'Segoe UI',sans-serif;background:#0c0f1a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
    .box{background:#0f172a;border:1px solid #1e293b;border-radius:16px;padding:40px;width:400px;text-align:center}
    h1{color:#38bdf8;font-size:22px;margin-bottom:8px}
    p{color:#64748b;font-size:13px;margin-bottom:24px;line-height:1.6}
    .btn{display:inline-block;padding:12px 28px;background:#0284c7;color:#fff;border-radius:10px;text-decoration:none;font-weight:700;font-size:14px;transition:background .2s}
    .btn:hover{background:#0369a1}
    .connected{background:#064e3b;border:1px solid #065f46;border-radius:10px;padding:14px;color:#4ade80;font-size:13px;margin-bottom:16px}
    .reconnect{font-size:12px;color:#475569;margin-top:12px}
    .reconnect a{color:#38bdf8}
  </style>
</head>
<body>
  <div class="box">
    <h1>⚡ JobSlot AI</h1>
    <p>Connect your Jobber account once and your schedule will sync automatically — no tokens, no daily setup.</p>
    ${connected
      ? `<div class="connected">✅ Jobber is connected!<br><small style="opacity:.7">Your schedule syncs automatically.</small></div>
         <a href="/app" class="btn">Open Scheduler →</a>
         <div class="reconnect"><a href="/auth">Reconnect Jobber</a></div>`
      : `<a href="/auth" class="btn">Connect to Jobber →</a>`
    }
  </div>
</body>
</html>`);
});

// ── OAuth: Step 2 — Redirect to Jobber ────────────────────────────────────
app.get("/auth", (req, res) => {
  if (!JOBBER_CLIENT_ID) {
    return res.status(500).send("JOBBER_CLIENT_ID not configured in Render environment.");
  }
  const redirectUri = `https://jobslot-proxy.onrender.com/auth/callback`;
  const authUrl = `${JOBBER_AUTH_URL}?client_id=${JOBBER_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code`;
  res.redirect(authUrl);
});

// ── OAuth: Step 3 — Handle callback from Jobber ───────────────────────────
app.get("/auth/callback", async (req, res) => {
  const { code, error } = req.query;

  if (error || !code) {
    return res.send(`<h2 style="color:red;font-family:sans-serif">Authorization failed: ${error || "No code received"}</h2>`);
  }

  try {
    const redirectUri = `https://jobslot-proxy.onrender.com/auth/callback`;
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

    console.log("OAuth complete. Refresh token obtained.");
    res.redirect("/connect");

  } catch (err) {
    console.error("OAuth callback error:", err.message);
    res.status(500).send(`<h2 style="color:red;font-family:sans-serif">Error: ${err.message}</h2>`);
  }
});

// ── Serve the scheduling app ───────────────────────────────────────────────
app.get("/app", (req, res) => {
  res.sendFile(path.join(__dirname, "app.html"));
});

// ── Main sync endpoint ─────────────────────────────────────────────────────
app.get("/jobber/schedule", async (req, res) => {
  try {
    const token = await getValidToken();
    const targetDate = req.query.week ? new Date(req.query.week) : new Date();
    const { gte, lte } = getWeekRange(targetDate);
    console.log(`Syncing Jobber: ${gte} → ${lte}`);

    const query = `{
      visits(filter: { startAt: { after: "${gte}", before: "${lte}" } }) {
        nodes {
          id title startAt duration
          client { name }
          property { address { street city postalCode } }
          lineItems { nodes { name unitPrice quantity } }
          job { id jobNumber total }
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
        message: "Jobber not connected. Please visit https://jobslot-proxy.onrender.com/connect to authorize."
      });
    }
    res.status(500).json({ error: err.message });
  }
});

// ── Normalize Jobber → JobSlot AI format ──────────────────────────────────
function normalizeJobberResponse(nodes) {
  const DAY_MAP = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  return nodes.map((item) => {
    const start     = item.startAt ? new Date(item.startAt) : null;
    const dayShort  = start ? DAY_MAP[start.getUTCDay()] : null;
    const startHour = start ? start.getUTCHours() : null;
    const estHours  = item.duration ? Math.round((item.duration / 3600) * 2) / 2 : 2;
    const liTotal   = (item.lineItems?.nodes || []).reduce((s, li) =>
      s + parseFloat(li.unitPrice || 0) * parseFloat(li.quantity || 1), 0);
    const revenue   = parseFloat(item.job?.total || liTotal || 0);
    const addr      = item.property?.address;
    const address   = addr ? [addr.street, addr.city, addr.postalCode].filter(Boolean).join(", ") : "";
    return {
      id: item.id, name: item.client?.name || item.title || "Jobber Job",
      service: item.lineItems?.nodes?.[0]?.name || "Service",
      address, revenue, estimatedHours: estHours, distanceMiles: 0,
      preferredDay: "", preferredTime: "",
      lineItems: (item.lineItems?.nodes || []).map(li => ({ desc: li.name, cost: parseFloat(li.unitPrice || 0) })),
      scheduledDay: dayShort, scheduledHour: startHour, fromJobber: true,
    };
  }).filter(j => j.scheduledDay && j.scheduledHour !== null);
}

app.listen(PORT, () => console.log(`JobSlot AI Proxy v8 on port ${PORT}`));
