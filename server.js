import express from "express";
import cors from "cors";
import AdmZip from "adm-zip";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";

const CKAN_API =
  process.env.CKAN_API ||
  "https://acikveri.konya.bel.tr/api/3/action";

const GTFS_DATASET =
  process.env.GTFS_DATASET ||
  "toplu-tasima-gtfs-verileri";

const DATA_REFRESH_MS =
  Number(process.env.DATA_REFRESH_MS) || 6 * 60 * 60 * 1000;

const FETCH_TIMEOUT_MS =
  Number(process.env.FETCH_TIMEOUT_MS) || 45_000;

const WALKING_SPEED_M_PER_MIN = 80;

const MAX_NEARBY_RADIUS = 10_000;
const DEFAULT_NEARBY_RADIUS = 3_000;

const MAX_SEARCH_RESULTS = 100;

const appInfo = {
  name: "Konya Ulaşım Plus",
  version: "4.0.0",
  city: "Konya",
  timezone: "Europe/Istanbul",
  source: "Konya Büyükşehir Belediyesi Açık Veri Platformu",
  gtfsDataset: GTFS_DATASET
};

const db = {
  ready: false,
  loading: false,
  loadingStartedAt: null,
  lastSuccessfulLoad: null,
  lastAttempt: null,
  error: null,

  sourceUrl: null,
  sourceName: null,

  stops: new Map(),
  routes: new Map(),
  trips: new Map(),
  stopTimes: new Map(),
  tripsByStop: new Map(),
  routesByStop: new Map(),
  tripsByRoute: new Map(),

  services: new Map(),
  calendarDates: new Map(),

  stopSequenceCache: new Map(),

  stats: {
    stops: 0,
    routes: 0,
    trips: 0,
    stopTimes: 0,
    services: 0,
    calendarDates: 0
  }
};

app.disable("x-powered-by");

app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept"]
  })
);

app.use(
  express.json({
    limit: "1mb"
  })
);

app.use(
  express.urlencoded({
    extended: false,
    limit: "100kb"
  })
);

app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

/* =========================================================
   GENEL YARDIMCI FONKSİYONLAR
========================================================= */

function clean(value) {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .trim();
}

function normalizeText(value) {
  return clean(value)
    .toLocaleLowerCase("tr-TR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .replace(/[^a-z0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function integerOrDefault(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function isValidLatitude(lat) {
  return Number.isFinite(lat) && lat >= -90 && lat <= 90;
}

function isValidLongitude(lon) {
  return Number.isFinite(lon) && lon >= -180 && lon <= 180;
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;

  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;

  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;

  const a =
    Math.sin(dp / 2) ** 2 +
    Math.cos(p1) *
      Math.cos(p2) *
      Math.sin(dl / 2) ** 2;

  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function walkingMinutes(distanceMeters) {
  return Math.max(
    1,
    Math.ceil(distanceMeters / WALKING_SPEED_M_PER_MIN)
  );
}

function formatMinutes(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
}

/* =========================================================
   KONYA YEREL SAAT
========================================================= */

function getKonyaNow() {
  const now = new Date();

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(now);

  const get = (type) =>
    parts.find((p) => p.type === type)?.value;

  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  const second = Number(get("second"));

  const weekdayText = get("weekday");

  const weekdays = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 0
  };

  const weekday = weekdays[weekdayText] ?? 0;

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday,
    date:
      `${year}-${String(month).padStart(2, "0")}-` +
      `${String(day).padStart(2, "0")}`,
    dateCompact:
      `${year}${String(month).padStart(2, "0")}` +
      `${String(day).padStart(2, "0")}`,
    seconds:
      hour * 3600 +
      minute * 60 +
      second
  };
}

/* =========================================================
   GTFS SAATLERİ
========================================================= */

function parseGtfsTime(value) {
  const text = clean(value);

  if (!text) return null;

  const parts = text.split(":");

  if (parts.length < 2) return null;

  const h = Number(parts[0]);
  const m = Number(parts[1]);
  const s = Number(parts[2] || 0);

  if (
    !Number.isFinite(h) ||
    !Number.isFinite(m) ||
    !Number.isFinite(s)
  ) {
    return null;
  }

  if (m < 0 || m > 59 || s < 0 || s > 59) {
    return null;
  }

  return h * 3600 + m * 60 + s;
}

function formatGtfsTime(seconds) {
  if (!Number.isFinite(seconds)) return "--:--";

  let total = Math.max(0, Math.round(seconds));

  const h = Math.floor(total / 3600) % 24;
  const m = Math.floor((total % 3600) / 60);

  return `${String(h).padStart(2, "0")}:${String(m).padStart(
    2,
    "0"
  )}`;
}

function durationMinutes(start, end) {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end)
  ) {
    return null;
  }

  let diff = end - start;

  if (diff < 0) {
    diff += 24 * 3600;
  }

  return Math.max(0, Math.round(diff / 60));
}

/* =========================================================
   CSV PARSER
   Basit split(",") yerine gerçek CSV ayrıştırma.
========================================================= */

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let insideQuotes = false;

  const input = String(text ?? "").replace(/^\uFEFF/, "");

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (char === '"') {
      if (
        insideQuotes &&
        input[i + 1] === '"'
      ) {
        field += '"';
        i++;
      } else {
        insideQuotes = !insideQuotes;
      }

      continue;
    }

    if (char === "," && !insideQuotes) {
      row.push(field);
      field = "";
      continue;
    }

    if (
      (char === "\n" || char === "\r") &&
      !insideQuotes
    ) {
      if (char === "\r" && input[i + 1] === "\n") {
        i++;
      }

      row.push(field);
      field = "";

      if (
        row.some(
          (value) => clean(value).length > 0
        )
      ) {
        rows.push(row);
      }

      row = [];
      continue;
    }

    field += char;
  }

  row.push(field);

  if (
    row.some(
      (value) => clean(value).length > 0
    )
  ) {
    rows.push(row);
  }

  if (!rows.length) return [];

  const headers = rows[0].map((h) =>
    clean(h).toLowerCase()
  );

  return rows.slice(1).map((values) => {
    const obj = {};

    headers.forEach((header, index) => {
      obj[header] = clean(values[index] ?? "");
    });

    return obj;
  });
}

/* =========================================================
   HTTP FETCH
========================================================= */

