import fs from "fs";
import path from "path";
import * as turf from "@turf/turf";
import { kv } from "@vercel/kv";

/* ---------- helpers ---------- */
function loadGeoJSON(relativePath) {
  const filePath = path.join(process.cwd(), relativePath);
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function getIP(req) {
  const xff = req.headers["x-forwarded-for"];
  return (Array.isArray(xff) ? xff[0] : xff || "").split(",")[0].trim() || "unknown";
}

async function rateLimitKV(req) {
  const ip = getIP(req);
  const key = `rl:lookup:${ip}`;

  const count = await kv.incr(key);
  if (count === 1) {
    await kv.expire(key, 60); // 60 seconds
  }
  return count <= 10; // 10 req/min
}

/* ---------- API handler ---------- */
export default async function handler(req, res) {
  /* ===== CORS ===== */
  const origin = req.headers.origin || "";
  const allowed = new Set(["https://www.texasmatters.org", "https://texasmatters.org"]);

  if (allowed.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  /* ===== END CORS ===== */

  if (!(await rateLimitKV(req))) {
    return res.status(429).json({ error: "Too many requests" });
  }

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

    const latKey = latitude.toFixed(5);
    const lngKey = longitude.toFixed(5);
    const cacheKey = `cache:lookup:${latKey},${lngKey}`;

    const cached = await kv.get(cacheKey);
    if (cached) return res.status(200).json(cached);

    const point = turf.point([longitude, latitude]);

    const houseGeo = loadGeoJSON("data/tx-house-2025.geojson");
    const senateGeo = loadGeoJSON("data/tx-senate-2025.geojson");
    const sboeGeo = loadGeoJSON("data/sboe_plane2106.geojson");
    const congressGeo = loadGeoJSON("tx_congress_planc2333.geojson");

    let house = null;
    let senate = null;
    let sboe = null;
    let congress = null;

    for (const f of houseGeo.features) {
      if (turf.booleanPointInPolygon(point, f)) {
        house = Number(f.properties.SLDLST);
        break;
      }
    }

    for (const f of senateGeo.features) {
      if (turf.booleanPointInPolygon(point, f)) {
        senate = Number(f.properties.SLDUST);
        break;
      }
    }

    for (const f of sboeGeo.features) {
      if (turf.booleanPointInPolygon(point, f)) {
        sboe = Number(f.properties.District);
        break;
      }
    }

    for (const f of congressGeo.features) {
      if (turf.booleanPointInPolygon(point, f)) {
        congress = Number(f.properties.District);
        break;
      }
    }

    const payload = { districts: { house, senate, sboe, congress } };
    await kv.set(cacheKey, payload, { ex: 86400 }); // 24h

    return res.status(200).json(payload);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
}
