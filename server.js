import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = Number(process.env.PORT) || 10000;

const DATA_DIR = path.join(__dirname, "data");
const CACHE_DIR = path.join(__dirname, "cache");
const CACHE_FILE = path.join(CACHE_DIR, "konya-gtfs.zip");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(CACHE_DIR, { recursive: true });

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(__dirname));

const db = {
  stops: new Map(),
  routes: new Map(),
  trips: new Map(),
  stopTimes: [],
  stopTimesByStop: new Map(),
  stopTimesByTrip: new Map(),

  ready: false,
  source: null,
  loadedAt: null,
  lastError: null
};

/*
  Konya Büyükşehir Belediyesi Açık Veri
  Toplu Taşıma GTFS Verileri
*/
const OFFICIAL_URL =
  "https://acikveri.konya.bel.tr/dataset/c2e034e6-e015-49c6-8eec-6e2f7de9c105/resource/ec944ecd-1c1f-4687-a7f6-fcf2dc5bb5db/download/gtfs_11_2025.zip";

/* -------------------------------------------------------
   GENEL YARDIMCILAR
------------------------------------------------------- */

function str(value) {
  return String(value ?? "").trim();
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function jsonError(res, status, message) {
  return res.status(status).json({
    ok: false,
    available: false,
    message,
    stops: [],
    routes: [],
    trips: []
  });
}

/* -------------------------------------------------------
   CSV PARSER
------------------------------------------------------- */

function parseCSV(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        value += '"';
        i++;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (char === "," && !quoted) {
      row.push(value);
      value = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") {
        i++;
      }

      row.push(value);
      value = "";

      if (row.some(v => str(v) !== "")) {
        rows.push(row);
      }

      row = [];
      continue;
    }

    value += char;
  }

  if (value !== "" || row.length) {
    row.push(value);

    if (row.some(v => str(v) !== "")) {
      rows.push(row);
    }
  }

  if (!rows.length) {
    return [];
  }

  const headers = rows[0].map(header =>
    str(header).replace(/^\uFEFF/, "")
  );

  return rows.slice(1).map(values => {
    const item = {};

    headers.forEach((header, index) => {
      item[header] = str(values[index]);
    });

    return item;
  });
}

/* -------------------------------------------------------
   ZIP OKUMA
------------------------------------------------------- */

function getZipFile(zip, filename) {
  const entry = zip
    .getEntries()
    .find(entry =>
      path.basename(entry.entryName).toLowerCase() ===
      filename.toLowerCase()
    );

  if (!entry) {
    return null;
  }

  return entry.getData().toString("utf8");
}

/* -------------------------------------------------------
   GTFS YÜKLEME
------------------------------------------------------- */

