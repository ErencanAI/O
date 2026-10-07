import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

const DATA_DIR = path.join(__dirname, "data");
const CACHE_DIR = path.join(__dirname, "cache");
const GTFS_CACHE = path.join(CACHE_DIR, "official-gtfs.zip");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(CACHE_DIR, { recursive: true });

const db = {
  stops: new Map(),
  routes: new Map(),
  trips: new Map(),
  stopTimes: [],
  stopTimesByStop: new Map(),
  stopTimesByTrip: new Map(),
  loaded: false,
  source: null,
  loadedAt: null,
  error: null
};

const OFFICIAL_GTFS_URL =
  "https://acikveri.konya.bel.tr/dataset/c2e034e6-e015-49c6-8eec-6e2f7de9c105/resource/ec944ecd-1c1f-4687-a7f6-fcf2dc5bb5db/download/gtfs_11_2025.zip";

function clean(value) {
  return String(value ?? "").trim();
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function csv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        value += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (c === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;

      row.push(value);
      value = "";

      if (row.some(x => clean(x) !== "")) {
        rows.push(row);
      }

      row = [];
    } else {
      value += c;
    }
  }

  if (value.length || row.length) {
    row.push(value);
    if (row.some(x => clean(x) !== "")) {
      rows.push(row);
    }
  }

  if (!rows.length) return [];

  const headers = rows[0].map(x =>
    clean(x).replace(/^\uFEFF/, "")
  );

  return rows.slice(1).map(values => {
    const obj = {};

    headers.forEach((header, index) => {
      obj[header] = clean(values[index]);
    });

    return obj;
  });
}

function readTextFromZip(zip, filename) {
  const entry = zip
    .getEntries()
    .find(e => path.basename(e.entryName).toLowerCase() === filename);

  if (!entry) return null;

  return entry.getData().toString("utf8");
}

function parseGtfsTexts(files, source) {
  const stopsText = files["stops.txt"];
  const routesText = files["routes.txt"];
  const tripsText = files["trips.txt"];
  const stopTimesText = files["stop_times.txt"];

  if (!stopsText || !routesText || !tripsText || !stopTimesText) {
    throw new Error(
      "GTFS için stops.txt, routes.txt, trips.txt ve stop_times.txt gerekli."
    );
  }

  const stops = csv(stopsText);
  const routes = csv(routesText);
  const trips = csv(tripsText);
  const stopTimes = csv(stopTimesText);

  if (!stops.length) {
    throw new Error("GTFS stops.txt boş.");
  }

  const next = {
    stops: new Map(),
    routes: new Map(),
    trips: new Map(),
    stopTimes: [],
    stopTimesByStop: new Map(),
    stopTimesByTrip: new Map()
  };

  for (const item of stops) {
    const id = clean(item.stop_id);
    const name = clean(item.stop_name);

    if (!id || !name) continue;

    const lat = number(item.stop_lat);
    const lon = number(item.stop_lon);

    if (lat === null || lon === null) continue;

    next.stops.set(id, {
      id,
      name,
      code: clean(item.stop_code),
      lat,
      lon,
      zoneId: clean(item.zone_id)
    });
  }

  for (const item of routes) {
    const id = clean(item.route_id);

    if (!id) continue;

    next.routes.set(id, {
      id,
      shortName: clean(item.route_short_name),
      longName: clean(item.route_long_name),
      type: clean(item.route_type),
      color: clean(item.route_color)
    });
  }

  for (const item of trips) {
    const id = clean(item.trip_id);
    const routeId = clean(item.route_id);

    if (!id || !routeId) continue;

    next.trips.set(id, {
      id,
      routeId,
      serviceId: clean(item.service_id),
      headsign: clean(item.trip_headsign),
      directionId: clean(item.direction_id)
    });
  }

  for (const item of stopTimes) {
    const tripId = clean(item.trip_id);
    const stopId = clean(item.stop_id);

    if (!tripId || !stopId) continue;
    if (!next.trips.has(tripId)) continue;
    if (!next.stops.has(stopId)) continue;

    const record = {
      tripId,
      stopId,
      arrival: clean(item.arrival_time),
      departure: clean(item.departure_time),
      sequence: Number(item.stop_sequence) || 0
    };

    next.stopTimes.push(record);

    if (!next.stopTimesByStop.has(stopId)) {
      next.stopTimesByStop.set(stopId, []);
    }

    next.stopTimesByStop.get(stopId).push(record);

    if (!next.stopTimesByTrip.has(tripId)) {
      next.stopTimesByTrip.set(tripId, []);
    }

    next.stopTimesByTrip.get(tripId).push(record);
  }

  for (const list of next.stopTimesByStop.values()) {
    list.sort((a, b) => a.sequence - b.sequence);
  }

  for (const list of next.stopTimesByTrip.values()) {
    list.sort((a, b) => a.sequence - b.sequence);
  }

  db.stops = next.stops;
  db.routes = next.routes;
  db.trips = next.trips;
  db.stopTimes = next.stopTimes;
  db.stopTimesByStop = next.stopTimesByStop;
  db.stopTimesByTrip = next.stopTimesByTrip;

  db.loaded = db.stops.size > 0;
  db.source = source;
  db.loadedAt = new Date().toISOString();
  db.error = null;
}

