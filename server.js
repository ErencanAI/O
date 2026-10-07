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
app.use(express.json());
app.use(express.static(__dirname));

const DATA_DIR = path.join(__dirname, "data");
const CACHE_DIR = path.join(__dirname, "cache");
const CACHE_FILE = path.join(CACHE_DIR, "gtfs.zip");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(CACHE_DIR, { recursive: true });

const db = {
  stops: new Map(),
  routes: new Map(),
  trips: new Map(),
  stopTimes: new Map(),
  ready: false,
  source: "waiting-for-official-data",
  loadedAt: null,
  error: null
};

function clean(v) {
  return String(v ?? "").trim();
}

function number(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function csv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quote = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (c === '"') {
      if (quote && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quote = !quote;
      }
    } else if (c === "," && !quote) {
      row.push(cell);
      cell = "";
    } else if ((c === "\n" || c === "\r") && !quote) {
      if (c === "\r" && text[i + 1] === "\n") i++;

      row.push(cell);
      cell = "";

      if (row.some(x => clean(x))) {
        rows.push(row);
      }

      row = [];
    } else {
      cell += c;
    }
  }

  if (cell || row.length) {
    row.push(cell);
    if (row.some(x => clean(x))) rows.push(row);
  }

  if (!rows.length) return [];

  const headers = rows[0].map(x =>
    clean(x).replace(/^\uFEFF/, "")
  );

  return rows.slice(1).map(values => {
    const item = {};

    headers.forEach((header, i) => {
      item[header] = clean(values[i]);
    });

    return item;
  });
}

function zipText(zip, filename) {
  const entry = zip.getEntries().find(e =>
    path.basename(e.entryName).toLowerCase() ===
    filename.toLowerCase()
  );

  if (!entry) return null;

  return entry.getData().toString("utf8");
}

function loadGTFS(files, source) {
  if (!files.stops || !files.routes || !files.trips || !files.stop_times) {
    throw new Error("GTFS dosyaları eksik.");
  }

  const stops = new Map();
  const routes = new Map();
  const trips = new Map();
  const stopTimes = new Map();

  for (const x of csv(files.stops)) {
    const id = clean(x.stop_id);
    const lat = number(x.stop_lat);
    const lon = number(x.stop_lon);

    if (!id || !clean(x.stop_name)) continue;
    if (lat === null || lon === null) continue;

    stops.set(id, {
      id,
      name: clean(x.stop_name),
      code: clean(x.stop_code),
      lat,
      lon
    });
  }

  for (const x of csv(files.routes)) {
    const id = clean(x.route_id);
    if (!id) continue;

    routes.set(id, {
      id,
      shortName: clean(x.route_short_name),
      longName: clean(x.route_long_name),
      type: clean(x.route_type)
    });
  }

  for (const x of csv(files.trips)) {
    const id = clean(x.trip_id);
    if (!id) continue;

    trips.set(id, {
      id,
      routeId: clean(x.route_id),
      serviceId: clean(x.service_id),
      headsign: clean(x.trip_headsign),
      directionId: clean(x.direction_id)
    });
  }

  for (const x of csv(files.stop_times)) {
    const tripId = clean(x.trip_id);
    const stopId = clean(x.stop_id);

    if (!tripId || !stopId) continue;
    if (!trips.has(tripId)) continue;
    if (!stops.has(stopId)) continue;

    if (!stopTimes.has(stopId)) {
      stopTimes.set(stopId, []);
    }

    stopTimes.get(stopId).push({
      tripId,
      arrival: clean(x.arrival_time),
      departure: clean(x.departure_time),
      sequence: Number(x.stop_sequence) || 0
    });
  }

  if (stops.size === 0) {
    throw new Error("Geçerli durak verisi bulunamadı.");
  }

  db.stops = stops;
  db.routes = routes;
  db.trips = trips;
  db.stopTimes = stopTimes;
  db.ready = true;
  db.source = source;
  db.loadedAt = new Date().toISOString();
  db.error = null;
}

function loadLocal() {
  const names = [
    "stops.txt",
    "routes.txt",
    "trips.txt",
    "stop_times.txt"
  ];

  const files = {};

  for (const name of names) {
    const file = path.join(DATA_DIR, name);

    if (!fs.existsSync(file)) {
      return false;
    }

    files[name.replace(".txt", "")] =
      fs.readFileSync(file, "utf8");
  }

  loadGTFS(
    files,
    "Konya Büyükşehir Belediyesi Açık Veri"
  );

  return true;
}

