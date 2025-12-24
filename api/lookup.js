import fs from "fs";
import path from "path";
import * as turf from "@turf/turf";

function loadGeoJSON(relativePath) {
  const filePath = path.join(process.cwd(), relativePath);
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}

export default function handler(req, res) {
  try {
    const { lat, lng, debug } = req.query;

    if (!lat || !lng) {
      return res.status(400).json({
        error: "Missing lat or lng query parameters",
      });
    }

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lng);

    if (isNaN(latitude) || isNaN(longitude)) {
      return res.status(400).json({
        error: "Invalid lat or lng values",
      });
    }

    // Turf expects [lng, lat]
    const point = turf.point([longitude, latitude]);

    // Load GeoJSON files
    const houseGeo = loadGeoJSON("data/tx-house-2025.geojson");
    const senateGeo = loadGeoJSON("data/tx-senate-2025.geojson");
    const sboeGeo = loadGeoJSON("data/sboe_plane2106.geojson");

    let houseDistrict = null;
    let senateDistrict = null;
    let sboeDistrict = null;

    // HOUSE
    for (const feature of houseGeo.features) {
      if (turf.booleanPointInPolygon(point, feature)) {
        houseDistrict = feature.properties;
        break;
      }
    }

    // SENATE
    for (const feature of senateGeo.features) {
      if (turf.booleanPointInPolygon(point, feature)) {
        senateDistrict = feature.properties;
        break;
      }
    }

    // SBOE (flatten MultiPolygons explicitly)
    for (const feature of sboeGeo.features) {
      const flattened = turf.flatten(feature);

      for (const f of flattened.features) {
        if (turf.booleanPointInPolygon(point, f)) {
          sboeDistrict = feature.properties;
          break;
        }
      }

      if (sboeDistrict) break;
    }

    if (debug === "1") {
      return res.status(200).json({
        input: { lat: latitude, lng: longitude },
        houseFound: !!houseDistrict,
        senateFound: !!senateDistrict,
        sboeFound: !!sboeDistrict,
        house: houseDistrict,
        senate: senateDistrict,
        sboe: sboeDistrict,
      });
    }

    return res.status(200).json({
      house: houseDistrict,
      senate: senateDistrict,
      sboe: sboeDistrict,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      error: "Server error",
      message: err.message,
    });
  }
}
