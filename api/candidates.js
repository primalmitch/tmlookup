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
    return res.status(200).json({ records: data.records || [] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
}