function loadZip(file, source) {
  const zip = new AdmZip(file);

  loadGTFS(
    {
      stops: zipText(zip, "stops.txt"),
      routes: zipText(zip, "routes.txt"),
      trips: zipText(zip, "trips.txt"),
      stop_times: zipText(zip, "stop_times.txt")
    },
    source
  );
}

async function downloadOfficial() {
  const url =
    process.env.GTFS_URL ||
    "https://acikveri.konya.bel.tr/dataset/c2e034e6-e015-49c6-8eec-6e2f7de9c105/resource/ec944ecd-1c1f-4687-a7f6-fcf2dc5bb5db/download/gtfs_11_2025.zip";

  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "Konya-Ulasim-Plus/1.0",
      "Accept": "*/*"
    }
  });

  if (!response.ok) {
    throw new Error(`GTFS HTTP ${response.status}`);
  }

  const buffer =
    Buffer.from(await response.arrayBuffer());

  if (
    buffer.length < 4 ||
    buffer[0] !== 0x50 ||
    buffer[1] !== 0x4b
  ) {
    throw new Error("Geçerli ZIP alınamadı.");
  }

  const temp = CACHE_FILE + ".tmp";

  fs.writeFileSync(temp, buffer);
  fs.renameSync(temp, CACHE_FILE);
}

async function startData() {
  try {
    if (loadLocal()) {
      console.log("GTFS yerel dosyalardan yüklendi.");
      return;
    }
  } catch (e) {
    console.log("Yerel GTFS:", e.message);
  }

  if (fs.existsSync(CACHE_FILE)) {
    try {
      loadZip(
        CACHE_FILE,
        "Konya Büyükşehir Belediyesi Açık Veri — önbellek"
      );

      console.log("GTFS cache kullanılıyor.");
      return;
    } catch (e) {
      console.log("Cache okunamadı:", e.message);
    }
  }

  try {
    await downloadOfficial();

    loadZip(
      CACHE_FILE,
      "Konya Büyükşehir Belediyesi Açık Veri"
    );

    console.log("Resmî GTFS indirildi.");
  } catch (e) {
    db.ready = false;
    db.source = "waiting-for-official-data";
    db.error = e.message;

    console.log(
      "Resmî GTFS şu anda alınamadı:",
      e.message
    );
  }
}

function distance(a, b, c, d) {
  const R = 6371000;
  const p1 = a * Math.PI / 180;
  const p2 = c * Math.PI / 180;
  const dp = (c - a) * Math.PI / 180;
  const dl = (d - b) * Math.PI / 180;

  const x =
    Math.sin(dp / 2) ** 2 +
    Math.cos(p1) *
    Math.cos(p2) *
    Math.sin(dl / 2) ** 2;

  return 2 * R * Math.atan2(
    Math.sqrt(x),
    Math.sqrt(1 - x)
  );
}

function stopResult(stop, meters) {
  return {
    id: stop.id,
    name: stop.name,
    code: stop.code,
    lat: stop.lat,
    lon: stop.lon,
    distance:
      meters == null ? undefined : Math.round(meters)
  };
}

/* HEALTH */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "Konya Ulaşım Plus",
    dataReady: db.ready,
    stops: db.stops.size,
    routes: db.routes.size,
    trips: db.trips.size
  });
});

/* DATA STATUS */

app.get("/api/data-status", (req, res) => {
  res.json({
    ok: true,
    available: db.ready,
    ready: db.ready,
    stopCount: db.stops.size,
    routeCount: db.routes.size,
    tripCount: db.trips.size,
    stopTimeCount:
      [...db.stopTimes.values()]
        .reduce((a, b) => a + b.length, 0),
    source: db.source,
    loadedAt: db.loadedAt,
    error: db.ready ? null : db.error,
    message: db.ready
      ? "Resmî ulaşım verisi hazır."
      : "Resmî ulaşım verisi hazır değil."
  });
});

/* APP INFO */

app.get("/api/app-info", (req, res) => {
  res.json({
    ok: true,
    name: "Konya Ulaşım Plus",
    version: "8.0.0",
    city: "Konya",
    officialData: true,
    realtime: false
  });
});

/* STOP SEARCH */

app.get("/api/stops", (req, res) => {
  if (!db.ready) {
    return res.json({
      ok: true,
      available: false,
      stops: []
    });
  }

  const q =
    clean(req.query.search)
      .toLocaleLowerCase("tr-TR");

  let result = [...db.stops.values()];

  if (q) {
    result = result.filter(stop =>
      stop.name
        .toLocaleLowerCase("tr-TR")
        .includes(q) ||
      stop.code
        .toLocaleLowerCase("tr-TR")
        .includes(q)
    );
  }

  result = result.slice(0, 100);

  res.json({
    ok: true,
    available: true,
    count: result.length,
    stops: result.map(x => stopResult(x, null))
  });
});

