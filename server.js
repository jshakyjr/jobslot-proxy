// JobSlot AI — Jobber Proxy Server v6
// Auto-refreshes Jobber access token using Client ID + Client Secret
// Never need to manually copy tokens again

const express = require("express");
const path = require("path");
const app = express();
const PORT = process.env.PORT || 3000;

const JOBBER_CLIENT_ID     = process.env.JOBBER_CLIENT_ID;
const JOBBER_CLIENT_SECRET = process.env.JOBBER_CLIENT_SECRET;
let   JOBBER_ACCESS_TOKEN  = process.env.JOBBER_ACCESS_TOKEN;
let   tokenExpiry          = 0;

const JOBBER_API_URL      = "https://api.getjobber.com/api/graphql";
const JOBBER_TOKEN_URL    = "https://api.getjobber.com/api/oauth/token";
const JOBBER_API_VERSION  = "2025-04-16";

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(express.json());

async function getValidToken() {
  if (JOBBER_ACCESS_TOKEN && Date.now() < tokenExpiry - 120000) {
    return JOBBER_ACCESS_TOKEN;
  }
  console.log("Refreshing Jobber access token...");
  if (!JOBBER_CLIENT_ID || !JOBBER_CLIENT_SECRET) {
    throw new Error("JOBBER_CLIENT_ID and JOBBER_CLIENT_SECRET must be set in environment variables.");
  }
  const res = await fetch(JOBBER_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type:    "client_credentials",
      client_id:     JOBBER_CLIENT_ID,
      client_secret: JOBBER_CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  JOBBER_ACCESS_TOKEN = data.access_token;
  const expiresIn = data.expires_in || 3300;
  tokenExpiry = Date.now() + expiresIn * 1000;
  console.log(`Token refreshed. Expires in ${expiresIn}s`);
  return JOBBER_ACCESS_TOKEN;
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

app.get("/", (req, res) => {
  const { gte, lte } = getWeekRange(new Date());
  res.json({
    status: "JobSlot AI Proxy running v6 — auto token refresh",
    timestamp: new Date().toISOString(),
    currentWeek: { gte, lte },
    clientIdConfigured: !!JOBBER_CLIENT_ID,
    clientSecretConfigured: !!JOBBER_CLIENT_SECRET,
    tokenExpiry: tokenExpiry ? new Date(tokenExpiry).toISOString() : "not set",
  });
});

app.get("/app", (req, res) => {
  res.sendFile(path.join(__dirname, "app.html"));
});

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
      const msg = raw.errors[0]?.message || "Unknown GraphQL error";
      if (msg.toLowerCase().includes("throttl")) {
        return res.status(429).json({ error: "Jobber rate limit hit. Please wait 2 minutes and try again." });
      }
      throw new Error(`Jobber GraphQL error: ${msg}`);
    }
    const nodes = raw?.data?.visits?.nodes || [];
    const jobs = normalizeJobberResponse(nodes);
    console.log(`Returning ${jobs.length} jobs`);
    res.json({ success: true, weekStart: gte, weekEnd: lte, count: jobs.length, jobs });
  } catch (err) {
    console.error("Sync error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

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

app.listen(PORT, () => console.log(`JobSlot AI Proxy v6 on port ${PORT}`));
