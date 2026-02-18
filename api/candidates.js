import { kv } from "@vercel/kv";

function getIP(req) {
  const xff = req.headers["x-forwarded-for"];
  return (Array.isArray(xff) ? xff[0] : (xff || ""))
    .split(",")[0]
    .trim() || "unknown";
}

/**
 * Two-tier fixed-window rate limiting (shared via KV)
 */
async function rateLimitTwoTier(req, { prefix, burstLimit, hourLimit }) {
  try {
    const ip = getIP(req);

    const minuteKey = `rl:${prefix}:m:${ip}`;
    const hourKey = `rl:${prefix}:h:${ip}`;

    const [mCount, hCount] = await Promise.all([
      kv.incr(minuteKey),
      kv.incr(hourKey),
    ]);

    if (mCount === 1) await kv.expire(minuteKey, 60);
    if (hCount === 1) await kv.expire(hourKey, 3600);

    return mCount <= burstLimit && hCount <= hourLimit;
  } catch (e) {
    console.warn("KV rate limit skipped:", e.message);
    return true; // allow request if KV fails
  }
}

export default async function handler(req, res) {
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

  const ok = await rateLimitTwoTier(req, {
    prefix: "candidates",
    burstLimit: 200,
    hourLimit: 2000,
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

    const cacheKey = `cache:candidates:${office.toLowerCase()}|${
      districtRaw === undefined ? "none" : String(districtRaw)
    }`;

    /* ===== SAFE CACHE GET ===== */
    let cached = null;
    try {
      cached = await kv.get(cacheKey);
    } catch (e) {
      console.warn("KV get skipped:", e.message);
    }

    if (cached) return res.status(200).json(cached);
    /* ===== END SAFE CACHE GET ===== */

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

    /* ===== SAFE CACHE SET ===== */
    try {
      await kv.set(cacheKey, payload, { ex: 300 });
    } catch (e) {
      console.warn("KV set skipped:", e.message);
    }
    /* ===== END SAFE CACHE SET ===== */

    return res.status(200).json(payload);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
}