function loadGTFSFromTexts(files, source) {
  const stopsText = files["stops.txt"];
  const routesText = files["routes.txt"];
  const tripsText = files["trips.txt"];
  const stopTimesText = files["stop_times.txt"];

  if (!stopsText) {
    throw new Error("stops.txt bulunamadı.");
  }

  if (!routesText) {
    throw new Error("routes.txt bulunamadı.");
  }

  if (!tripsText) {
    throw new Error("trips.txt bulunamadı.");
  }

  if (!stopTimesText) {
    throw new Error("stop_times.txt bulunamadı.");
  }

  const stopRows = parseCSV(stopsText);
  const routeRows = parseCSV(routesText);
  const tripRows = parseCSV(tripsText);
  const stopTimeRows = parseCSV(stopTimesText);

  const newStops = new Map();
  const newRoutes = new Map();
  const newTrips = new Map();
  const newStopTimes = [];
  const byStop = new Map();
  const byTrip = new Map();

  /* DURAKLAR */

  for (const item of stopRows) {
    const id = str(item.stop_id);
    const name = str(item.stop_name);

    const lat = num(item.stop_lat);
    const lon = num(item.stop_lon);

    if (!id || !name) continue;
    if (lat === null || lon === null) continue;

    newStops.set(id, {
      id,
      name,
      code: str(item.stop_code),
      lat,
      lon
    });
  }

  /* HATLAR */

  for (const item of routeRows) {
    const id = str(item.route_id);

    if (!id) continue;

    newRoutes.set(id, {
      id,
      shortName: str(item.route_short_name),
      longName: str(item.route_long_name),
      type: str(item.route_type)
    });
  }

  /* SEFERLER */

  for (const item of tripRows) {
    const id = str(item.trip_id);
    const routeId = str(item.route_id);

    if (!id || !routeId) continue;

    newTrips.set(id, {
      id,
      routeId,
      serviceId: str(item.service_id),
      headsign: str(item.trip_headsign),
      directionId: str(item.direction_id)
    });
  }

  /* DURAK-SEFER */

  for (const item of stopTimeRows) {
    const tripId = str(item.trip_id);
    const stopId = str(item.stop_id);

    if (!tripId || !stopId) continue;
    if (!newTrips.has(tripId)) continue;
    if (!newStops.has(stopId)) continue;

    const record = {
      tripId,
      stopId,
      arrival: str(item.arrival_time),
      departure: str(item.departure_time),
      sequence: Number(item.stop_sequence) || 0
    };

    newStopTimes.push(record);

    if (!byStop.has(stopId)) {
      byStop.set(stopId, []);
    }

    byStop.get(stopId).push(record);

    if (!byTrip.has(tripId)) {
      byTrip.set(tripId, []);
    }

    byTrip.get(tripId).push(record);
  }

  for (const records of byStop.values()) {
    records.sort((a, b) => a.sequence - b.sequence);
  }

  for (const records of byTrip.values()) {
    records.sort((a, b) => a.sequence - b.sequence);
  }

  /*
    SADECE GEÇERLİ VERİ GELDİYSE DB'Yİ DEĞİŞTİR.
    Böylece bozuk/boş indirme mevcut veriyi silmez.
  */

  if (newStops.size === 0) {
    throw new Error("GTFS içinde geçerli durak bulunamadı.");
  }

  db.stops = newStops;
  db.routes = newRoutes;
  db.trips = newTrips;
  db.stopTimes = newStopTimes;
  db.stopTimesByStop = byStop;
  db.stopTimesByTrip = byTrip;

  db.ready = true;
  db.source = source;
  db.loadedAt = new Date().toISOString();
  db.lastError = null;
}

/* -------------------------------------------------------
   YEREL GTFS
------------------------------------------------------- */

function loadLocalGTFS() {
  const files = [
    "stops.txt",
    "routes.txt",
    "trips.txt",
    "stop_times.txt"
  ];

  const contents = {};

  for (const file of files) {
    const fullPath = path.join(DATA_DIR, file);

    if (!fs.existsSync(fullPath)) {
      return false;
    }

    contents[file] =
      fs.readFileSync(fullPath, "utf8");
  }

  loadGTFSFromTexts(
    contents,
    "Konya Büyükşehir Belediyesi Açık Veri — yerel GTFS"
  );

  return true;
}

/* -------------------------------------------------------
   ZIP GTFS
------------------------------------------------------- */

function loadZipFile(zipPath, source) {
  const zip = new AdmZip(zipPath);

  const files = {};

  for (const file of [
    "stops.txt",
    "routes.txt",
    "trips.txt",
    "stop_times.txt"
  ]) {
    const text = getZipFile(zip, file);

    if (!text) {
      throw new Error(`${file} ZIP içinde bulunamadı.`);
    }

    files[file] = text;
  }

  loadGTFSFromTexts(files, source);
}

/* -------------------------------------------------------
   RESMÎ KAYNAKTAN İNDİRME
------------------------------------------------------- */