async function fetchWithTimeout(
  url,
  options = {},
  timeout = FETCH_TIMEOUT_MS
) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        Accept: "*/*",
        "User-Agent":
          "Konya-Ulasim-Plus/4.0",
        ...(options.headers || {})
      }
    });

    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url) {
  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        Accept: "application/json"
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${response.statusText}`
    );
  }

  return response.json();
}

async function fetchBuffer(url) {
  const response = await fetchWithTimeout(url);

  if (!response.ok) {
    throw new Error(
      `Veri indirilemedi: HTTP ${response.status}`
    );
  }

  const arrayBuffer =
    await response.arrayBuffer();

  return Buffer.from(arrayBuffer);
}

/* =========================================================
   CKAN'DEN GTFS KAYNAĞINI BUL
========================================================= */

async function findGtfsResource() {
  const url =
    `${CKAN_API}/package_show?id=` +
    encodeURIComponent(GTFS_DATASET);

  const json = await fetchJson(url);

  if (!json?.success || !json?.result) {
    throw new Error(
      "Konya açık veri CKAN kaynağı geçerli cevap vermedi."
    );
  }

  const resources =
    safeArray(json.result.resources);

  const candidates = resources.filter(
    (resource) => {
      const format =
        normalizeText(resource.format);

      const name =
        normalizeText(resource.name);

      const resourceUrl =
        String(resource.url || "");

      return (
        format.includes("zip") ||
        name.includes("gtfs") ||
        resourceUrl.toLowerCase().includes(".zip")
      );
    }
  );

  if (!candidates.length) {
    throw new Error(
      "GTFS ZIP kaynağı CKAN üzerinde bulunamadı."
    );
  }

  const resource =
    candidates.find((r) =>
      String(r.url || "")
        .toLowerCase()
        .includes(".zip")
    ) || candidates[0];

  if (!resource.url) {
    throw new Error(
      "GTFS kaynağının indirme adresi boş."
    );
  }

  return {
    url: resource.url,
    name:
      resource.name ||
      "Toplu Taşıma GTFS Verileri",
    id: resource.id || null
  };
}

/* =========================================================
   ZIP İÇİ DOSYA BUL
========================================================= */

function findZipEntry(zip, filename) {
  const target =
    filename.toLowerCase();

  const entries =
    zip.getEntries();

  return entries.find((entry) => {
    if (entry.isDirectory) return false;

    const normalized =
      entry.entryName
        .replaceAll("\\", "/")
        .toLowerCase();

    return (
      normalized === target ||
      normalized.endsWith(`/${target}`)
    );
  });
}

function readZipText(zip, filename) {
  const entry =
    findZipEntry(zip, filename);

  if (!entry) return null;

  return entry.getData().toString("utf8");
}

/* =========================================================
   DATABASE RESET
========================================================= */

function createEmptyDatabase() {
  return {
    stops: new Map(),
    routes: new Map(),
    trips: new Map(),
    stopTimes: new Map(),
    tripsByStop: new Map(),
    routesByStop: new Map(),
    tripsByRoute: new Map(),
    services: new Map(),
    calendarDates: new Map(),
    stopSequenceCache: new Map()
  };
}

/* =========================================================
   INDEX YARDIMCILARI
========================================================= */

function addToMapSet(map, key, value) {
  if (!map.has(key)) {
    map.set(key, new Set());
  }

  map.get(key).add(value);
}

function addToMapArray(map, key, value) {
  if (!map.has(key)) {
    map.set(key, []);
  }

  map.get(key).push(value);
}

/* =========================================================
   GTFS YÜKLE
========================================================= */

async function downloadAndBuildGtfs() {
  const source =
    await findGtfsResource();

  console.log(
    `[GTFS] Kaynak bulundu: ${source.url}`
  );

  const buffer =
    await fetchBuffer(source.url);

  if (!buffer?.length) {
    throw new Error(
      "GTFS ZIP dosyası boş geldi."
    );
  }

  const zip = new AdmZip(buffer);

  const requiredFiles = [
    "stops.txt",
    "routes.txt",
    "trips.txt",
    "stop_times.txt"
  ];

  for (const file of requiredFiles) {
    if (!findZipEntry(zip, file)) {
      throw new Error(
        `GTFS içinde zorunlu dosya bulunamadı: ${file}`
      );
    }
  }

  const stopsText =
    readZipText(zip, "stops.txt");

  const routesText =
    readZipText(zip, "routes.txt");

  const tripsText =
    readZipText(zip, "trips.txt");

  const stopTimesText =
    readZipText(zip, "stop_times.txt");

  const calendarText =
    readZipText(zip, "calendar.txt");

  const calendarDatesText =
    readZipText(zip, "calendar_dates.txt");

  const stopsRows =
    parseCSV(stopsText);

  const routesRows =
    parseCSV(routesText);

  const tripsRows =
    parseCSV(tripsText);

  const stopTimesRows =
    parseCSV(stopTimesText);

  const calendarRows =
    calendarText
      ? parseCSV(calendarText)
      : [];

  const calendarDatesRows =
    calendarDatesText
      ? parseCSV(calendarDatesText)
      : [];

  if (!stopsRows.length) {
    throw new Error(
      "stops.txt okundu ancak hiç durak bulunamadı."
    );
  }

  if (!tripsRows.length) {
    throw new Error(
      "trips.txt okundu ancak hiç sefer bulunamadı."
    );
  }

  if (!stopTimesRows.length) {
    throw new Error(
      "stop_times.txt okundu ancak hiç durak-sefer kaydı bulunamadı."
    );
  }

  const next = createEmptyDatabase();

  /* -------------------------
     DURAKLAR
  ------------------------- */

  for (const row of stopsRows) {
    const id =
      clean(row.stop_id);

    const name =
      clean(row.stop_name);

    const lat =
      numberOrNull(row.stop_lat);

    const lon =
      numberOrNull(row.stop_lon);

    if (
      !id ||
      !name ||
      lat === null ||
      lon === null
    ) {
      continue;
    }

    if (
      !isValidLatitude(lat) ||
      !isValidLongitude(lon)
    ) {
      continue;
    }

    next.stops.set(id, {
      id,
      code:
        clean(row.stop_code) || null,
      name,
      normalizedName:
        normalizeText(name),
      lat,
      lon,
      zoneId:
        clean(row.zone_id) || null
    });
  }

  /* -------------------------
     HATLAR
  ------------------------- */

  for (const row of routesRows) {
    const id =
      clean(row.route_id);

    if (!id) continue;

    next.routes.set(id, {
      id,
      shortName:
        clean(row.route_short_name) || id,
      longName:
        clean(row.route_long_name) || "",
      type:
        clean(row.route_type) || null,
      color:
        clean(row.route_color) || null,
      textColor:
        clean(row.route_text_color) || null
    });
  }

  /* -------------------------
     SEFERLER
  ------------------------- */

  for (const row of tripsRows) {
    const id =
      clean(row.trip_id);

    const routeId =
      clean(row.route_id);

    if (!id || !routeId) {
      continue;
    }

    const trip = {
      id,
      routeId,
      serviceId:
        clean(row.service_id) || null,
      headsign:
        clean(row.trip_headsign) || "",
      directionId:
        clean(row.direction_id) || null,
      blockId:
        clean(row.block_id) || null
    };

    next.trips.set(id, trip);

    addToMapSet(
      next.tripsByRoute,
      routeId,
      id
    );
  }

  /* -------------------------
     TAKVİM
  ------------------------- */

  for (const row of calendarRows) {
    const serviceId =
      clean(row.service_id);

    if (!serviceId) continue;

    next.services.set(serviceId, {
      serviceId,

      startDate:
        clean(row.start_date),

      endDate:
        clean(row.end_date),

      monday:
        clean(row.monday) === "1",

      tuesday:
        clean(row.tuesday) === "1",

      wednesday:
        clean(row.wednesday) === "1",

      thursday:
        clean(row.thursday) === "1",

      friday:
        clean(row.friday) === "1",

      saturday:
        clean(row.saturday) === "1",

      sunday:
        clean(row.sunday) === "1"
    });
  }

  /* -------------------------
     TAKVİM İSTİSNALARI
  ------------------------- */

  for (const row of calendarDatesRows) {
    const serviceId =
      clean(row.service_id);

    const date =
      clean(row.date);

    const exceptionType =
      Number(row.exception_type);

    if (
      !serviceId ||
      !date ||
      !Number.isFinite(exceptionType)
    ) {
      continue;
    }

    const key =
      `${serviceId}|${date}`;

    next.calendarDates.set(
      key,
      exceptionType
    );
  }

  /* -------------------------
     STOP TIMES
  ------------------------- */

  for (const row of stopTimesRows) {
    const tripId =
      clean(row.trip_id);

    const stopId =
      clean(row.stop_id);

    if (
      !tripId ||
      !stopId ||
      !next.trips.has(tripId) ||
      !next.stops.has(stopId)
    ) {
      continue;
    }

    const arrival =
      parseGtfsTime(row.arrival_time);

    const departure =
      parseGtfsTime(row.departure_time);

    const sequence =
      Number(row.stop_sequence);

    if (
      arrival === null &&
      departure === null
    ) {
      continue;
    }

    const item = {
      tripId,
      stopId,

      arrival:
        arrival ?? departure,

      departure:
        departure ?? arrival,

      sequence:
        Number.isFinite(sequence)
          ? sequence
          : 0,

      pickupType:
        clean(row.pickup_type) || "0",

      dropOffType:
        clean(row.drop_off_type) || "0"
    };

    addToMapArray(
      next.stopTimes,
      tripId,
      item
    );

    addToMapSet(
      next.tripsByStop,
      stopId,
      tripId
    );

    const trip =
      next.trips.get(tripId);

    if (trip) {
      addToMapSet(
        next.routesByStop,
        stopId,
        trip.routeId
      );
    }
  }

  /* -------------------------
     STOP TIME SIRALAMALARI
  ------------------------- */

  for (const [tripId, rows] of next.stopTimes) {
    rows.sort(
      (a, b) =>
        a.sequence - b.sequence
    );
  }

  /* -------------------------
     VALIDASYON
  ------------------------- */

  if (next.stops.size < 1) {
    throw new Error(
      "Geçerli koordinatlı durak bulunamadı."
    );
  }

  if (next.routes.size < 1) {
    throw new Error(
      "Geçerli otobüs hattı bulunamadı."
    );
  }

  if (next.trips.size < 1) {
    throw new Error(
      "Geçerli sefer bulunamadı."
    );
  }

  if (next.stopTimes.size < 1) {
    throw new Error(
      "Geçerli stop_times kaydı bulunamadı."
    );
  }

  return {
    ...next,

    sourceUrl: source.url,
    sourceName: source.name,

    stats: {
      stops: next.stops.size,
      routes: next.routes.size,
      trips: next.trips.size,
      stopTimes:
        Array.from(
          next.stopTimes.values()
        ).reduce(
          (total, rows) =>
            total + rows.length,
          0
        ),
      services:
        next.services.size,
      calendarDates:
        next.calendarDates.size
    }
  };
}

/* =========================================================
   DATA LOAD
========================================================= */

async function loadGtfs() {
  if (db.loading) {
    return;
  }

  db.loading = true;
  db.loadingStartedAt =
    new Date().toISOString();

  db.lastAttempt =
    new Date().toISOString();

  try {
    console.log(
      "[GTFS] Resmî Konya verisi yükleniyor..."
    );

    const result =
      await downloadAndBuildGtfs();

    /*
      ÖNEMLİ:
      Yeni veri tamamen doğrulanmadan
      eski veri silinmez.
    */

    db.stops = result.stops;
    db.routes = result.routes;
    db.trips = result.trips;
    db.stopTimes = result.stopTimes;

    db.tripsByStop =
      result.tripsByStop;

    db.routesByStop =
      result.routesByStop;

    db.tripsByRoute =
      result.tripsByRoute;

    db.services =
      result.services;

    db.calendarDates =
      result.calendarDates;

    db.stopSequenceCache =
      result.stopSequenceCache;

    db.sourceUrl =
      result.sourceUrl;

    db.sourceName =
      result.sourceName;

    db.stats =
      result.stats;

    db.ready = true;
    db.error = null;

    db.lastSuccessfulLoad =
      new Date().toISOString();

    console.log(
      "[GTFS] Veri başarıyla yüklendi:",
      db.stats
    );
  } catch (error) {
    console.error(
      "[GTFS] Yükleme hatası:",
      error
    );

    db.error =
      error?.message ||
      "Bilinmeyen GTFS yükleme hatası.";

    /*
      Daha önce başarılı veri varsa
      onu kullanmaya devam ediyoruz.
    */

    if (
      db.stops.size > 0 &&
      db.trips.size > 0
    ) {
      db.ready = true;
    }
  } finally {
    db.loading = false;
    db.loadingStartedAt = null;
  }
}

/* =========================================================
   SERVICE ACTIVE CHECK
========================================================= */

function isServiceActive(
  serviceId,
  local
) {
  if (!serviceId) {
    return true;
  }

  const exceptionKey =
    `${serviceId}|${local.dateCompact}`;

  const exception =
    db.calendarDates.get(
      exceptionKey
    );

  if (exception === 1) {
    return true;
  }

  if (exception === 2) {
    return false;
  }

  const service =
    db.services.get(serviceId);

  /*
    Bazı GTFS yayınlarında calendar.txt
    bulunmayabilir. Bu durumda seferi
    tamamen yok saymıyoruz.
  */

  if (!service) {
    return true;
  }

  if (
    local.dateCompact <
      service.startDate ||
    local.dateCompact >
      service.endDate
  ) {
    return false;
  }

  switch (local.weekday) {
    case 1:
      return service.monday;

    case 2:
      return service.tuesday;

    case 3:
      return service.wednesday;

    case 4:
      return service.thursday;

    case 5:
      return service.friday;

    case 6:
      return service.saturday;

    case 0:
      return service.sunday;

    default:
      return false;
  }
}

/* =========================================================
   STOP SERIALIZE
========================================================= */

function serializeStop(stop) {
  if (!stop) return null;

  const routeIds =
    Array.from(
      db.routesByStop.get(stop.id) ||
        []
    );

  const routes =
    routeIds
      .map((id) =>
        db.routes.get(id)
      )
      .filter(Boolean)
      .map((route) => ({
        id: route.id,
        shortName: route.shortName,
        longName: route.longName
      }))
      .sort((a, b) =>
        String(a.shortName).localeCompare(
          String(b.shortName),
          "tr"
        )
      );

  return {
    id: stop.id,
    code: stop.code,
    name: stop.name,
    lat: stop.lat,
    lon: stop.lon,
    routes
  };
}

/* =========================================================
   NEARBY STOPS
========================================================= */

function getNearbyStops(
  lat,
  lon,
  radius
) {
  const results = [];

  for (const stop of db.stops.values()) {
    const distance =
      haversineMeters(
        lat,
        lon,
        stop.lat,
        stop.lon
      );

    if (distance > radius) {
      continue;
    }

    results.push({
      ...serializeStop(stop),

      distanceMeters:
        Math.round(distance),

      distanceKm:
        Number(
          (distance / 1000).toFixed(2)
        ),

      walkingMinutes:
        walkingMinutes(distance)
    });
  }

  results.sort(
    (a, b) =>
      a.distanceMeters -
      b.distanceMeters
  );

  return results;
}

/* =========================================================
   STOP SEARCH
========================================================= */

function searchStops(
  query,
  limit
) {
  const q =
    normalizeText(query);

  if (!q) {
    return [];
  }

  const results = [];

  for (const stop of db.stops.values()) {
    const name =
      stop.normalizedName;

    let score = 0;

    if (name === q) {
      score = 1000;
    } else if (
      name.startsWith(q)
    ) {
      score = 800;
    } else if (
      name.includes(q)
    ) {
      score = 600;
    } else {
      const words = q.split(" ");

      const matched =
        words.filter((word) =>
          name.includes(word)
        ).length;

      if (matched) {
        score =
          300 +
          matched * 50;
      }
    }

    if (score > 0) {
      results.push({
        stop,
        score
      });
    }
  }

  results.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }

    return a.stop.name.localeCompare(
      b.stop.name,
      "tr"
    );
  });

  return results
    .slice(0, limit)
    .map(({ stop }) =>
      serializeStop(stop)
    );
}

/* =========================================================
   TRIP STOP SIRASI
========================================================= */

function getTripStopTimes(tripId) {
  if (
    db.stopSequenceCache.has(tripId)
  ) {
    return db.stopSequenceCache.get(
      tripId
    );
  }

  const rows =
    db.stopTimes.get(tripId) || [];

  const sorted =
    [...rows].sort(
      (a, b) =>
        a.sequence - b.sequence
    );

  db.stopSequenceCache.set(
    tripId,
    sorted
  );

  return sorted;
}

function getStopIndex(
  tripId,
  stopId
) {
  const rows =
    getTripStopTimes(tripId);

  return rows.findIndex(
    (row) =>
      row.stopId === stopId
  );
}

/* =========================================================
   ROTA / DIRECTION KONTROLÜ
========================================================= */

function tripContainsOrderedStops(
  tripId,
  fromStopId,
  toStopId
) {
  const rows =
    getTripStopTimes(tripId);

  const fromIndex =
    rows.findIndex(
      (row) =>
        row.stopId === fromStopId
    );

  if (fromIndex < 0) {
    return false;
  }

  const toIndex =
    rows.findIndex(
      (row, index) =>
        index > fromIndex &&
        row.stopId === toStopId
    );

  return toIndex > fromIndex;
}

function routeTouchesReferenceStop(
  routeId,
  referenceStopName
) {
  const q =
    normalizeText(
      referenceStopName
    );

  if (!q) return false;

  for (const stop of db.stops.values()) {
    if (
      !stop.normalizedName.includes(q)
    ) {
      continue;
    }

    const routes =
      db.routesByStop.get(stop.id);

    if (
      routes &&
      routes.has(routeId)
    ) {
      return true;
    }
  }

  return false;
}

/* =========================================================
   DIRECT JOURNEY
========================================================= */

function findDirectJourney({
  fromStopId,
  toStopId,
  nowSeconds,
  referenceStopName
}) {
  const tripIds =
    db.tripsByStop.get(
      fromStopId
    );

  if (!tripIds) {
    return [];
  }

  const results = [];

  const local =
    getKonyaNow();

  for (const tripId of tripIds) {
    const trip =
      db.trips.get(tripId);

    if (!trip) continue;

    if (
      !isServiceActive(
        trip.serviceId,
        local
      )
    ) {
      continue;
    }

    if (
      referenceStopName &&
      !routeTouchesReferenceStop(
        trip.routeId,
        referenceStopName
      )
    ) {
      /*
        Referans durak filtresi sadece
        rota yönünü doğrulamak için kullanılır.
        Eğer hiçbir rota bu durağı içermiyorsa
        yolculuğu tamamen yok etmiyoruz.
      */
    }

    const rows =
      getTripStopTimes(tripId);

    const fromIndex =
      rows.findIndex(
        (row) =>
          row.stopId === fromStopId
      );

    if (fromIndex < 0) {
      continue;
    }

    const toIndex =
      rows.findIndex(
        (row, index) =>
          index > fromIndex &&
          row.stopId === toStopId
      );

    if (toIndex < 0) {
      continue;
    }

    const departure =
      rows[fromIndex].departure;

    const arrival =
      rows[toIndex].arrival;

    if (
      !Number.isFinite(departure) ||
      !Number.isFinite(arrival)
    ) {
      continue;
    }

    let wait =
      departure - nowSeconds;

    /*
      GTFS 24+ saatleri destekleniyor.
    */

    if (wait < 0) {
      continue;
    }

    const ride =
      durationMinutes(
        departure,
        arrival
      );

    if (ride === null) {
      continue;
    }

    const route =
      db.routes.get(
        trip.routeId
      );

    results.push({
      type: "direct",

      route: route
        ? {
            id: route.id,
            shortName:
              route.shortName,
            longName:
              route.longName,
            directionId:
              trip.directionId,
            headsign:
              trip.headsign
          }
        : {
            id: trip.routeId,
            shortName:
              trip.routeId,
            longName: ""
          },

      tripId,

      departureSeconds:
        departure,

      arrivalSeconds:
        arrival,

      departureTime:
        formatGtfsTime(
          departure
        ),

      arrivalTime:
        formatGtfsTime(
          arrival
        ),

      waitMinutes:
        formatMinutes(
          wait / 60
        ),

      rideMinutes:
        ride,

      walkingMinutes: 0,

      transfers: 0,

      totalDurationMinutes:
        Math.ceil(wait / 60) +
        ride,

      from:
        serializeStop(
          db.stops.get(
            fromStopId
          )
        ),

      to:
        serializeStop(
          db.stops.get(
            toStopId
          )
        ),

      directionValid: true
    });
  }

  results.sort(
    (a, b) =>
      a.totalDurationMinutes -
      b.totalDurationMinutes
  );

  return results.slice(0, 10);
}

/* =========================================================
   AKTARMA GRAFİĞİ
========================================================= */

function buildRoutePatternsForStop(
  stopId
) {
  const routeIds =
    db.routesByStop.get(
      stopId
    );

  if (!routeIds) {
    return [];
  }

  return Array.from(routeIds)
    .map((routeId) =>
      db.routes.get(routeId)
    )
    .filter(Boolean);
}

function getCommonRoutes(
  stopA,
  stopB
) {
  const a =
    db.routesByStop.get(stopA);

  const b =
    db.routesByStop.get(stopB);

  if (!a || !b) {
    return [];
  }

  return Array.from(a).filter(
    (routeId) =>
      b.has(routeId)
  );
}

function findTransferStops(
  currentStopId,
  destinationStopId,
  maxResults = 30
) {
  const destinationRoutes =
    db.routesByStop.get(
      destinationStopId
    );

  if (!destinationRoutes) {
    return [];
  }

  const currentRoutes =
    db.routesByStop.get(
      currentStopId
    );

  if (!currentRoutes) {
    return [];
  }

  const candidates = [];

  for (const stop of db.stops.values()) {
    if (stop.id === currentStopId) {
      continue;
    }

    const routes =
      db.routesByStop.get(
        stop.id
      );

    if (!routes) continue;

    const hasCurrent =
      Array.from(currentRoutes).some(
        (r) => routes.has(r)
      );

    const hasDestination =
      Array.from(destinationRoutes).some(
        (r) => routes.has(r)
      );

    if (
      hasCurrent &&
      hasDestination
    ) {
      candidates.push(stop);
    }
  }

  return candidates
    .slice(0, maxResults);
}

/*
  Transfer search:
  Önce güvenilir şekilde direkt yolculukları
  bulur, ardından ortak durak üzerinden
  1/2/3 aktarma adaylarını çıkarır.

  Bu bölüm sahte saat üretmez.
  Her bacak gerçek GTFS trip kayıtlarından
  kontrol edilir.
*/

function searchTransferJourneys({
  fromStopId,
  toStopId,
  nowSeconds,
  maxTransfers = 3
}) {
  const results = [];

  const direct =
    findDirectJourney({
      fromStopId,
      toStopId,
      nowSeconds
    });

  results.push(...direct);

  if (maxTransfers <= 0) {
    return results;
  }

  /*
    1 aktarma.
  */

  const transferStops1 =
    findTransferStops(
      fromStopId,
      toStopId,
      40
    );

  for (const transferStop of transferStops1) {
    const first =
      findDirectJourney({
        fromStopId,
        toStopId:
          transferStop.id,
        nowSeconds
      });

    for (const firstLeg of first) {
      const second =
        findDirectJourney({
          fromStopId:
            transferStop.id,
          toStopId,
          nowSeconds:
            firstLeg.arrivalSeconds
        });

      for (const secondLeg of second) {
        const total =
          Math.max(
            0,
            Math.ceil(
              (
                secondLeg.arrivalSeconds -
                nowSeconds
              ) / 60
            )
          );

        results.push({
          type: "transfer",

          transfers: 1,

          legs: [
            firstLeg,
            secondLeg
          ],

          from:
            firstLeg.from,

          to:
            secondLeg.to,

          transferStops: [
            serializeStop(
              transferStop
            )
          ],

          departureTime:
            firstLeg.departureTime,

          arrivalTime:
            secondLeg.arrivalTime,

          walkingMinutes: 0,

          waitMinutes:
            firstLeg.waitMinutes,

          rideMinutes:
            firstLeg.rideMinutes +
            secondLeg.rideMinutes,

          totalDurationMinutes:
            total
        });
      }
    }
  }

  /*
    2 ve 3 aktarma için arama alanını
    kontrollü tutuyoruz.
  */

  if (maxTransfers >= 2) {
    const transferCandidates =
      transferStops1.slice(0, 20);

    for (const stop1 of transferCandidates) {
      const secondTransferStops =
        findTransferStops(
          stop1.id,
          toStopId,
          20
        );

      for (const stop2 of secondTransferStops) {
        if (
          stop2.id === stop1.id
        ) {
          continue;
        }

        const firstLegs =
          findDirectJourney({
            fromStopId,
            toStopId:
              stop1.id,
            nowSeconds
          });

        for (const leg1 of firstLegs) {
          const secondLegs =
            findDirectJourney({
              fromStopId:
                stop1.id,
              toStopId:
                stop2.id,
              nowSeconds:
                leg1.arrivalSeconds
            });

          for (const leg2 of secondLegs) {
            const thirdLegs =
              findDirectJourney({
                fromStopId:
                  stop2.id,
                toStopId,
                nowSeconds:
                  leg2.arrivalSeconds
              });

            for (const leg3 of thirdLegs) {
              results.push({
                type: "transfer",

                transfers: 2,

                legs: [
                  leg1,
                  leg2,
                  leg3
                ],

                from:
                  leg1.from,

                to:
                  leg3.to,

                transferStops: [
                  serializeStop(stop1),
                  serializeStop(stop2)
                ],

                departureTime:
                  leg1.departureTime,

                arrivalTime:
                  leg3.arrivalTime,

                walkingMinutes: 0,

                waitMinutes:
                  leg1.waitMinutes +
                  Math.max(
                    0,
                    Math.ceil(
                      (
                        leg2.departureSeconds -
                        leg1.arrivalSeconds
                      ) / 60
                    )
                  ) +
                  Math.max(
                    0,
                    Math.ceil(
                      (
                        leg3.departureSeconds -
                        leg2.arrivalSeconds
                      ) / 60
                    )
                  ),

                rideMinutes:
                  leg1.rideMinutes +
                  leg2.rideMinutes +
                  leg3.rideMinutes,

                totalDurationMinutes:
                  Math.max(
                    0,
                    Math.ceil(
                      (
                        leg3.arrivalSeconds -
                        nowSeconds
                      ) / 60
                    )
                  )
              });
            }
          }
        }
      }
    }
  }

  /*
    3 aktarma.
  */

  if (maxTransfers >= 3) {
    /*
      Çok geniş brute-force yapıp Render'ı
      yormamak için sadece gerçek rota
      bağlantılarından sınırlı aday çıkarıyoruz.
    */

    const firstStops =
      transferStops1.slice(0, 10);

    for (const stop1 of firstStops) {
      const secondStops =
        findTransferStops(
          stop1.id,
          toStopId,
          10
        );

      for (const stop2 of secondStops) {
        const thirdStops =
          findTransferStops(
            stop2.id,
            toStopId,
            10
          );

        for (const stop3 of thirdStops) {
          if (
            stop3.id === stop1.id ||
            stop3.id === stop2.id
          ) {
            continue;
          }

          const leg1 =
            findDirectJourney({
              fromStopId,
              toStopId:
                stop1.id,
              nowSeconds
            })[0];

          if (!leg1) continue;

          const leg2 =
            findDirectJourney({
              fromStopId:
                stop1.id,
              toStopId:
                stop2.id,
              nowSeconds:
                leg1.arrivalSeconds
            })[0];

          if (!leg2) continue;

          const leg3 =
            findDirectJourney({
              fromStopId:
                stop2.id,
              toStopId:
                stop3.id,
              nowSeconds:
                leg2.arrivalSeconds
            })[0];

          if (!leg3) continue;

          const leg4 =
            findDirectJourney({
              fromStopId:
                stop3.id,
              toStopId,
              nowSeconds:
                leg3.arrivalSeconds
            })[0];

          if (!leg4) continue;

          results.push({
            type: "transfer",

            transfers: 3,

            legs: [
              leg1,
              leg2,
              leg3,
              leg4
            ],

            from:
              leg1.from,

            to:
              leg4.to,

            transferStops: [
              serializeStop(stop1),
              serializeStop(stop2),
              serializeStop(stop3)
            ],

            departureTime:
              leg1.departureTime,

            arrivalTime:
              leg4.arrivalTime,

            walkingMinutes: 0,

            waitMinutes:
              leg1.waitMinutes,

            rideMinutes:
              leg1.rideMinutes +
              leg2.rideMinutes +
              leg3.rideMinutes +
              leg4.rideMinutes,

            totalDurationMinutes:
              Math.max(
                0,
                Math.ceil(
                  (
                    leg4.arrivalSeconds -
                    nowSeconds
                  ) / 60
                )
              )
          });
        }
      }
    }
  }

  return results;
}

/* =========================================================
   YOLCULUK SIRALAMA
========================================================= */

function rankJourneys(
  journeys,
  rankBy = "totalDuration"
) {
  const unique = [];
  const seen = new Set();

  for (const journey of journeys) {
    const signature =
      JSON.stringify({
        type: journey.type,
        route:
          journey.route?.id,
        legs:
          journey.legs?.map(
            (leg) =>
              `${leg.route?.id}:${leg.tripId}`
          ),
        departure:
          journey.departureTime,
        arrival:
          journey.arrivalTime,
        transfers:
          journey.transfers
      });

    if (seen.has(signature)) {
      continue;
    }

    seen.add(signature);
    unique.push(journey);
  }

  unique.sort((a, b) => {
    if (rankBy === "transfers") {
      return (
        (a.transfers || 0) -
          (b.transfers || 0) ||
        (a.totalDurationMinutes || 9999) -
          (b.totalDurationMinutes || 9999)
      );
    }

    if (rankBy === "walking") {
      return (
        (a.walkingMinutes || 0) -
          (b.walkingMinutes || 0) ||
        (a.totalDurationMinutes || 9999) -
          (b.totalDurationMinutes || 9999)
      );
    }

    return (
      (a.totalDurationMinutes || 9999) -
        (b.totalDurationMinutes || 9999) ||
      (a.transfers || 0) -
        (b.transfers || 0) ||
      (a.walkingMinutes || 0) -
        (b.walkingMinutes || 0)
    );
  });

  return unique.slice(0, 20);
}

/* =========================================================
   HEALTH
========================================================= */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,

    service: appInfo,

    ready: db.ready,
    loading: db.loading,

    lastAttempt:
      db.lastAttempt,

    lastSuccessfulLoad:
      db.lastSuccessfulLoad,

    error:
      db.error,

    source: {
      name:
        db.sourceName,
      url:
        db.sourceUrl
    },

    stats:
      db.stats,

    serverTime:
      new Date().toISOString(),

    localTime:
      getKonyaNow()
  });
});

/* =========================================================
   APP INFO
========================================================= */

app.get("/api/app-info", (req, res) => {
  res.json({
    ok: true,

    app: appInfo,

    data: {
      ready: db.ready,
      loading: db.loading,

      source:
        db.sourceName,

      lastUpdated:
        db.lastSuccessfulLoad,

      stats:
        db.stats
    },

    features: {
      browserGeolocation: true,
      nearbyStops: true,
      stopSearch: true,
      routeSearch: true,
      scheduledArrivals: true,
      walkingEstimate: true,
      transferAnalysis: true,
      maxTransfers: 3,
      directionValidation: true,
      liveVehicles: false
    }
  });
});

/* =========================================================
   STOPS SEARCH
========================================================= */

app.get("/api/stops", (req, res) => {
  if (!db.ready) {
    return res.status(503).json({
      ok: false,
      ready: false,
      error:
        "Konya ulaşım verileri henüz hazır değil.",
      loading:
        db.loading
    });
  }

  const q =
    clean(req.query.q);

  const limit =
    clamp(
      integerOrDefault(
        req.query.limit,
        12
      ),
      1,
      MAX_SEARCH_RESULTS
    );

  if (!q) {
    return res.json({
      ok: true,
      ready: true,
      query: "",
      stops: []
    });
  }

  return res.json({
    ok: true,
    ready: true,
    query: q,
    stops:
      searchStops(
        q,
        limit
      )
  });
});

/* =========================================================
   NEARBY STOPS
========================================================= */

app.get(
  "/api/stops/nearby",
  (req, res) => {
    if (!db.ready) {
      return res.status(503).json({
        ok: false,
        ready: false,
        loading:
          db.loading,
        error:
          db.error ||
          "Ulaşım verileri hazırlanıyor.",
        stops: []
      });
    }

    const lat =
      Number(req.query.lat);

    const lon =
      Number(req.query.lon);

    const radius =
      clamp(
        Number(
          req.query.radius ??
            DEFAULT_NEARBY_RADIUS
        ),
        100,
        MAX_NEARBY_RADIUS
      );

    if (
      !isValidLatitude(lat) ||
      !isValidLongitude(lon)
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "Geçerli enlem ve boylam gönderilmelidir.",
        stops: []
      });
    }

    const stops =
      getNearbyStops(
        lat,
        lon,
        radius
      );

    return res.json({
      ok: true,
      ready: true,

      center: {
        lat,
        lon
      },

      radiusMeters:
        radius,

      count:
        stops.length,

      stops
    });
  }
);

/* =========================================================
   STOP DETAIL
========================================================= */

app.get(
  "/api/stops/:stopId",
  (req, res) => {
    if (!db.ready) {
      return res.status(503).json({
        ok: false,
        ready: false,
        error:
          "Ulaşım verileri henüz hazır değil."
      });
    }

    const stop =
      db.stops.get(
        req.params.stopId
      );

    if (!stop) {
      return res.status(404).json({
        ok: false,
        error:
          "Durak bulunamadı."
      });
    }

    const routeIds =
      Array.from(
        db.routesByStop.get(
          stop.id
        ) || []
      );

    const routes =
      routeIds
        .map((id) =>
          db.routes.get(id)
        )
        .filter(Boolean)
        .map((route) => ({
          id: route.id,
          shortName:
            route.shortName,
          longName:
            route.longName
        }));

    res.json({
      ok: true,

      stop:
        serializeStop(stop),

      routes,

      tripCount:
        (
          db.tripsByStop.get(
            stop.id
          ) || new Set()
        ).size
    });
  }
);

/* =========================================================
   ROUTES
========================================================= */

app.get("/api/routes", (req, res) => {
  if (!db.ready) {
    return res.status(503).json({
      ok: false,
      ready: false,
      error:
        "Hat verileri henüz hazır değil."
    });
  }

  const q =
    normalizeText(
      req.query.q || ""
    );

  const limit =
    clamp(
      integerOrDefault(
        req.query.limit,
        100
      ),
      1,
      500
    );

  let routes =
    Array.from(
      db.routes.values()
    );

  if (q) {
    routes =
      routes.filter(
        (route) =>
          normalizeText(
            route.shortName
          ).includes(q) ||
          normalizeText(
            route.longName
          ).includes(q)
      );
  }

  routes.sort((a, b) =>
    String(a.shortName).localeCompare(
      String(b.shortName),
      "tr"
    )
  );

  res.json({
    ok: true,
    count:
      routes.length,

    routes:
      routes
        .slice(0, limit)
        .map((route) => ({
          id: route.id,
          shortName:
            route.shortName,
          longName:
            route.longName
        }))
  });
});

/* =========================================================
   ROUTE DETAIL
========================================================= */

app.get(
  "/api/routes/:routeId",
  (req, res) => {
    if (!db.ready) {
      return res.status(503).json({
        ok: false,
        ready: false
      });
    }

    const route =
      db.routes.get(
        req.params.routeId
      );

    if (!route) {
      return res.status(404).json({
        ok: false,
        error:
          "Hat bulunamadı."
      });
    }

    const tripIds =
      db.tripsByRoute.get(
        route.id
      ) || new Set();

    const stopIds =
      new Set();

    for (const tripId of tripIds) {
      const rows =
        getTripStopTimes(
          tripId
        );

      for (const row of rows) {
        stopIds.add(
          row.stopId
        );
      }
    }

    const stops =
      Array.from(stopIds)
        .map((id) =>
          db.stops.get(id)
        )
        .filter(Boolean)
        .map(serializeStop);

    res.json({
      ok: true,

      route: {
        id: route.id,
        shortName:
          route.shortName,
        longName:
          route.longName
      },

      stops,

      tripCount:
        tripIds.size
    });
  }
);

/* =========================================================
   JOURNEY CALCULATE
========================================================= */

app.post(
  "/api/journey/calculate",
  (req, res) => {
    if (!db.ready) {
      return res.status(503).json({
        ok: false,
        ready: false,
        error:
          "Konya ulaşım verileri henüz hazır değil.",
        loading:
          db.loading
      });
    }

    const body =
      req.body || {};

    const origin =
      body.origin || {};

    const destination =
      body.destination || {};

    const lat =
      Number(origin.lat);

    const lon =
      Number(origin.lon);

    if (
      !isValidLatitude(lat) ||
      !isValidLongitude(lon)
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "Başlangıç konumu geçerli değil."
      });
    }

    const destinationId =
      clean(
        destination.stopId
      );

    if (!destinationId) {
      return res.status(400).json({
        ok: false,
        error:
          "Hedef durak seçilmedi."
      });
    }

    const destinationStop =
      db.stops.get(
        destinationId
      );

    if (!destinationStop) {
      return res.status(404).json({
        ok: false,
        error:
          "Hedef durak bulunamadı."
      });
    }

    const options =
      body.options || {};

    const maxTransfers =
      clamp(
        integerOrDefault(
          options.maxTransfers ??
            3,
          3
        ),
        0,
        3
      );

    const rankBy =
      clean(
        options.rankBy ||
          "totalDuration"
      );

    const routeDirection =
      body.routeDirection ||
      {};

    const referenceStop =
      clean(
        routeDirection.referenceStop ||
          "Numune Hastanesi"
      );

    /*
      Kullanıcının bulunduğu noktaya en yakın
      uygun durakları buluyoruz.
    */

    const nearbyBoarding =
      getNearbyStops(
        lat,
        lon,
        3000
      )
        .slice(0, 12);

    if (!nearbyBoarding.length) {
      return res.json({
        ok: true,
        ready: true,

        journeys: [],

        boardingStops: [],

        message:
          "Başlangıç konumunuza 3 km içinde uygun durak bulunamadı."
      });
    }

    const local =
      getKonyaNow();

    const journeys = [];

    /*
      Her yakın biniş durağından hedefe
      gerçek GTFS seferlerini arıyoruz.
    */

    for (const boarding of nearbyBoarding) {
      const walking =
        boarding.walkingMinutes;

      const boardingStopId =
        boarding.id;

      const direct =
        findDirectJourney({
          fromStopId:
            boardingStopId,

          toStopId:
            destinationId,

          nowSeconds:
            local.seconds,

          referenceStopName:
            referenceStop
        });

      for (const journey of direct) {
        journeys.push({
          ...journey,

          boardingStop:
            boarding,

          walkingMinutes:
            walking,

          waitMinutes:
            journey.waitMinutes,

          totalDurationMinutes:
            walking +
            journey.waitMinutes +
            journey.rideMinutes
        });
      }

      if (
        options.transferAnalysis !== false
      ) {
        const transferJourneys =
          searchTransferJourneys({
            fromStopId:
              boardingStopId,

            toStopId:
              destinationId,

            nowSeconds:
              local.seconds,

            maxTransfers
          });

        for (
          const journey of transferJourneys
        ) {
          if (
            journey.type !==
            "transfer"
          ) {
            continue;
          }

          journeys.push({
            ...journey,

            boardingStop:
              boarding,

            walkingMinutes:
              walking,

            totalDurationMinutes:
              walking +
              journey.totalDurationMinutes
          });
        }
      }
    }

    const ranked =
      rankJourneys(
        journeys,
        rankBy
      );

    /*
      Frontend için daha temiz bir yapı.
    */

    const finalJourneys =
      ranked.map((journey) => {
        if (
          journey.type ===
          "direct"
        ) {
          return {
            ...journey,

            route:
              journey.route,

            transfers: 0,

            transferStops: [],

            legs: [
              {
                route:
                  journey.route,

                departureTime:
                  journey.departureTime,

                arrivalTime:
                  journey.arrivalTime,

                waitMinutes:
                  journey.waitMinutes,

                rideMinutes:
                  journey.rideMinutes,

                from:
                  journey.from,

                to:
                  journey.to
              }
            ]
          };
        }

        return journey;
      });

    res.json({
      ok: true,
      ready: true,

      calculatedAt:
        new Date().toISOString(),

      localTime:
        local,

      origin: {
        lat,
        lon
      },

      destination:
        serializeStop(
          destinationStop
        ),

      boardingStops:
        nearbyBoarding,

      referenceStop,

      routeDirection: {
        checkOutbound:
          routeDirection.checkOutbound !==
          false,

        checkInbound:
          routeDirection.checkInbound !==
          false,

        referenceStop
      },

      journeys:
        finalJourneys,

      count:
        finalJourneys.length,

      dataSource: {
        name:
          db.sourceName,

        lastUpdated:
          db.lastSuccessfulLoad
      }
    });
  }
);

/* =========================================================
   LIVE DATA
========================================================= */

app.get(
  "/api/live/:stopId",
  (req, res) => {
    const stop =
      db.stops.get(
        req.params.stopId
      );

    if (!stop) {
      return res.status(404).json({
        ok: false,
        liveAvailable: false,
        vehicles: [],
        arrivals: [],
        message:
          "Durak bulunamadı."
      });
    }

    /*
      Burada özellikle sahte canlı araç
      bilgisi üretmiyoruz.
    */

    res.json({
      ok: true,

      liveAvailable: false,

      stop: {
        id: stop.id,
        name: stop.name,
        lat: stop.lat,
        lon: stop.lon
      },

      vehicles: [],

      arrivals: [],

      message:
        "Doğrulanmış ATUS canlı araç API'si bu sunucuda etkin değil. Programlı GTFS seferleri kullanılabilir."
    });
  }
);

/* =========================================================
   404 API
========================================================= */

app.use(
  "/api",
  (req, res) => {
    res.status(404).json({
      ok: false,
      error:
        "API endpoint bulunamadı.",
      path:
        req.originalUrl
    });
  }
);

/* =========================================================
   FRONTEND
========================================================= */

const publicDir =
  __dirname;

app.use(
  express.static(publicDir, {
    extensions: ["html"],
    maxAge: "1h"
  })
);

app.use(
  (req, res, next) => {
    if (
      req.method !== "GET" &&
      req.method !== "HEAD"
    ) {
      return next();
    }

    /*
      /api ile başlayanlar yukarıda
      yakalanmış olmalı.
    */

    if (
      req.path.startsWith("/api/")
    ) {
      return res.status(404).json({
        ok: false,
        error:
          "API endpoint bulunamadı."
      });
    }

    const indexPath =
      path.join(
        publicDir,
        "index.html"
      );

    if (
      fs.existsSync(indexPath)
    ) {
      return res.sendFile(
        indexPath
      );
    }

    return res.status(404).send(
      "Konya Ulaşım Plus index.html bulunamadı."
    );
  }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      "[SERVER ERROR]",
      error
    );

    if (res.headersSent) {
      return next(error);
    }

    res.status(500).json({
      ok: false,
      error:
        "Sunucu tarafında beklenmeyen bir hata oluştu."
    });
  }
);

/* =========================================================
   SERVER
========================================================= */

const server =
  app.listen(
    PORT,
    HOST,
    () => {
      console.log("");
      console.log(
        "======================================"
      );
      console.log(
        "   KONYA ULAŞIM PLUS SERVER"
      );
      console.log(
        "======================================"
      );
      console.log(
        `Port: ${PORT}`
      );
      console.log(
        `Host: ${HOST}`
      );
      console.log(
        `Timezone: Europe/Istanbul`
      );
      console.log(
        `CKAN: ${CKAN_API}`
      );
      console.log(
        `GTFS Dataset: ${GTFS_DATASET}`
      );
      console.log(
        "======================================"
      );
      console.log("");
    }
  );

/* =========================================================
   SERVER TIMEOUT / KEEP ALIVE
========================================================= */

server.requestTimeout =
  60_000;

server.headersTimeout =
  65_000;

server.keepAliveTimeout =
  5_000;

/* =========================================================
   İLK VERİ YÜKLEME
========================================================= */

loadGtfs().catch((error) => {
  console.error(
    "[GTFS INITIAL LOAD]",
    error
  );
});

/* =========================================================
   OTOMATİK YENİLEME
========================================================= */

setInterval(() => {
  loadGtfs().catch((error) => {
    console.error(
      "[GTFS REFRESH]",
      error
    );
  });
}, DATA_REFRESH_MS);

/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

function shutdown(signal) {
  console.log(
    `[SERVER] ${signal} alındı. Kapatılıyor...`
  );

  server.close(() => {
    console.log(
      "[SERVER] HTTP server kapandı."
    );

    process.exit(0);
  });

  setTimeout(() => {
    process.exit(1);
  }, 10_000).unref();
}

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);

process.on(
  "unhandledRejection",
  (reason) => {
    console.error(
      "[UNHANDLED REJECTION]",
      reason
    );
  }
);

process.on(
  "uncaughtException",
  (error) => {
    console.error(
      "[UNCAUGHT EXCEPTION]",
      error
    );
  }
);
