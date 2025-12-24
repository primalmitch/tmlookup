// api/lookup.js
// Returns TX House + TX Senate district numbers for a lat/lng point.

import * as turf from "@turf/turf";

// IMPORTANT:
// lookup.js is in /api, but your GeoJSON files are in repo root.
// Using require() makes Vercel bundle these files (no fs.readFileSync needed).
// If you move the GeoJSON files later, update these paths.
const houseGeo = require("../tx-house-2025.geojson");
const senateGeo = require("../tx-senate-2025.geojson");

// --- helpers ---------------------------------------------------------------

function toNumberOrNull(v) {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
}

// Try multiple known property keys across different sources
function extractDistrictNumber(props, chamber /* "house" | "senate" */) {
  if (!props) return null;

  // Common keys we’ve seen in your earlier files and TIGER exports
  const candidates = [
    "DIST_NBR",
    "DISTRICT",
    "district",
    "District",
    "OBJECTID",
    // TIGER / Census for State Legislative Districts:
    chamber === "house" ? "SLDLST" : "SLDUST",
    // Sometimes district is embedded in names:
    "NAMELSAD",
    "NAME",
    "name",
    "REP_NM",
  ];

  // 1) direct numeric fields first
  for (const k of candidates) {
    const val = props[k];
    const n = toNumberOrNull(val);
    if (n !== null && k !== "OBJECTID") return n;
  }

  // 2) if not direct, parse from a string like "State House District 114"
  const nameFields = ["NAMELSAD", "NAME", "name"];
  for (const k of nameFields) {
    const v = props[k];
    if (typeof v === "string") {
      const m = v.match(/district\s+(\d+)/i);
      if (m) return Number(m[1]);
      // sometimes just a number string
      const n = toNumberOrNull(v);
      if (n !== null) return n;
    }
  }

  return null;
}

// Build bbox once per dataset for quick out-of-texas rejects
function getCollectionBbox(fc) {
  // Some GeoJSON includes bbox; if not, compute.
  if (Array.isArray(fc?.bbox) && fc.bbox.length === 4) return fc.bbox;
  try {
    return turf.bbox(fc);
  } catch {
    return null;
  }
}

const HOUSE_BBOX = getCollectionBbox(houseGeo);
const SENATE_BBOX = getCollectionBbox(senateGeo);

function pointInBbox([lng, lat], bbox) {
  if (!bbox) return true; // if no bbox, don’t block
  const [minX, minY, maxX, maxY] = bbox;
  return lng >= minX && lng <= maxX && lat >= minY && lat <= maxY;
}

function findDistrict(fc, chamber, pt) {
  if (!fc || fc.type !== "FeatureCollection" || !Array.isArray(fc.features)) return null;

  for (const f of fc.features) {
    if (!f || f.type !== "Feature") continue;
    const geom = f.geometry;
    if (!geom) continue;

    // booleanPointInPolygon works with Polygon or MultiPolygon
    if (geom.type !== "Polygon" && geom.type !== "MultiPolygon") continue;

    let inside = false;
    try {
      inside = turf.booleanPointInPolygon(pt, f);
    } catch {
      inside = false;
    }

    if (inside) {
      return extractDistrictNumber(f.properties, chamber);
    }
  }

  return null;
}

// --- handler ---------------------------------------------------------------

export default function handler(req, res) {
  try {
    const { lat, lng, debug } = req.query || {};

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return res.status(400).json({
        error: "Bad request",
        message: "Provide numeric lat and lng query params, e.g. ?lat=32.7767&lng=-96.7970",
      });
    }

    // Turf expects [lng, lat]
    const pt = turf.point([longitude, latitude]);

    // Quick bbox reject (usually means point is outside TX or CRS mismatch)
    const houseInBox = pointInBbox([longitude, latitude], HOUSE_BBOX);
    const senateInBox = pointInBbox([longitude, latitude], SENATE_BBOX);

    const house = houseInBox ? findDistrict(houseGeo, "house", pt) : null;
    const senate = senateInBox ? findDistrict(senateGeo, "senate", pt) : null;

    // Optional debug payload: hit ?debug=1 to see what keys exist, bbox, etc.
    if (debug === "1" || debug === "true") {
      const housePropsKeys =
        houseGeo?.features?.[0]?.properties ? Object.keys(houseGeo.features[0].properties) : [];
      const senatePropsKeys =
        senateGeo?.features?.[0]?.properties ? Object.keys(senateGeo.features[0].properties) : [];

      return res.status(200).json({
        ok: true,
        input: { lat: latitude, lng: longitude },
        bbox: { house: HOUSE_BBOX, senate: SENATE_BBOX },
        bboxCheck: { houseInBox, senateInBox },
        samplePropsKeys: {
          house: housePropsKeys,
          senate: senatePropsKeys,
        },
        result: { house, senate },
      });
    }

    return res.status(200).json({ house, senate });
  } catch (err) {
    return res.status(500).json({
      error: "Server error",
      message: err?.message || String(err),
    });
  }
}
