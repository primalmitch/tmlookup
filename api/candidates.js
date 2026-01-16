import { kv } from "@vercel/kv";

function getIP(req) {
  const xff = req.headers["x-forwarded-for"];
  return (Array.isArray(xff) ? xff[0] : (xff || ""))
    .split(",")[0]
    .trim() || "unknown";
}

async function rateLimitKV(req) {
  const ip = getIP(req);
  const key = `rl:candidates:${ip}`;

  const count = await kv.incr(key);
  if (count === 1) {
    await kv.expire(key, 60); // 60 seconds
  }
  return count <= 30; // 30 req/min
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
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ---- RATE LIMIT (shared via KV) ----
  if (!(await rateLimitKV(req))) {
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

    // ---- CACHE (30 minutes) ----
    const cacheKey = `cache:candidates:${office.toLowerCase()}|${
      districtRaw === undefined ? "none" : String(districtRaw)
    }`;

    const cached = await kv.get(cacheKey);
    if (cached) return res.status(200).json(cached);

    const safeOffice = office.replace(/"/g, '\\"');
    let formula = `{Office}="${safeOffice}"`;

    if (districtRaw !== undefined) {
      const d = Number(districtRaw);
      if (!Number.isFinite(d) || d <= 0) {
        return res.status(400).json({ error: "Invalid district" });
      }
      formula = `AND(${formula}, {District}=${d})`;
    }

    const params = new URLSearchParams();
    params.set("filterByFormula", formula);

    // ✅ KEEP ORIGINAL ORDERING
    params.append("sort[0][field]", "Order");
    params.append("sort[0][direction]", "asc");
    params.append("sort[1][field]", "Name");
    params.append("sort[1][direction]", "asc");

    const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
      AIRTABLE_TABLE
    )}?${params.toString()}`;

    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
    });

    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return res.status(500).json({ error: "Airtable fetch failed", details: t });
    }

    const data = await r.json();
    const payload = { records: data.records || [] };

    await kv.set(cacheKey, payload, { ex: 1800 }); // 30 minutes

    return res.status(200).json(payload);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
}
