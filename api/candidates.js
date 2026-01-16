import { kv } from "@vercel/kv";

function getIP(req) {
  const xff = req.headers["x-forwarded-for"];
  return (Array.isArray(xff) ? xff[0] : (xff || ""))
    .split(",")[0]
    .trim() || "unknown";
}

/**
 * Two-tier fixed-window rate limiting (shared via KV)
 * - burst: N per 60 seconds
 * - sustained: M per 3600 seconds
 */
async function rateLimitTwoTier(req, { prefix, burstLimit, hourLimit }) {
  const ip = getIP(req);

  const minuteKey = `rl:${prefix}:m:${ip}`;
  const hourKey = `rl:${prefix}:h:${ip}`;

  // increment both counters
  const [mCount, hCount] = await Promise.all([
    kv.incr(minuteKey),
    kv.incr(hourKey),
  ]);

  // set TTLs only on first hit
  if (mCount === 1) await kv.expire(minuteKey, 60);
  if (hCount === 1) await kv.expire(hourKey, 3600);

  return mCount <= burstLimit && hCount <= hourLimit;
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

  // ---- TWO-TIER RATE LIMIT (shared via KV) ----
  // Burst allows one lookup fan-out + a few addresses.
  // Hour cap protects against sustained scraping/abuse.
  const ok = await rateLimitTwoTier(req, {
    prefix: "candidates",
    burstLimit: 200, // per minute
    hourLimit: 2000, // per hour
  });

  if (!ok) {
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

    // ---- KV CACHE (30 minutes) ----
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

    // Cache 30m (1800 seconds)
    await kv.set(cacheKey, payload, { ex: 1800 });

    return res.status(200).json(payload);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
}