function loadLocalGtfs() {
  const required = [
    "stops.txt",
    "routes.txt",
    "trips.txt",
    "stop_times.txt"
  ];

  const files = {};

  for (const file of required) {
    const full = path.join(DATA_DIR, file);

    if (!fs.existsSync(full)) {
      return false;
    }

    files[file] = fs.readFileSync(full, "utf8");
  }

  parseGtfsTexts(files, "Yerel GTFS verisi");
  return true;
}

function loadZip(zipPath, source) {
  const zip = new AdmZip(zipPath);

  const files = {};

  for (const filename of [
    "stops.txt",
    "routes.txt",
    "trips.txt",
    "stop_times.txt"
  ]) {
    const text = readTextFromZip(zip, filename);

    if (!text) {
      throw new Error(`${filename} ZIP içinde bulunamadı.`);
    }

    files[filename] = text;
  }

  parseGtfsTexts(files, source);
}

async function downloadOfficialGtfs() {
  const response = await fetch(OFFICIAL_GTFS_URL, {
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; Konya-Ulasim-Plus/6.0)",
      "Accept":
        "application/zip,application/octet-stream,*/*"
    }
  });

  if (!response.ok) {
    throw new Error(
      `Resmî GTFS HTTP ${response.status}`
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (
    buffer.length < 4 ||
    buffer[0] !== 0x50 ||
    buffer[1] !== 0x4b
  ) {
    throw new Error(
      "Resmî kaynak ZIP yerine farklı bir yanıt döndürdü."
    );
  }

  const temp = GTFS_CACHE + ".tmp";

  fs.writeFileSync(temp, buffer);
  fs.renameSync(temp, GTFS_CACHE);

  return true;
}

async function initializeData() {
  try {
    if (loadLocalGtfs()) {
      return;
    }
  } catch (error) {
    db.error = error.message;
  }

  try {
    if (fs.existsSync(GTFS_CACHE)) {
      loadZip(
        GTFS_CACHE,
        "Konya Büyükşehir Belediyesi Açık Veri — önbellek"
      );
      return;
    }
  } catch (error) {
    db.error = error.message;
  }

  try {
    await downloadOfficialGtfs();

    loadZip(
      GTFS_CACHE,
      "Konya Büyükşehir Belediyesi Açık Veri"
    );

    return;
  } catch (error) {
    db.error = error.message;
  }

  db.loaded = false;
  db.source = "waiting-for-official-data";
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;

  const p1 = lat1 * Math.PI / 180;
  const p2 = lat2 * Math.PI / 180;

  const dp =
    (lat2 - lat1) * Math.PI / 180;

  const dl =
    (lon2 - lon1) * Math.PI / 180;

  const a =
    Math.sin(dp / 2) ** 2 +
    Math.cos(p1) *
    Math.cos(p2) *
    Math.sin(dl / 2) ** 2;

  return 2 * R * Math.atan2(
    Math.sqrt(a),
    Math.sqrt(1 - a)
  );
}

function serializeStop(stop, distance = null) {
  return {
    id: stop.id,
    name: stop.name,
    code: stop.code,
    lat: stop.lat,
    lon: stop.lon,
    ...(distance !== null
      ? { distance: Math.round(distance) }
      : {})
  };
}

function findStops(query) {
  const q = clean(query).toLocaleLowerCase("tr-TR");

  if (!q) return [];

  const result = [];

  for (const stop of db.stops.values()) {
    const name =
      stop.name.toLocaleLowerCase("tr-TR");

    const code =
      stop.code.toLocaleLowerCase("tr-TR");

    if (name.includes(q) || code.includes(q)) {
      result.push(stop);
    }

    if (result.length >= 100) break;
  }

  return result;
}

function routeForTrip(trip) {
  return db.routes.get(trip.routeId) || null;
}

function getRoutesForStop(stopId) {
  const records =
    db.stopTimesByStop.get(stopId) || [];

  const routeIds = new Set();

  for (const record of records) {
    const trip = db.trips.get(record.tripId);

    if (trip) {
      routeIds.add(trip.routeId);
    }
  }

  return [...routeIds]
    .map(id => db.routes.get(id))
    .filter(Boolean);
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "Konya Ulaşım Plus",
    version: "6.0.0",
    dataReady: db.loaded,
    time: new Date().toISOString()
  });
});

