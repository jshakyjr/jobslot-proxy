// JobSlot AI — Jobber Proxy Server v5
// Calls Jobber GraphQL API directly — no Make.com needed
// Deploy to Render.com with JOBBER_ACCESS_TOKEN environment variable

const express = require("express");
const path = require("path");
const app = express();
const PORT = process.env.PORT || 3000;

const JOBBER_ACCESS_TOKEN = process.env.JOBBER_ACCESS_TOKEN;
const JOBBER_API_URL      = "https://api.getjobber.com/api/graphql";
const JOBBER_API_VERSION  = "2025-04-16";

// Permissive CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(express.json());

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
    status: "JobSlot AI Proxy running v5 — direct Jobber API",
    timestamp: new Date().toISOString(),
    currentWeek: { gte, lte },
    tokenConfigured: !!JOBBER_ACCESS_TOKEN,
  });
});

// ── Serve the scheduling app ───────────────────────────────────────────────
app.get("/app", (req, res) => {
  res.sendFile(path.join(__dirname, "app.html"));
});

// ── Main sync endpoint ─────────────────────────────────────────────────────
app.get("/jobber/schedule", async (req, res) => {
  if (!JOBBER_ACCESS_TOKEN) {
    return res.status(500).json({ error: "JOBBER_ACCESS_TOKEN environment variable not set." });
  }

  try {
    const targetDate = req.query.week ? new Date(req.query.week) : new Date();
    const { gte, lte } = getWeekRange(targetDate);
    console.log(`Syncing Jobber directly: ${gte} → ${lte}`);

    const query = `{
      visits(filter: { startAt: { gte: "${gte}", lte: "${lte}" } }) {
        nodes {
          id
          title
          startAt
          duration
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
        "Authorization": `Bearer ${JOBBER_ACCESS_TOKEN}`,
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
      throw new Error(`Jobber GraphQL error: ${raw.errors[0]?.message || "Unknown"}`);
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
      id:             item.id,
      name:           item.client?.name || item.title || "Jobber Job",
      service:        item.lineItems?.nodes?.[0]?.name || "Service",
      address,
      revenue,
      estimatedHours: estHours,
      distanceMiles:  0,
      preferredDay:   "",
      preferredTime:  "",
      lineItems:      (item.lineItems?.nodes || []).map(li => ({
        desc: li.name,
        cost: parseFloat(li.unitPrice || 0),
      })),
      scheduledDay:   dayShort,
      scheduledHour:  startHour,
      fromJobber:     true,
    };
  }).filter(j => j.scheduledDay && j.scheduledHour !== null);
}

app.listen(PORT, () => console.log(`JobSlot AI Proxy v5 on port ${PORT}`));
