// /api/candidates.js (or /pages/api/candidates.js)

/* =========================================================
   NAIVE IN-MEMORY SPAM GUARDS (NO NEW SERVICES)
   - Rate limit: 30 requests / 60s / IP
   - Cache: 30 min by office|district
   NOTE: In-memory = per server instance (good starter)
========================================================= */
const CAND_WINDOW_MS = 60_000;
const CAND_MAX = 30;

const candHits = new Map();   // ip -> { count, resetAt }
const candCache = new Map();  // key -> { data, exp }

function getIP(req) {
  const xff = req.headers["x-forwarded-for"];
  return (Array.isArray(xff) ? xff[0] : (xff || ""))
    .split(",")[0]
    .trim() || "unknown";
}

function rateLimitCandidates(req) {
  const ip = getIP(req);
  const now = Date.now();
  const cur = candHits.get(ip);

  if (!cur || now > cur.resetAt) {
    candHits.set(ip, { count: 1, resetAt: now + CAND_WINDOW_MS });
    return true;
  }
  if (cur.count >= CAND_MAX) return false;
  cur.count += 1;
  return true;
}

function cacheGet(key) {
  const v = candCache.get(key);
  if (!v) return null;
  if (Date.now() > v.exp) {
    candCache.delete(key);
    return null;
  }
  return v.data;
}

function cacheSet(key, data, ttlMs) {
  candCache.set(key, { data, exp: Date.now() + ttlMs });
}

export default async function handler(req, res) {
  // ---- CORS ----
  const origin = req.headers.origin || "";
  const allowed = new Set([
    "https://texas-matters.webflow.io",
    "https://texasmatters.org",
    "https://www.texasmatters.org",
  ]);

  if (allowed.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  // ---- RATE LIMIT (server-side) ----
  if (!rateLimitCandidates(req)) {
    return res.status(429).json({ error: "Too many requests" });
  }

  try {
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
    const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
    const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE;

    if (!AIRTABLE_BASE_ID || !AIRTABLE_PAT || !AIRTABLE_TABLE) {
      return res.status(500).json({ error: "Server not configured" });
    }

    const office = String(req.query.office || "").trim();
    const districtRaw = req.query.district;

    if (!office) return res.status(400).json({ error: "Missing office" });

    // ---- CACHE (30m) ----
    const cacheKey = `cand:${office.toLowerCase()}|${districtRaw === undefined ? "none" : String(districtRaw)}`;
    const cached = cacheGet(cacheKey);
    if (cached) return res.status(200).json(cached);

    const safeOffice = office.replace(/"/g, '\\"');
    let formula = `{Office}="${safeOffice}"`;

    if (districtRaw !== undefined) {
      const d = Number(districtRaw);
      if (!Number.isFinite(d) || d <= 0) return res.status(400).json({ error: "Invalid district" });
      formula = `AND(${formula}, {District}=${d})`;
    }

    const params = new URLSearchParams();
    params.set("filterByFormula", formula);

    // ✅ RESTORE ORIGINAL ORDERING
    params.append("sort[0][field]", "Order");
    params.append("sort[0][direction]", "asc");
    params.append("sort[1][field]", "Name");
    params.append("sort[1][direction]", "asc");

    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
      AIRTABLE_TABLE
    )}?${params.toString()}`;

    const r = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_PAT}` } });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return res.status(500).json({ error: "Airtable fetch failed", details: t });
    }

    const data = await r.json();
    const payload = { records: data.records || [] };

    cacheSet(cacheKey, payload, 30 * 60 * 1000); // 30m
    return res.status(200).json(payload);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
}