app.get("/api/app-info", (req, res) => {
  res.json({
    name: "Konya Ulaşım Plus",
    version: "6.0.0",
    city: "Konya",
    officialData: true,
    liveVehicleApi: false,
    message: db.loaded
      ? "Resmî GTFS ulaşım verisi kullanılabilir."
      : "Resmî GTFS verisi şu anda kullanılabilir değil."
  });
});

app.get("/api/data-status", (req, res) => {
  res.json({
    available: db.loaded,
    ready: db.loaded,
    stopCount: db.stops.size,
    routeCount: db.routes.size,
    tripCount: db.trips.size,
    stopTimeCount: db.stopTimes.length,
    source: db.source || "waiting-for-official-data",
    loadedAt: db.loadedAt,
    error: db.loaded ? null : db.error,
    message: db.loaded
      ? "Resmî ulaşım verisi hazır."
      : "Resmî ulaşım verisi bekleniyor."
  });
});

app.get("/api/stops", (req, res) => {
  if (!db.loaded) {
    return res.json({
      available: false,
      stops: [],
      message: "Resmî durak verisi henüz hazır değil."
    });
  }

  const search = clean(req.query.search);

  if (!search) {
    return res.json({
      available: true,
      stops: [...db.stops.values()]
        .slice(0, 1000)
        .map(stop => serializeStop(stop))
    });
  }

  return res.json({
    available: true,
    stops: findStops(search)
      .map(stop => serializeStop(stop))
  });
});

app.get("/api/stops/nearby", (req, res) => {
  if (!db.loaded) {
    return res.json({
      available: false,
      stops: [],
      message: "Resmî durak verisi henüz hazır değil."
    });
  }

  const lat = number(req.query.lat);
  const lon = number(req.query.lon);
  const limit =
    Math.min(Math.max(Number(req.query.limit) || 10, 1), 50);
  const radius =
    Math.min(Math.max(Number(req.query.radius) || 5000, 100), 20000);

  if (lat === null || lon === null) {
    return res.status(400).json({
      available: false,
      stops: [],
      message: "Geçerli konum bilgisi gerekli."
    });
  }

  const result = [];

  for (const stop of db.stops.values()) {
    const distance =
      distanceMeters(lat, lon, stop.lat, stop.lon);

    if (distance <= radius) {
      result.push({
        ...serializeStop(stop, distance)
      });
    }
  }

  result.sort((a, b) => a.distance - b.distance);

  res.json({
    available: true,
    stops: result.slice(0, limit)
  });
});

app.get("/api/stops/:stopId", (req, res) => {
  if (!db.loaded) {
    return res.json({
      available: false,
      stop: null,
      routes: [],
      message: "Resmî durak verisi henüz hazır değil."
    });
  }

  const stop = db.stops.get(
    clean(req.params.stopId)
  );

  if (!stop) {
    return res.status(404).json({
      available: false,
      stop: null,
      routes: [],
      message: "Durak bulunamadı."
    });
  }

  const routes = getRoutesForStop(stop.id);

  res.json({
    available: true,
    stop: serializeStop(stop),
    routes: routes.map(route => ({
      id: route.id,
      shortName: route.shortName,
      longName: route.longName,
      type: route.type
    }))
  });
});

app.get("/api/routes", (req, res) => {
  if (!db.loaded) {
    return res.json({
      available: false,
      routes: []
    });
  }

  res.json({
    available: true,
    routes: [...db.routes.values()]
  });
});

app.get("/api/routes/:routeId", (req, res) => {
  if (!db.loaded) {
    return res.json({
      available: false,
      route: null,
      trips: []
    });
  }

  const route = db.routes.get(
    clean(req.params.routeId)
  );

  if (!route) {
    return res.status(404).json({
      available: false,
      route: null,
      trips: [],
      message: "Hat bulunamadı."
    });
  }

  const trips = [...db.trips.values()]
    .filter(trip => trip.routeId === route.id)
    .slice(0, 200)
    .map(trip => ({
      id: trip.id,
      serviceId: trip.serviceId,
      headsign: trip.headsign,
      directionId: trip.directionId
    }));

  res.json({
    available: true,
    route,
    trips
  });
});