async function downloadOfficialData() {
  const response = await fetch(OFFICIAL_URL, {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Accept":
        "application/zip,application/octet-stream,*/*"
    }
  });

  if (!response.ok) {
    throw new Error(
      `Konya resmî veri kaynağı HTTP ${response.status} döndürdü.`
    );
  }

  const buffer =
    Buffer.from(await response.arrayBuffer());

  if (buffer.length < 4) {
    throw new Error("İndirilen GTFS dosyası boş.");
  }

  /*
    ZIP dosyalarının başlangıcı PK olur.
  */

  if (
    buffer[0] !== 0x50 ||
    buffer[1] !== 0x4b
  ) {
    throw new Error(
      "Konya veri kaynağı ZIP dosyası döndürmedi."
    );
  }

  const temporary =
    CACHE_FILE + ".tmp";

  fs.writeFileSync(
    temporary,
    buffer
  );

  /*
    Dosya tamamen yazıldıktan sonra cache'i değiştir.
  */

  fs.renameSync(
    temporary,
    CACHE_FILE
  );

  return true;
}

/* -------------------------------------------------------
   VERİ BAŞLATMA
------------------------------------------------------- */

async function initializeDatabase() {
  /*
    1 — Repo içindeki GTFS
  */

  try {
    if (loadLocalGTFS()) {
      console.log("GTFS: yerel veri kullanılıyor.");
      return;
    }
  } catch (error) {
    console.error(
      "Yerel GTFS hatası:",
      error.message
    );
  }

  /*
    2 — Daha önce başarıyla indirilmiş cache
  */

  if (fs.existsSync(CACHE_FILE)) {
    try {
      loadZipFile(
        CACHE_FILE,
        "Konya Büyükşehir Belediyesi Açık Veri — önbellek"
      );

      console.log(
        "GTFS: önbellekteki resmî veri kullanılıyor."
      );

      /*
        Arka planda güncelleme dene.
      */

      updateOfficialInBackground();

      return;
    } catch (error) {
      console.error(
        "GTFS cache hatası:",
        error.message
      );
    }
  }

  /*
    3 — İlk açılışta resmî kaynak
  */

  try {
    await downloadOfficialData();

    loadZipFile(
      CACHE_FILE,
      "Konya Büyükşehir Belediyesi Açık Veri"
    );

    console.log(
      "GTFS: resmî veri başarıyla indirildi."
    );

    return;
  } catch (error) {
    db.ready = false;
    db.source = "waiting-for-official-data";
    db.lastError = error.message;

    console.error(
      "GTFS alınamadı:",
      error.message
    );
  }
}

/* -------------------------------------------------------
   ARKA PLAN GÜNCELLEME
------------------------------------------------------- */

let updating = false;

async function updateOfficialInBackground() {
  if (updating) return;

  updating = true;

  try {
    await downloadOfficialData();

    /*
      Yeni dosya gerçekten okunabiliyorsa
      mevcut verinin yerine geçir.
    */

    loadZipFile(
      CACHE_FILE,
      "Konya Büyükşehir Belediyesi Açık Veri"
    );

    console.log(
      "GTFS: arka plan güncellemesi başarılı."
    );
  } catch (error) {
    /*
      ÖNEMLİ:
      Eski çalışan resmî veriyi silme.
    */

    console.log(
      "GTFS arka plan güncellemesi başarısız:",
      error.message
    );
  } finally {
    updating = false;
  }
}

/* -------------------------------------------------------
   MESAFE
------------------------------------------------------- */

function distanceMeters(
  lat1,
  lon1,
  lat2,
  lon2
) {
  const R = 6371000;

  const p1 =
    lat1 * Math.PI / 180;

  const p2 =
    lat2 * Math.PI / 180;

  const dp =
    (lat2 - lat1) * Math.PI / 180;

  const dl =
    (lon2 - lon1) * Math.PI / 180;

  const a =
    Math.sin(dp / 2) ** 2 +
    Math.cos(p1) *
    Math.cos(p2) *
    Math.sin(dl / 2) ** 2;

  return (
    2 *
    R *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    )
  );
}