/* NEARBY */

app.get("/api/stops/nearby", (req, res) => {
  if (!db.ready) {
    return res.json({
      ok: true,
      available: false,
      stops: []
    });
  }

  const lat = number(req.query.lat);
  const lon = number(req.query.lon);

  if (lat === null || lon === null) {
    return res.status(400).json({
      ok: false,
      available: false,
      stops: [],
      message: "Konum bilgisi geçersiz."
    });
  }

  const limit =
    Math.min(
      Math.max(Number(req.query.limit) || 10, 1),
      50
    );

  const result = [];

  for (const stop of db.stops.values()) {
    const meters =
      distance(
        lat,
        lon,
        stop.lat,
        stop.lon
      );

    result.push({
      ...stopResult(stop, meters),
      walkingMinutes:
        Math.max(1, Math.ceil(meters / 80))
    });
  }

  result.sort(
    (a, b) => a.distance - b.distance
  );

  res.json({
    ok: true,
    available: true,
    count: Math.min(result.length, limit),
    stops: result.slice(0, limit)
  });
});

/* STOP DETAIL */

app.get("/api/stops/:id", (req, res) => {
  if (!db.ready) {
    return res.json({
      ok: true,
      available: false,
      stop: null,
      routes: []
    });
  }

  const stop =
    db.stops.get(clean(req.params.id));

  if (!stop) {
    return res.status(404).json({
      ok: false,
      available: false,
      stop: null,
      routes: []
    });
  }

  const records =
    db.stopTimes.get(stop.id) || [];

  const routeIds = new Set();

  for (const record of records) {
    const trip = db.trips.get(record.tripId);
    if (trip) routeIds.add(trip.routeId);
  }

  const routes = [...routeIds]
    .map(id => db.routes.get(id))
    .filter(Boolean);

  res.json({
    ok: true,
    available: true,
    stop: stopResult(stop, null),
    routes
  });
});

/* ROUTES */

app.get("/api/routes", (req, res) => {
  res.json({
    ok: true,
    available: db.ready,
    routes: db.ready
      ? [...db.routes.values()]
      : []
  });
});

/* REALTIME */

app.get("/api/live/:id", (req, res) => {
  res.json({
    ok: true,
    available: false,
    realtime: false,
    vehicles: [],
    message:
      "Doğrulanmış resmî canlı araç API'si mevcut değil."
  });
});

/* JOURNEY */

app.get("/api/journey/calculate", (req, res) => {
  const from = clean(req.query.from);
  const to = clean(req.query.to);

  if (!from || !to) {
    return res.status(400).json({
      ok: false,
      available: false,
      journeys: [],
      message:
        "Başlangıç ve hedef durağı seçilmelidir."
    });
  }

  if (!db.ready) {
    return res.json({
      ok: true,
      available: false,
      journeys: []
    });
  }

  const start = db.stops.get(from);
  const target = db.stops.get(to);

  if (!start || !target) {
    return res.status(404).json({
      ok: false,
      available: false,
      journeys: []
    });
  }

  const starts =
    db.stopTimes.get(from) || [];

  const ends =
    db.stopTimes.get(to) || [];

  const endMap = new Map(
    ends.map(x => [x.tripId, x])
  );

  const journeys = [];

  for (const s of starts) {
    const e = endMap.get(s.tripId);
    if (!e) continue;

    if (e.sequence <= s.sequence) continue;

    const trip = db.trips.get(s.tripId);
    if (!trip) continue;

    const route = db.routes.get(trip.routeId);
    if (!route) continue;

    journeys.push({
      type: "direct",
      transfers: 0,
      tripId: trip.id,
      departure: s.departure,
      arrival: e.arrival,
      headsign: trip.headsign,
      route,
      from: stopResult(start, null),
      to: stopResult(target, null)
    });

    if (journeys.length >= 50) break;
  }

  res.json({
    ok: true,
    available: journeys.length > 0,
    journeys
  });
});

/* ROOT */

app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "index.html")
  );
});

/* API 404 */

app.use("/api", (req, res) => {
  res.status(404).json({
    ok: false,
    message: "API bulunamadı."
  });
});

/* ERROR */

app.use((err, req, res, next) => {
  console.error(err);

  res.status(500).json({
    ok: false,
    message: "Sunucu hatası."
  });
});

/* START */

app.listen(PORT, "0.0.0.0", async () => {
  console.log(
    `Konya Ulaşım Plus ${PORT} portunda başladı.`
  );

  await startData();

  console.log(
    `Durak: ${db.stops.size} | Hat: ${db.routes.size} | Sefer: ${db.trips.size}`
  );
});
