// /api/lookup.js (or /pages/api/lookup.js)

import fs from "fs";
import path from "path";
import * as turf from "@turf/turf";

/* ---------- helpers ---------- */
function loadGeoJSON(relativePath) {
  const filePath = path.join(process.cwd(), relativePath);
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

/* =========================================================
   NAIVE IN-MEMORY SPAM GUARDS (NO NEW SERVICES)
   - Rate limit: 10 requests / 60s / IP
   - Cache: 24h by rounded lat/lng (5 decimals)
   NOTE: In-memory = per server instance (good starter)
========================================================= */
const LOOKUP_WINDOW_MS = 60_000;
const LOOKUP_MAX = 10;

const lookupHits = new Map();   // ip -> { count, resetAt }
const lookupCache = new Map();  // key -> { data, exp }

function getIP(req) {
  const xff = req.headers["x-forwarded-for"];
  return (Array.isArray(xff) ? xff[0] : (xff || ""))
    .split(",")[0]
    .trim() || "unknown";
}

function rateLimitLookup(req) {
  const ip = getIP(req);
  const now = Date.now();
  const cur = lookupHits.get(ip);

  if (!cur || now > cur.resetAt) {
    lookupHits.set(ip, { count: 1, resetAt: now + LOOKUP_WINDOW_MS });
    return true;
  }
  if (cur.count >= LOOKUP_MAX) return false;
  cur.count += 1;
  return true;
}

function cacheGet(key) {
  const v = lookupCache.get(key);
  if (!v) return null;
  if (Date.now() > v.exp) {
    lookupCache.delete(key);
    return null;
  }
  return v.data;
}

function cacheSet(key, data, ttlMs) {
  lookupCache.set(key, { data, exp: Date.now() + ttlMs });
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

  // Only allow GET
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ---- RATE LIMIT (server-side) ----
  if (!rateLimitLookup(req)) {
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

    // ---- CACHE (24h) by rounded coords ----
    const latKey = latitude.toFixed(5);
    const lngKey = longitude.toFixed(5);
    const cacheKey = `lookup:${latKey},${lngKey}`;

    const cached = cacheGet(cacheKey);
    if (cached) {
      return res.status(200).json(cached);
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

    const payload = {
      districts: {
        house,
        senate,
        sboe,
      },
    };

    cacheSet(cacheKey, payload, 24 * 60 * 60 * 1000); // 24h
    return res.status(200).json(payload);
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "Server error",
      message: err?.message || "Unknown error",
    });
  }
}