/* -------------------------------------------------------
   DURAK FORMAT
------------------------------------------------------- */

function stopJSON(stop, distance = null) {
  const result = {
    id: stop.id,
    name: stop.name,
    code: stop.code,
    lat: stop.lat,
    lon: stop.lon
  };

  if (distance !== null) {
    result.distance =
      Math.round(distance);
  }

  return result;
}

/* -------------------------------------------------------
   DURAK ARAMA
------------------------------------------------------- */

function searchStops(query) {
  const q =
    str(query).toLocaleLowerCase("tr-TR");

  if (!q) return [];

  const result = [];

  for (const stop of db.stops.values()) {
    const name =
      stop.name.toLocaleLowerCase("tr-TR");

    const code =
      stop.code.toLocaleLowerCase("tr-TR");

    if (
      name.includes(q) ||
      code.includes(q)
    ) {
      result.push(stop);
    }
  }

  return result.slice(0, 100);
}

/* -------------------------------------------------------
   HATLAR
------------------------------------------------------- */

function routesAtStop(stopId) {
  const records =
    db.stopTimesByStop.get(stopId) || [];

  const routeIds = new Set();

  for (const record of records) {
    const trip =
      db.trips.get(record.tripId);

    if (trip) {
      routeIds.add(trip.routeId);
    }
  }

  return [...routeIds]
    .map(id => db.routes.get(id))
    .filter(Boolean);
}

/* -------------------------------------------------------
   HEALTH
------------------------------------------------------- */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "Konya Ulaşım Plus",
    version: "7.0.0",
    dataReady: db.ready,
    stops: db.stops.size,
    routes: db.routes.size,
    trips: db.trips.size,
    time: new Date().toISOString()
  });
});

/* -------------------------------------------------------
   DATA STATUS
------------------------------------------------------- */

app.get("/api/data-status", (req, res) => {
  res.json({
    ok: true,
    available: db.ready,
    ready: db.ready,

    stopCount: db.stops.size,
    routeCount: db.routes.size,
    tripCount: db.trips.size,
    stopTimeCount: db.stopTimes.length,

    source:
      db.source ||
      "waiting-for-official-data",

    loadedAt: db.loadedAt,

    error:
      db.ready
        ? null
        : db.lastError,

    message:
      db.ready
        ? "Resmî ulaşım verisi hazır."
        : "Resmî ulaşım verisi henüz kullanılamıyor."
  });
});

/* -------------------------------------------------------
   APP INFO
------------------------------------------------------- */

app.get("/api/app-info", (req, res) => {
  res.json({
    ok: true,
    name: "Konya Ulaşım Plus",
    version: "7.0.0",
    city: "Konya",

    data: {
      official: true,
      ready: db.ready
    },

    realtimeVehicle:
      false,

    source:
      db.source ||
      "Konya Büyükşehir Belediyesi Açık Veri"
  });
});

/* -------------------------------------------------------
   DURAK ARAMA
------------------------------------------------------- */

app.get("/api/stops", (req, res) => {
  if (!db.ready) {
    return res.json({
      ok: true,
      available: false,
      stops: [],
      message:
        "Resmî durak verisi henüz hazır değil."
    });
  }

  const search =
    str(req.query.search);

  let stops;

  if (search) {
    stops =
      searchStops(search);
  } else {
    stops =
      [...db.stops.values()].slice(0, 1000);
  }

  res.json({
    ok: true,
    available: true,
    count: stops.length,
    stops:
      stops.map(stop => stopJSON(stop))
  });
});

/* -------------------------------------------------------
   YAKIN DURAK
------------------------------------------------------- */

