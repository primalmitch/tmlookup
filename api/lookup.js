import fs from "fs";
import path from "path";
import * as turf from "@turf/turf";

/* ---------- helpers ---------- */
function loadGeoJSON(relativePath) {
  const filePath = path.join(process.cwd(), relativePath);
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

/* ---------- API handler ---------- */
export default function handler(req, res) {

  /* ===== CORS (REQUIRED) ===== */
  const origin = req.headers.origin || "";
  const allowedOrigins = new Set([
    "https://www.texasmatters.org",
    "https://texasmatters.org",
  ]);

  if (allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  /* ===== END CORS ===== */

  try {
    const { lat, lng } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({ error: "Missing lat or lng" });
    }

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);

    if (isNaN(latitude) || isNaN(longitude)) {
      return res.status(400).json({ error: "Invalid lat or lng" });
    }

    const point = turf.point([longitude, latitude]);

    /* ---------- load data ---------- */
    const houseGeo = loadGeoJSON("data/tx-house-2025.geojson");
    const senateGeo = loadGeoJSON("data/tx-senate-2025.geojson");
    const sboeGeo = loadGeoJSON("data/sboe_plane2106.geojson");

    let house = null;
    let senate = null;
    let sboe = null;

    /* ---------- house ---------- */
    for (const f of houseGeo.features) {
      if (turf.booleanPointInPolygon(point, f)) {
        house = Number(f.properties.SLDLST);
        break;
      }
    }

    /* ---------- senate ---------- */
    for (const f of senateGeo.features) {
      if (turf.booleanPointInPolygon(point, f)) {
        senate = Number(f.properties.SLDUST);
        break;
      }
    }

    /* ---------- SBOE ---------- */
    for (const f of sboeGeo.features) {
      if (turf.booleanPointInPolygon(point, f)) {
        sboe = Number(f.properties.District);
        break;
      }
    }

    return res.status(200).json({
      districts: {
        house,
        senate,
        sboe,
      },
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "Server error",
      message: err.message,
    });
  }
}
