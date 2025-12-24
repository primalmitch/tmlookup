// api/lookup.js
import fs from "fs";
import path from "path";
import * as turf from "@turf/turf";

// ---- Load GeoJSON (cached across warm invocations) ----
let HOUSE_FC = null;
let SENATE_FC = null;

function loadGeoJSON(filename) {
  const filePath = path.join(process.cwd(), filename); // repo root
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

function ensureDataLoaded() {
  if (!HOUSE_FC) HOUSE_FC = loadGeoJSON("tx-house-2025.geojson");
  if (!SENATE_FC) SENATE_FC = loadGeoJSON("tx-senate-2025.geojson");
}

// ---- Helpers ----
function pickDistrictValue(props, preferredKeys) {
  for (const key of preferredKeys) {
    if (props && props[key] != null && `${props[key]}`.trim() !== "") {
      const n = parseInt(`${props[key]}`.trim(), 10);
      return Number.isFinite(n) ? n : `${props[key]}`.trim();
    }
  }
  // fallback: try to find anything that looks like a district field
  if (props) {
    const fallbackKeys = Object.keys(props).filter((k) =>
      /district|dist|sldl|sldu/i.test(k)
    );
    for (const k of fallbackKeys) {
      const n = parseInt(`${props[k]}`.trim(), 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function findDistrict(featureCollection, pt, preferredKeys) {
  if (!featureCollection || !Array.isArray(featureCollection.features)) return null;

  for (const feature of featureCollection.features) {
    if (!feature || !feature.geometry) continue;

    // Turf expects pt as Point, feature as Polygon/MultiPolygon Feature
    if (turf.booleanPointInPolygon(pt, feature)) {
      return pickDistrictValue(feature.properties || {}, preferredKeys);
    }
  }
  return null;
}

// ---- API handler ----
export default function handler(req, res) {
  try {
    ensureDataLoaded();

    const { lat, lng } = req.query;

    if (lat == null || lng == null) {
      return res.status(400).json({
        error: "Missing lat/lng. Use /api/lookup?lat=32.7767&lng=-96.7970",
      });
    }

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return res.status(400).json({ error: "lat/lng must be valid numbers" });
    }

    // Turf expects [lng, lat]
    const pt = turf.point([longitude, latitude]);

    // TIGER SLD layers typically use:
    // House (lower): SLDLST
    // Senate (upper): SLDUST
    const house = findDistrict(HOUSE_FC, pt, ["SLDLST", "DIST_NBR", "DISTRICT", "DIST"]);
    const senate = findDistrict(SENATE_FC, pt, ["SLDUST", "DIST_NBR", "DISTRICT", "DIST"]);

    return res.status(200).json({ house, senate });
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      message: err?.message || String(err),
    });
  }
}