app.get("/api/stops/nearby", (req, res) => {
  if (!db.ready) {
    return res.json({
      ok: true,
      available: false,
      stops: [],
      message:
        "Resmî durak verisi henüz hazır değil."
    });
  }

  const lat = num(req.query.lat);
  const lon = num(req.query.lon);

  if (lat === null || lon === null) {
    return res.status(400).json({
      ok: false,
      available: false,
      stops: [],
      message:
        "Geçerli enlem ve boylam gerekli."
    });
  }

  const limit =
    Math.min(
      Math.max(
        Number(req.query.limit) || 10,
        1
      ),
      50
    );

  const radius =
    Math.min(
      Math.max(
        Number(req.query.radius) || 5000,
        100
      ),
      20000
    );

  const result = [];

  for (const stop of db.stops.values()) {
    const distance =
      distanceMeters(
        lat,
        lon,
        stop.lat,
        stop.lon
      );

    if (distance <= radius) {
      result.push(
        stopJSON(stop, distance)
      );
    }
  }

  result.sort(
    (a, b) =>
      a.distance - b.distance
  );

  res.json({
    ok: true,
    available: true,
    count: Math.min(
      result.length,
      limit
    ),
    stops:
      result.slice(0, limit)
  });
});

/* -------------------------------------------------------
   DURAK DETAY
------------------------------------------------------- */

app.get("/api/stops/:stopId", (req, res) => {
  if (!db.ready) {
    return res.json({
      ok: true,
      available: false,
      stop: null,
      routes: []
    });
  }

  const id =
    str(req.params.stopId);

  const stop =
    db.stops.get(id);

  if (!stop) {
    return res.status(404).json({
      ok: false,
      available: false,
      stop: null,
      routes: [],
      message:
        "Durak bulunamadı."
    });
  }

  const routes =
    routesAtStop(id);

  res.json({
    ok: true,
    available: true,

    stop:
      stopJSON(stop),

    routes:
      routes.map(route => ({
        id: route.id,
        shortName: route.shortName,
        longName: route.longName,
        type: route.type
      }))
  });
});

/* -------------------------------------------------------
   HATLAR
------------------------------------------------------- */

app.get("/api/routes", (req, res) => {
  if (!db.ready) {
    return res.json({
      ok: true,
      available: false,
      routes: []
    });
  }

  res.json({
    ok: true,
    available: true,
    routes:
      [...db.routes.values()]
  });
});

/* -------------------------------------------------------
   HAT DETAY
------------------------------------------------------- */

app.get("/api/routes/:routeId", (req, res) => {
  if (!db.ready) {
    return res.json({
      ok: true,
      available: false,
      route: null,
      trips: []
    });
  }

  const route =
    db.routes.get(
      str(req.params.routeId)
    );

  if (!route) {
    return res.status(404).json({
      ok: false,
      available: false,
      route: null,
      trips: [],
      message:
        "Hat bulunamadı."
    });
  }

  const trips =
    [...db.trips.values()]
      .filter(
        trip =>
          trip.routeId === route.id
      )
      .slice(0, 300);

  res.json({
    ok: true,
    available: true,
    route,
    trips
  });
});

/* -------------------------------------------------------
   CANLI ARAÇ
------------------------------------------------------- */

app.get("/api/live/:stopId", (req, res) => {
  res.json({
    ok: true,
    available: false,
    realtime: false,

    stopId:
      str(req.params.stopId),

    vehicles: [],

    message:
      "Doğrulanmış resmî canlı araç API'si bulunmadığı için sahte araç konumu gösterilmiyor."
  });
});

/* -------------------------------------------------------
   DOĞRUDAN SEFER
------------------------------------------------------- */

