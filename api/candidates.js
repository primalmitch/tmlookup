export default async function handler(req, res) {
  // ===== CORS (REQUIRED) =====
  const origin = req.headers.origin || "";
  const allowedOrigins = new Set([
    "https://www.texasmatters.org",
    "https://texasmatters.org",
    "https://texas-matters.webflow.io",
  ]);

  if (allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Preflight
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Only allow GET
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
    const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
    const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE;

    if (!AIRTABLE_BASE_ID || !AIRTABLE_PAT || !AIRTABLE_TABLE) {
      return res.status(500).json({ error: "Server not configured" });
    }

    const { office, district } = req.query;

    let formulaParts = [];
    if (office) {
      formulaParts.push(`{Office}='${office}'`);
    }
    if (district) {
      formulaParts.push(`{District}='${district}'`);
    }

    const filterFormula =
      formulaParts.length > 0
        ? `AND(${formulaParts.join(",")})`
        : "";

    const url =
      `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(
        AIRTABLE_TABLE
      )}` +
      (filterFormula
        ? `?filterByFormula=${encodeURIComponent(filterFormula)}`
        : "");

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${AIRTABLE_PAT}`,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(500).json({ error: "Airtable error", details: text });
    }

    const data = await response.json();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
