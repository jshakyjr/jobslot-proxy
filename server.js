// JobSlot AI — Jobber Proxy Server v4
// Added permissive CORS to allow Claude artifact sandbox requests

const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

const MAKE_WEBHOOK_URL   = process.env.MAKE_WEBHOOK_URL;
const JOBBER_API_VERSION = "2025-04-16";

// Permissive CORS — allow all origins including Claude artifact sandbox
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json());

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

function buildJobberQuery(gte, lte) {
  return {
    query: `{
      visits(filter: { startAt: { gte: "${gte}", lte: "${lte}" } }) {
        nodes {
          id title startAt duration
          client { name }
          property { address { street city postalCode } }
          lineItems { nodes { name unitPrice quantity } }
          job { id jobNumber total }
        }
      }
    }`,
  };
}

app.get("/", (req, res) => {
  const { gte, lte } = getWeekRange(new Date());
  res.json({ status: "JobSlot AI Proxy running v4", timestamp: new Date().toISOString(), currentWeek: { gte, lte } });
});

app.get("/jobber/schedule", async (req, res) => {
  if (!MAKE_WEBHOOK_URL) {
    return res.status(500).json({ error: "MAKE_WEBHOOK_URL environment variable not set." });
  }
  try {
    const targetDate = req.query.week ? new Date(req.query.week) : new Date();
    const { gte, lte } = getWeekRange(targetDate);
    console.log(`Syncing week: ${gte} to ${lte}`);

    const makeRes = await fetch(MAKE_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "get_schedule",
        weekStart: gte,
        weekEnd: lte,
        jobberQuery: buildJobberQuery(gte, lte),
      }),
    });

    if (!makeRes.ok) throw new Error(`Make returned HTTP ${makeRes.status}`);
    const raw = await makeRes.json();
    const jobs = normalizeJobberResponse(raw);
    res.json({ success: true, weekStart: gte, weekEnd: lte, count: jobs.length, jobs });
  } catch (err) {
    console.error("Sync error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

function normalizeJobberResponse(raw) {
  let nodes = [];
  if (Array.isArray(raw))                  nodes = raw;
  else if (raw?.data?.visits?.nodes)       nodes = raw.data.visits.nodes;
  else if (raw?.visits?.nodes)             nodes = raw.visits.nodes;
  else if (raw?.data?.jobs?.nodes)         nodes = raw.data.jobs.nodes;
  else if (raw?.jobs?.nodes)               nodes = raw.jobs.nodes;
  else if (raw?.nodes)                     nodes = raw.nodes;

  const DAY_MAP = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

  return nodes.map((item) => {
    const start      = item.startAt ? new Date(item.startAt) : null;
    const dayShort   = start ? DAY_MAP[start.getUTCDay()] : null;
    const startHour  = start ? start.getUTCHours() : null;
    const estHours   = item.duration ? Math.round((item.duration / 3600) * 2) / 2 : 2;
    const liTotal    = (item.lineItems?.nodes || []).reduce((s, li) => s + parseFloat(li.unitPrice || 0) * parseFloat(li.quantity || 1), 0);
    const revenue    = parseFloat(item.job?.total || liTotal || 0);
    const addr       = item.property?.address;
    const address    = addr ? [addr.street, addr.city, addr.postalCode].filter(Boolean).join(", ") : "";

    return {
      id: item.id,
      name: item.client?.name || item.title || "Jobber Job",
      service: item.lineItems?.nodes?.[0]?.name || "Service",
      address, revenue,
      estimatedHours: estHours,
      distanceMiles: 0,
      preferredDay: "", preferredTime: "",
      lineItems: (item.lineItems?.nodes || []).map(li => ({ desc: li.name, cost: parseFloat(li.unitPrice || 0) })),
      scheduledDay: dayShort,
      scheduledHour: startHour,
      fromJobber: true,
    };
  }).filter((j) => j.scheduledDay && j.scheduledHour !== null);
}

app.listen(PORT, () => console.log(`JobSlot AI Proxy v4 on port ${PORT}`));

// Serve the scheduling app at /app
const path = require("path");
app.get("/app", (req, res) => {
  res.sendFile(path.join(__dirname, "app.html"));
});
