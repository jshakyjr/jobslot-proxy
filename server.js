// JobSlot AI — Jobber Proxy Server v11
// OAuth2 + persistent tokens + AI scheduling endpoint

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
  expiresAt:    0,
};

async function saveTokensToRender(tokens) {
  if (!RENDER_API_KEY || !RENDER_SERVICE_ID) return;
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
      ]),
    });
    console.log("Tokens saved to Render.");
  } catch(e) { console.log("Render save error:", e.message); }
}

async function refreshAccessToken() {
  if (!tokenStore.refreshToken) throw new Error("NO_REFRESH_TOKEN");
  console.log("Refreshing access token...");
  const res = await fetch(JOBBER_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: JOBBER_CLIENT_ID, client_secret: JOBBER_CLIENT_SECRET, refresh_token: tokenStore.refreshToken }),
  });
  if (!res.ok) { const txt = await res.text(); throw new Error(`Refresh failed (${res.status}): ${txt.slice(0,200)}`); }
  const data = await res.json();
  tokenStore.accessToken  = data.access_token;
  tokenStore.refreshToken = data.refresh_token || tokenStore.refreshToken;
  tokenStore.expiresAt    = Date.now() + (data.expires_in || 3300) * 1000;
  await saveTokensToRender(tokenStore);
  console.log("Token refreshed and saved.");
  return tokenStore.accessToken;
}

async function getValidToken() {
  if (tokenStore.accessToken && Date.now() < tokenStore.expiresAt - 120000) return tokenStore.accessToken;
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
  res.json({ status: "JobSlot AI Proxy v11", timestamp: new Date().toISOString(), currentWeek: { gte, lte }, connected: !!tokenStore.refreshToken });
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
  <body><div class="box"><h1>⚡ JobSlo
