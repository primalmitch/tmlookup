export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
    const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
    const AIRTABLE_TABLE = process.env.AIRTABLE_TABLE;

    if (!AIRTABLE_BASE_ID || !AIRTABLE_PAT || !AIRTABLE_TABLE) {
      return res.status(500).json({ error: "Server not configured" });
    }

    const office = String(req.query.office || "").trim();
    const district = req.query.district;

    if (!office) {
      return res.status(400).json({ error: "Missing office" });
    }

    let formula = `{Office}="${office.replace(/"/g, '\\"')}"`;
    if (district !== undefined) {
      const d = Number(district);
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
      const t = await r.text();
      return res.status(500).json({ error: t });
    }

    const data = await r.json();
    return res.status(200).json({ records: data.records || [] });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
}