app.get("/api/live/:stopId", (req, res) => {
  res.json({
    available: false,
    realtime: false,
    stopId: clean(req.params.stopId),
    vehicles: [],
    message:
      "Konya resmî canlı araç API'si bu sunucuda doğrulanmış bir API olarak mevcut değil. Sahte canlı araç konumu gösterilmiyor."
  });
});

app.get("/api/journey/calculate", (req, res) => {
  const from = clean(req.query.from);
  const to = clean(req.query.to);

  if (!from || !to) {
    return res.status(400).json({
      available: false,
      journeys: [],
      message:
        "Başlangıç ve hedef durak bilgisi gerekli."
    });
  }

  if (!db.loaded) {
    return res.json({
      available: false,
      journeys: [],
      message:
        "Resmî sefer verisi henüz hazır değil."
    });
  }

  const fromStop = db.stops.get(from);
  const toStop = db.stops.get(to);

  if (!fromStop || !toStop) {
    return res.status(404).json({
      available: false,
      journeys: [],
      message: "Başlangıç veya hedef durak bulunamadı."
    });
  }

  const fromRecords =
    db.stopTimesByStop.get(from) || [];

  const toRecords =
    db.stopTimesByStop.get(to) || [];

  const destinationTrips = new Map();

  for (const record of toRecords) {
    destinationTrips.set(record.tripId, record);
  }

  const journeys = [];

  for (const startRecord of fromRecords) {
    const endRecord =
      destinationTrips.get(startRecord.tripId);

    if (!endRecord) continue;

    if (
      endRecord.sequence <= startRecord.sequence
    ) {
      continue;
    }

    const trip =
      db.trips.get(startRecord.tripId);

    if (!trip) continue;

    const route = routeForTrip(trip);

    if (!route) continue;

    journeys.push({
      type: "direct",
      transfers: 0,
      route: {
        id: route.id,
        shortName: route.shortName,
        longName: route.longName
      },
      tripId: trip.id,
      headsign: trip.headsign,
      departure: startRecord.departure,
      arrival: endRecord.arrival,
      from: serializeStop(fromStop),
      to: serializeStop(toStop)
    });

    if (journeys.length >= 20) break;
  }

  res.json({
    available: journeys.length > 0,
    journeys,
    message:
      journeys.length
        ? "Doğrudan seferler bulundu."
        : "Bu iki durak arasında doğrulanmış doğrudan sefer bulunamadı."
  });
});

app.get("/api/debug", (req, res) => {
  res.json({
    node: process.version,
    cwd: process.cwd(),
    dataDirectory: DATA_DIR,
    cacheDirectory: CACHE_DIR,
    localGtfsFiles: [
      "stops.txt",
      "routes.txt",
      "trips.txt",
      "stop_times.txt"
    ].map(file => ({
      file,
      exists: fs.existsSync(
        path.join(DATA_DIR, file)
      )
    })),
    officialCacheExists: fs.existsSync(GTFS_CACHE),
    database: {
      loaded: db.loaded,
      stops: db.stops.size,
      routes: db.routes.size,
      trips: db.trips.size,
      stopTimes: db.stopTimes.length
    },
    source: db.source,
    error: db.error
  });
});

app.get("/api/reload", async (req, res) => {
  try {
    await initializeData();

    res.json({
      ok: true,
      available: db.loaded,
      stops: db.stops.size,
      routes: db.routes.size,
      trips: db.trips.size,
      source: db.source,
      error: db.loaded ? null : db.error
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      available: false,
      message: error.message
    });
  }
});

app.use((req, res, next) => {
  if (
    req.path.startsWith("/api/")
  ) {
    return res.status(404).json({
      ok: false,
      message: "API endpoint bulunamadı."
    });
  }

  next();
});

app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "index.html")
  );
});

app.listen(PORT, "0.0.0.0", async () => {
  console.log(
    `Konya Ulaşım Plus ${PORT} portunda başlatıldı.`
  );

  await initializeData();

  console.log(
    `Veri durumu: ${db.loaded ? "HAZIR" : "BEKLENİYOR"}`
  );

  console.log(
    `Durak: ${db.stops.size} | Hat: ${db.routes.size} | Sefer: ${db.trips.size}`
  );

  if (db.error) {
    console.log(
      `Veri kaynağı notu: ${db.error}`
    );
  }
});