app.get("/api/journey/calculate", (req, res) => {
  const from =
    str(req.query.from);

  const to =
    str(req.query.to);

  if (!from || !to) {
    return res.status(400).json({
      ok: false,
      available: false,
      journeys: [],
      message:
        "Başlangıç ve hedef durağı gerekli."
    });
  }

  if (!db.ready) {
    return res.json({
      ok: true,
      available: false,
      journeys: [],
      message:
        "Resmî sefer verisi hazır değil."
    });
  }

  const fromStop =
    db.stops.get(from);

  const toStop =
    db.stops.get(to);

  if (!fromStop || !toStop) {
    return res.status(404).json({
      ok: false,
      available: false,
      journeys: [],
      message:
        "Başlangıç veya hedef durak bulunamadı."
    });
  }

  const startRecords =
    db.stopTimesByStop.get(from) || [];

  const endRecords =
    db.stopTimesByStop.get(to) || [];

  const endMap = new Map();

  for (const record of endRecords) {
    endMap.set(
      record.tripId,
      record
    );
  }

  const journeys = [];

  for (const start of startRecords) {
    const end =
      endMap.get(start.tripId);

    if (!end) continue;

    if (
      end.sequence <= start.sequence
    ) {
      continue;
    }

    const trip =
      db.trips.get(start.tripId);

    if (!trip) continue;

    const route =
      db.routes.get(trip.routeId);

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

      headsign:
        trip.headsign,

      departure:
        start.departure,

      arrival:
        end.arrival,

      from:
        stopJSON(fromStop),

      to:
        stopJSON(toStop)
    });

    if (journeys.length >= 30) {
      break;
    }
  }

  res.json({
    ok: true,
    available:
      journeys.length > 0,

    journeys,

    message:
      journeys.length
        ? "Doğrudan seferler bulundu."
        : "Doğrulanmış doğrudan sefer bulunamadı."
  });
});

/* -------------------------------------------------------
   MANUEL YENİLEME
------------------------------------------------------- */

app.get("/api/reload", async (req, res) => {
  await initializeDatabase();

  res.json({
    ok: true,
    available: db.ready,
    stops: db.stops.size,
    routes: db.routes.size,
    trips: db.trips.size,
    source: db.source,
    error:
      db.ready
        ? null
        : db.lastError
  });
});

/* -------------------------------------------------------
   DEBUG
------------------------------------------------------- */

app.get("/api/debug", (req, res) => {
  res.json({
    ok: true,

    node:
      process.version,

    database: {
      ready: db.ready,
      stops: db.stops.size,
      routes: db.routes.size,
      trips: db.trips.size,
      stopTimes:
        db.stopTimes.length
    },

    source:
      db.source,

    loadedAt:
      db.loadedAt,

    error:
      db.lastError,

    cache:
      fs.existsSync(CACHE_FILE),

    localData: [
      "stops.txt",
      "routes.txt",
      "trips.txt",
      "stop_times.txt"
    ].map(file => ({
      file,
      exists:
        fs.existsSync(
          path.join(DATA_DIR, file)
        )
    }))
  });
});

/* -------------------------------------------------------
   API 404
------------------------------------------------------- */

app.use("/api", (req, res) => {
  res.status(404).json({
    ok: false,
    available: false,
    message:
      "API adresi bulunamadı."
  });
});

/* -------------------------------------------------------
   INDEX
------------------------------------------------------- */

app.get("/", (req, res) => {
  res.sendFile(
    path.join(
      __dirname,
      "index.html"
    )
  );
});

/* -------------------------------------------------------
   SUNUCU
------------------------------------------------------- */

app.listen(
  PORT,
  "0.0.0.0",
  async () => {
    console.log(
      `Konya Ulaşım Plus çalışıyor: ${PORT}`
    );

    await initializeDatabase();

    console.log(
      `VERİ DURUMU: ${
        db.ready
          ? "HAZIR"
          : "VERİ BEKLENİYOR"
      }`
    );

    console.log(
      `Durak: ${db.stops.size}`
    );

    console.log(
      `Hat: ${db.routes.size}`
    );

    console.log(
      `Sefer: ${db.trips.size}`
    );
  }
);
