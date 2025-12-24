import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import * as turf from "@turf/turf";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cache in memory (persists between requests on the same server instance)
let houseGeo = null;
let senateGeo = null;

async function loadGeoJSON() {
  if (!houseGeo) {
    const housePath = path.join(__dirname, "..", "tx-house-2025.geojson");
    houseGeo = JSON.parse(await fs.readFile(housePath, "utf8"));
  }
  if (!senateGeo) {
    const senatePath = path.join(__dirname, "..", "tx-senate-2025.geojson");
    senateGeo = JSON.parse(await fs.readFile(senatePath, "utf8"));
  }
}

function findDistrict(geojson, pt) {
  const features = geojson?.features || [];
  for (const feature of features) {
    if (turf.booleanPointInPolygon(pt, feature)) {
      // TIGER uses NAME as the district number (string)
      return parseInt(feature.properties.NAME, 10);
    }
  }
  return null;
}

export default async function handler(req, res) {
  const { lat, lng, debug } = req.query;

  if (!lat || !lng) {
    return res.status(400).json({ error: "Missing lat or lng" });
  }

  const latitude = parseFloat(lat);
  const longitude = parseFloat(lng);

  if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
    return res.status(400).json({ error: "Invalid lat or lng" });
  }

  await loadGeoJSON();

  // Debug mode: return bbox + schema hints
  if (debug === "1") {
    const houseFirst = houseGeo?.features?.[0];
    const senateFirst = senateGeo?.features?.[0];

    return res.status(200).json({
      house_type: houseGeo?.type,
      house_feature_type: houseFirst?.type,
      house_props_keys: houseFirst?.properties
        ? Object.keys(houseFirst.properties).slice(0, 15)
        : null,
      house_bbox: houseFirst ? turf.bbox(houseFirst) : null,

      senate_type: senateGeo?.type,
      senate_feature_type: senateFirst?.type,
      senate_props_keys: senateFirst?.properties
        ? Object.keys(senateFirst.properties).slice(0, 15)
        : null,
      senate_bbox: senateFirst ? turf.bbox(senateFirst) : null
    });
  }

  // Turf expects [lng, lat]
  const pt = turf.point([longitude, latitude]);

  const house = findDistrict(houseGeo, pt);
  const senate = findDistrict(senateGeo, pt);

  return res.status(200).json({ house, senate });
}
