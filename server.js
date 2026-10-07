import express from "express";
import cors from "cors";
import AdmZip from "adm-zip";

const app = express();

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";

const CKAN_BASE =
  process.env.CKAN_BASE ||
  "https://acikveri.konya.bel.tr";

const DATASET_ID =
  process.env.DATASET_ID ||
  "toplu-tasima-gtfs-verileri";

const REFRESH_MS =
  Number(process.env.REFRESH_MS || 6 * 60 * 60 * 1000);

const FETCH_TIMEOUT =
  Number(process.env.FETCH_TIMEOUT || 90000);

const WALK_SPEED_M_PER_MIN = 80;

const appStartedAt = new Date().toISOString();

const db = {
  ready: false,
  loading: false,
  error: null,

  source: {
    name: "Konya Büyükşehir Belediyesi Açık Veri",
    url: `${CKAN_BASE}/dataset/${DATASET_ID}`,
    type: "GTFS"
  },

  loadedAt: null,
  updatedAt: null,

  stops: new Map(),
  routes: new Map(),
  trips: new Map(),
  stopTimes: [],
  tripsByStop: new Map(),
  routesByStop: new Map(),
  tripsByRoute: new Map(),

  services: new Map(),
  calendarDates: new Map(),

  stats: {
    stops: 0,
    routes: 0,
    trips: 0,
    stopTimes: 0
  }
};

/* =========================================================
   BASIC HELPERS
========================================================= */

function clean(value) {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .trim();
}

function normalize(value) {
  return clean(value)
    .toLocaleLowerCase("tr-TR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c");
}

function number(value) {
  const n = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;

  const a1 = Number(lat1) * Math.PI / 180;
  const a2 = Number(lat2) * Math.PI / 180;

  const da =
    (Number(lat2) - Number(lat1)) *
    Math.PI / 180;

  const dl =
    (Number(lon2) - Number(lon1)) *
    Math.PI / 180;

  const a =
    Math.sin(da / 2) ** 2 +
    Math.cos(a1) *
    Math.cos(a2) *
    Math.sin(dl / 2) ** 2;

  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function walkingMinutes(distanceMeters) {
  return Math.max(
    1,
    Math.ceil(distanceMeters / WALK_SPEED_M_PER_MIN)
  );
}

function formatDistance(meters) {
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }

  return `${(meters / 1000).toFixed(1)} km`;
}

function formatDuration(minutes) {
  const m = Math.max(0, Math.round(minutes));

  if (m < 60) {
    return `${m} dk`;
  }

  const h = Math.floor(m / 60);
  const r = m % 60;

  return r
    ? `${h} sa ${r} dk`
    : `${h} sa`;
}

function parseGtfsTime(value) {
  const s = clean(value);

  if (!s) return null;

  const parts = s.split(":").map(Number);

  if (parts.length !== 3 || parts.some(x => !Number.isFinite(x))) {
    return null;
  }

  const [h, m, sec] = parts;

  return h * 3600 + m * 60 + sec;
}

function formatClock(seconds) {
  if (seconds == null) return "--:--";

  const daySeconds = 24 * 3600;
  let s = ((seconds % daySeconds) + daySeconds) % daySeconds;

  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);

  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function getIstanbulDate() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const map = {};

  for (const p of parts) {
    if (p.type !== "literal") {
      map[p.type] = p.value;
    }
  }

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    yyyymmdd:
      `${map.year}${map.month}${map.day}`
  };
}

function getIstanbulSeconds() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Istanbul",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());

  const map = {};

  for (const p of parts) {
    if (p.type !== "literal") {
      map[p.type] = p.value;
    }
  }

  return (
    Number(map.hour) * 3600 +
    Number(map.minute) * 60 +
    Number(map.second)
  );
}

/* =========================================================
   CSV PARSER
========================================================= */

function parseCSV(text) {
  const rows = [];

  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }

      continue;
    }

    if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      field = "";

      if (row.some(x => clean(x) !== "")) {
        rows.push(row);
      }

      row = [];
    } else if (c !== "\r") {
      field += c;
    }
  }

  row.push(field);

  if (row.some(x => clean(x) !== "")) {
    rows.push(row);
  }

  if (!rows.length) return [];

  const headers = rows[0].map(clean);

  return rows.slice(1).map(values => {
    const obj = {};

    for (let i = 0; i < headers.length; i++) {
      obj[headers[i]] = clean(values[i] ?? "");
    }

    return obj;
  });
}

/* =========================================================
   FETCH
========================================================= */

async function fetchBuffer(url, options = {}) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    FETCH_TIMEOUT
  );

  try {
    const response = await fetch(url, {
      ...options,
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Konya-Ulasim-Plus/5.1 (+https://acikveri.konya.bel.tr)",
        "Accept":
          "application/zip,application/octet-stream,application/json,text/plain,*/*",
        ...options.headers
      }
    });

    const buffer = Buffer.from(
      await response.arrayBuffer()
    );

    if (!response.ok) {
      const preview = buffer
        .toString("utf8")
        .slice(0, 500)
        .replace(/\s+/g, " ");

      throw new Error(
        `HTTP ${response.status} ${response.statusText}` +
        (preview ? ` | ${preview}` : "")
      );
    }

    return {
      buffer,
      response
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJSON(url) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    FETCH_TIMEOUT
  );

  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Konya-Ulasim-Plus/5.1",
        "Accept":
          "application/json,text/json,*/*"
      }
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} ${response.statusText} | ${text.slice(0, 500)}`
      );
    }

    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

/* =========================================================
   CKAN DISCOVERY
========================================================= */

function resourceLooksLikeGtfs(resource) {
  if (!resource) return false;

  const url = clean(
    resource.url ||
    resource.download_url ||
    resource.href
  );

  const name = clean(
    resource.name ||
    resource.title ||
    ""
  );

  const format = clean(
    resource.format ||
    ""
  ).toLocaleLowerCase("tr-TR");

  const combined =
    `${url} ${name} ${format}`.toLocaleLowerCase();

  return (
    format === "zip" ||
    format === "gtfs" ||
    /\.zip(?:$|\?)/i.test(url) ||
    combined.includes("gtfs")
  );
}

function resourceUrl(resource) {
  return clean(
    resource.url ||
    resource.download_url ||
    resource.href ||
    ""
  );
}

async function discoverFromCkan() {
  const candidates = [];

  const urls = [
    `${CKAN_BASE}/api/3/action/package_show?id=${encodeURIComponent(DATASET_ID)}`,
    `${CKAN_BASE}/api/3/action/package_show?id=${encodeURIComponent(DATASET_ID)}&include_resources=true`,
    `${CKAN_BASE}/api/action/package_show?id=${encodeURIComponent(DATASET_ID)}`
  ];

  let lastError = null;

  for (const url of urls) {
    try {
      console.log("CKAN deneniyor:", url);

      const json = await fetchJSON(url);

      if (json?.success === false) {
        throw new Error(
          json?.error?.message ||
          "CKAN API başarısız cevap döndürdü."
        );
      }

      const result = json?.result;

      if (!result) {
        throw new Error(
          "CKAN cevabında result bulunamadı."
        );
      }

      const resources = Array.isArray(result.resources)
        ? result.resources
        : [];

      for (const resource of resources) {
        if (resourceLooksLikeGtfs(resource)) {
          const u = resourceUrl(resource);

          if (u) {
            candidates.push({
              url: u,
              name: resource.name || resource.title || "GTFS",
              format: resource.format || "ZIP"
            });
          }
        }
      }

      if (candidates.length) {
        return candidates;
      }

      throw new Error(
        "CKAN veri setinde uygun GTFS ZIP kaynağı bulunamadı."
      );
    } catch (error) {
      lastError = error;

      console.warn(
        "CKAN erişim denemesi başarısız:",
        error.message
      );
    }
  }

  throw new Error(
    `CKAN kaynak keşfi başarısız: ${lastError?.message || "Bilinmeyen hata"}`
  );
}

/* =========================================================
   OFFICIAL PAGE FALLBACK
========================================================= */

async function discoverFromOfficialPage() {
  const pageUrls = [
    `${CKAN_BASE}/dataset/groups/${DATASET_ID}`,
    `${CKAN_BASE}/dataset/${DATASET_ID}`,
    `${CKAN_BASE}/tr/dataset/${DATASET_ID}`,
    `${CKAN_BASE}/en/dataset/${DATASET_ID}`
  ];

  let lastError = null;

  for (const pageUrl of pageUrls) {
    try {
      console.log("Resmî veri sayfası deneniyor:", pageUrl);

      const response = await fetch(pageUrl, {
        redirect: "follow",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; Konya-Ulasim-Plus/5.1)",
          "Accept":
            "text/html,application/xhtml+xml,*/*"
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT)
      });

      const html = await response.text();

      if (!response.ok) {
        throw new Error(
          `HTTP ${response.status} ${response.statusText}`
        );
      }

      const urls = [];

      const absoluteRegex =
        /https?:\/\/[^"'<>\\\s]+/gi;

      const relativeRegex =
        /(?:href|src)\s*=\s*["']([^"']+)["']/gi;

      for (const match of html.matchAll(absoluteRegex)) {
        urls.push(match[0]);
      }

      for (const match of html.matchAll(relativeRegex)) {
        try {
          urls.push(
            new URL(match[1], pageUrl).href
          );
        } catch {
          // ignore
        }
      }

      const zipUrls = urls
        .map(u => u.replace(/&amp;/g, "&"))
        .filter(u => /\.zip(?:$|\?)/i.test(u))
        .filter(u =>
          /gtfs|toplu|tasima|ulasim/i.test(u)
        );

      if (zipUrls.length) {
        return [...new Set(zipUrls)].map(url => ({
          url,
          name: "Konya Resmî GTFS ZIP",
          format: "ZIP"
        }));
      }

      lastError = new Error(
        "Resmî veri sayfasında ZIP bağlantısı bulunamadı."
      );
    } catch (error) {
      lastError = error;

      console.warn(
        "Resmî sayfa erişim hatası:",
        error.message
      );
    }
  }

  throw lastError ||
    new Error("GTFS resmî sayfa kaynağı bulunamadı.");
}

/* =========================================================
   ZIP SOURCE
========================================================= */

async function downloadGtfsZip() {
  let candidates = [];

  /*
   * Önce CKAN.
   * 403 olsa bile uygulama burada bitmez.
   */
  try {
    candidates = await discoverFromCkan();

    console.log(
      `CKAN üzerinden ${candidates.length} GTFS kaynağı bulundu.`
    );
  } catch (error) {
    console.warn(
      "CKAN kaynak keşfi başarısız:",
      error.message
    );
  }

  /*
   * Sonra resmî veri sayfası.
   */
  if (!candidates.length) {
    try {
      candidates = await discoverFromOfficialPage();

      console.log(
        `Resmî sayfadan ${candidates.length} GTFS kaynağı bulundu.`
      );
    } catch (error) {
      console.warn(
        "Resmî sayfa GTFS keşfi başarısız:",
        error.message
      );
    }
  }

  if (!candidates.length) {
    throw new Error(
      "Konya resmî GTFS ZIP kaynağı bulunamadı. " +
      "CKAN API erişimi başarısız oldu ve resmî veri sayfasından ZIP bağlantısı alınamadı."
    );
  }

  let lastError = null;

  for (const candidate of candidates) {
    try {
      console.log(
        "GTFS ZIP indiriliyor:",
        candidate.url
      );

      const result = await fetchBuffer(candidate.url);

      if (!result.buffer.length) {
        throw new Error(
          "GTFS ZIP boş döndü."
        );
      }

      console.log(
        `GTFS indirildi: ${(result.buffer.length / 1024 / 1024).toFixed(2)} MB`
      );

      return {
        buffer: result.buffer,
        url: candidate.url,
        name: candidate.name,
        format: candidate.format
      };
    } catch (error) {
      lastError = error;

      console.warn(
        "GTFS ZIP indirme hatası:",
        candidate.url,
        error.message
      );
    }
  }

  throw new Error(
    `Bulunan GTFS kaynaklarının hiçbiri indirilemedi: ${lastError?.message || "Bilinmeyen hata"}`
  );
}

/* =========================================================
   ZIP FILE HELPERS
========================================================= */

function findZipEntry(zip, filename) {
  const wanted = filename.toLocaleLowerCase("tr-TR");

  const entries = zip.getEntries();

  return entries.find(entry => {
    const name = entry.entryName
      .replaceAll("\\", "/")
      .split("/")
      .pop()
      .toLocaleLowerCase("tr-TR");

    return name === wanted;
  });
}

function readZipText(zip, filename, required = true) {
  const entry = findZipEntry(zip, filename);

  if (!entry) {
    if (required) {
      throw new Error(
        `GTFS içinde zorunlu dosya bulunamadı: ${filename}`
      );
    }

    return null;
  }

  return entry.getData().toString("utf8");
}

/* =========================================================
   GTFS BUILD
========================================================= */

function addToMapArray(map, key, value) {
  if (!map.has(key)) {
    map.set(key, []);
  }

  map.get(key).push(value);
}

function buildDatabase(zipBuffer, sourceUrl) {
  const zip = new AdmZip(zipBuffer);

  const stopsText =
    readZipText(zip, "stops.txt", true);

  const routesText =
    readZipText(zip, "routes.txt", true);

  const tripsText =
    readZipText(zip, "trips.txt", true);

  const stopTimesText =
    readZipText(zip, "stop_times.txt", true);

  const calendarText =
    readZipText(zip, "calendar.txt", false);

  const calendarDatesText =
    readZipText(zip, "calendar_dates.txt", false);

  const stopsRows = parseCSV(stopsText);
  const routesRows = parseCSV(routesText);
  const tripsRows = parseCSV(tripsText);
  const stopTimesRows = parseCSV(stopTimesText);

  const calendarRows =
    calendarText
      ? parseCSV(calendarText)
      : [];

  const calendarDatesRows =
    calendarDatesText
      ? parseCSV(calendarDatesText)
      : [];

  const next = {
    stops: new Map(),
    routes: new Map(),
    trips: new Map(),
    stopTimes: [],
    tripsByStop: new Map(),
    routesByStop: new Map(),
    tripsByRoute: new Map(),
    services: new Map(),
    calendarDates: new Map()
  };

  /* ---------------- STOPS ---------------- */

  for (const row of stopsRows) {
    const id = clean(row.stop_id);

    if (!id) continue;

    const lat = number(row.stop_lat);
    const lon = number(row.stop_lon);

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon)
    ) {
      continue;
    }

    const stop = {
      id,
      name:
        clean(row.stop_name) ||
        id,

      code:
        clean(row.stop_code),

      lat,
      lon,

      parentStation:
        clean(row.parent_station),

      locationType:
        clean(row.location_type),

      wheelchairBoarding:
        clean(row.wheelchair_boarding)
    };

    stop.searchText = normalize(
      `${stop.name} ${stop.code}`
    );

    next.stops.set(id, stop);
  }

  /* ---------------- ROUTES ---------------- */

  for (const row of routesRows) {
    const id = clean(row.route_id);

    if (!id) continue;

    const route = {
      id,

      shortName:
        clean(row.route_short_name) || id,

      longName:
        clean(row.route_long_name),

      type:
        clean(row.route_type),

      color:
        clean(row.route_color),

      textColor:
        clean(row.route_text_color)
    };

    route.searchText = normalize(
      `${route.shortName} ${route.longName}`
    );

    next.routes.set(id, route);
  }

  /* ---------------- TRIPS ---------------- */

  for (const row of tripsRows) {
    const id = clean(row.trip_id);

    if (!id) continue;

    const trip = {
      id,

      routeId:
        clean(row.route_id),

      serviceId:
        clean(row.service_id),

      headsign:
        clean(row.trip_headsign),

      directionId:
        clean(row.direction_id),

      shapeId:
        clean(row.shape_id)
    };

    next.trips.set(id, trip);

    addToMapArray(
      next.tripsByRoute,
      trip.routeId,
      trip
    );
  }

  /* ---------------- CALENDAR ---------------- */

  for (const row of calendarRows) {
    const serviceId =
      clean(row.service_id);

    if (!serviceId) continue;

    next.services.set(
      serviceId,
      {
        serviceId,

        monday: clean(row.monday) === "1",
        tuesday: clean(row.tuesday) === "1",
        wednesday: clean(row.wednesday) === "1",
        thursday: clean(row.thursday) === "1",
        friday: clean(row.friday) === "1",
        saturday: clean(row.saturday) === "1",
        sunday: clean(row.sunday) === "1",

        startDate:
          clean(row.start_date),

        endDate:
          clean(row.end_date)
      }
    );
  }

  /* ---------------- CALENDAR DATES ---------------- */

  for (const row of calendarDatesRows) {
    const serviceId =
      clean(row.service_id);

    const date =
      clean(row.date);

    const exceptionType =
      clean(row.exception_type);

    if (!serviceId || !date) continue;

    addToMapArray(
      next.calendarDates,
      serviceId,
      {
        date,
        exceptionType
      }
    );
  }

  /* ---------------- STOP TIMES ---------------- */

  for (const row of stopTimesRows) {
    const tripId =
      clean(row.trip_id);

    const stopId =
      clean(row.stop_id);

    if (!tripId || !stopId) continue;

    if (!next.trips.has(tripId)) continue;
    if (!next.stops.has(stopId)) continue;

    const arrival =
      parseGtfsTime(row.arrival_time);

    const departure =
      parseGtfsTime(row.departure_time);

    const sequence =
      Number(row.stop_sequence);

    if (
      arrival == null &&
      departure == null
    ) {
      continue;
    }

    const stopTime = {
      tripId,
      stopId,

      arrivalTime:
        arrival ?? departure,

      departureTime:
        departure ?? arrival,

      stopSequence:
        Number.isFinite(sequence)
          ? sequence
          : 0
    };

    next.stopTimes.push(stopTime);

    addToMapArray(
      next.tripsByStop,
      stopId,
      stopTime
    );
  }

  /* ---------------- ROUTES BY STOP ---------------- */

  for (const [
    stopId,
    stopTimes
  ] of next.tripsByStop.entries()) {

    const routeIds = new Set();

    for (const st of stopTimes) {
      const trip =
        next.trips.get(st.tripId);

      if (trip?.routeId) {
        routeIds.add(trip.routeId);
      }
    }

    next.routesByStop.set(
      stopId,
      [...routeIds]
    );
  }

  /* ---------------- BASIC VALIDATION ---------------- */

  if (!next.stops.size) {
    throw new Error(
      "GTFS yüklendi ancak stops.txt içinde geçerli durak bulunamadı."
    );
  }

  if (!next.routes.size) {
    throw new Error(
      "GTFS yüklendi ancak routes.txt içinde hat bulunamadı."
    );
  }

  if (!next.trips.size) {
    throw new Error(
      "GTFS yüklendi ancak trips.txt içinde sefer bulunamadı."
    );
  }

  if (!next.stopTimes.length) {
    throw new Error(
      "GTFS yüklendi ancak stop_times.txt içinde sefer-durak bilgisi bulunamadı."
    );
  }

  return {
    ...next,

    source: {
      url: sourceUrl
    }
  };
}

/* =========================================================
   ATOMIC LOAD
========================================================= */

async function refreshGtfs() {
  if (db.loading) {
    return;
  }

  db.loading = true;
  db.error = null;

  console.log(
    "=========================================="
  );

  console.log(
    "Konya GTFS yükleme başlıyor..."
  );

  try {
    const gtfs =
      await downloadGtfsZip();

    const built =
      buildDatabase(
        gtfs.buffer,
        gtfs.url
      );

    /*
     * Atomic swap.
     * Veri hazır olana kadar eski veri korunur.
     */
    db.stops = built.stops;
    db.routes = built.routes;
    db.trips = built.trips;
    db.stopTimes = built.stopTimes;
    db.tripsByStop = built.tripsByStop;
    db.routesByStop = built.routesByStop;
    db.tripsByRoute = built.tripsByRoute;
    db.services = built.services;
    db.calendarDates = built.calendarDates;

    db.stats = {
      stops: db.stops.size,
      routes: db.routes.size,
      trips: db.trips.size,
      stopTimes: db.stopTimes.length
    };

    db.source = {
      name:
        "Konya Büyükşehir Belediyesi Açık Veri",
      url: gtfs.url,
      type: "GTFS"
    };

    db.loadedAt =
      new Date().toISOString();

    db.updatedAt =
      db.loadedAt;

    db.ready = true;
    db.error = null;

    console.log(
      "GTFS başarıyla yüklendi."
    );

    console.log(
      "Durak:",
      db.stats.stops
    );

    console.log(
      "Hat:",
      db.stats.routes
    );

    console.log(
      "Sefer:",
      db.stats.trips
    );

    console.log(
      "StopTime:",
      db.stats.stopTimes
    );

    console.log(
      "Kaynak:",
      gtfs.url
    );

    console.log(
      "=========================================="
    );
  } catch (error) {
    db.error =
      error?.message ||
      String(error);

    /*
     * İlk yüklemede başarısızsa ready false.
     * Daha önce veri varsa eski veri kullanılmaya devam eder.
     */
    if (!db.stats.stops) {
      db.ready = false;
    }

    console.error(
      "GTFS yükleme hatası:",
      db.error
    );

    console.log(
      "=========================================="
    );
  } finally {
    db.loading = false;
  }
}

/* =========================================================
   SERVICE CHECK
========================================================= */

function serviceRunsToday(serviceId) {
  const service =
    db.services.get(serviceId);

  const today =
    getIstanbulDate();

  const date =
    today.yyyymmdd;

  const exceptions =
    db.calendarDates.get(serviceId) ||
    [];

  let exception = null;

  for (const item of exceptions) {
    if (item.date === date) {
      exception = item;
    }
  }

  if (exception) {
    if (exception.exceptionType === "1") {
      return true;
    }

    if (exception.exceptionType === "2") {
      return false;
    }
  }

  if (!service) {
    /*
     * Bazı GTFS beslemelerinde calendar
     * bulunmayabilir. Bu durumda trip'i
     * tamamen yok saymak yerine kullanılır
     * kabul ediyoruz.
     */
    return true;
  }

  if (
    service.startDate &&
    date < service.startDate
  ) {
    return false;
  }

  if (
    service.endDate &&
    date > service.endDate
  ) {
    return false;
  }

  const weekday =
    new Date(
      Date.UTC(
        today.year,
        today.month - 1,
        today.day
      )
    ).getUTCDay();

  const flags = [
    service.sunday,
    service.monday,
    service.tuesday,
    service.wednesday,
    service.thursday,
    service.friday,
    service.saturday
  ];

  return Boolean(flags[weekday]);
}

/* =========================================================
   STOPS
========================================================= */

function serializeStop(stop) {
  return {
    id: stop.id,
    name: stop.name,
    code: stop.code,
    lat: stop.lat,
    lon: stop.lon,
    parentStation: stop.parentStation
  };
}

function getNearbyStops(lat, lon, radius = 3000) {
  const results = [];

  for (const stop of db.stops.values()) {
    const distance =
      haversine(
        lat,
        lon,
        stop.lat,
        stop.lon
      );

    if (distance <= radius) {
      results.push({
        ...serializeStop(stop),

        distanceMeters:
          Math.round(distance),

        distanceText:
          formatDistance(distance),

        walkingMinutes:
          walkingMinutes(distance),

        walkingText:
          `${walkingMinutes(distance)} dk yürüyüş`
      });
    }
  }

  results.sort(
    (a, b) =>
      a.distanceMeters -
      b.distanceMeters
  );

  return results;
}

function searchStops(query, limit = 20) {
  const q = normalize(query);

  if (!q) {
    return [];
  }

  const results = [];

  for (const stop of db.stops.values()) {
    if (
      stop.searchText.includes(q)
    ) {
      results.push(
        serializeStop(stop)
      );
    }
  }

  return results
    .slice(0, Math.max(1, Math.min(100, limit)));
}

/* =========================================================
   ROUTES
========================================================= */

function serializeRoute(route) {
  return {
    id: route.id,
    shortName: route.shortName,
    longName: route.longName,
    type: route.type,
    color: route.color,
    textColor: route.textColor
  };
}

/* =========================================================
   JOURNEY
========================================================= */

function getStopTimesForTrip(tripId) {
  const list = [];

  for (const st of db.stopTimes) {
    if (st.tripId === tripId) {
      list.push(st);
    }
  }

  list.sort(
    (a, b) =>
      a.stopSequence -
      b.stopSequence
  );

  return list;
}

function getUpcomingDepartures(stopId, limit = 20) {
  const now =
    getIstanbulSeconds();

  const stopTimes =
    db.tripsByStop.get(stopId) ||
    [];

  const results = [];

  for (const st of stopTimes) {
    const trip =
      db.trips.get(st.tripId);

    if (!trip) continue;

    if (
      !serviceRunsToday(
        trip.serviceId
      )
    ) {
      continue;
    }

    const departure =
      st.departureTime;

    if (departure == null) continue;

    let delta =
      departure - now;

    /*
     * GTFS saatleri 24:00 üzerini destekleyebilir.
     */
    if (delta < 0) {
      continue;
    }

    const route =
      db.routes.get(
        trip.routeId
      );

    results.push({
      tripId: trip.id,

      route:
        route
          ? serializeRoute(route)
          : {
              id: trip.routeId,
              shortName: trip.routeId,
              longName: ""
            },

      headsign:
        trip.headsign,

      directionId:
        trip.directionId,

      departureSeconds:
        departure,

      departureTime:
        formatClock(departure),

      waitMinutes:
        Math.ceil(delta / 60)
    });
  }

  results.sort(
    (a, b) =>
      a.departureSeconds -
      b.departureSeconds
  );

  return results.slice(0, limit);
}

function calculateDirectJourneys(
  origin,
  destinationStop
) {
  const destinationId =
    destinationStop.id;

  const destinationStopTimes =
    db.tripsByStop.get(
      destinationId
    ) || [];

  const now =
    getIstanbulSeconds();

  const nearbyOriginStops =
    getNearbyStops(
      origin.lat,
      origin.lon,
      2500
    );

  const candidates = [];

  for (const originStop of nearbyOriginStops.slice(0, 25)) {
    const originTimes =
      db.tripsByStop.get(
        originStop.id
      ) || [];

    const originMap =
      new Map();

    for (const st of originTimes) {
      originMap.set(
        st.tripId,
        st
      );
    }

    for (const destinationTime of destinationStopTimes) {
      const originTime =
        originMap.get(
          destinationTime.tripId
        );

      if (!originTime) continue;

      if (
        destinationTime.stopSequence <=
        originTime.stopSequence
      ) {
        continue;
      }

      const trip =
        db.trips.get(
          destinationTime.tripId
        );

      if (!trip) continue;

      if (
        !serviceRunsToday(
          trip.serviceId
        )
      ) {
        continue;
      }

      const departure =
        originTime.departureTime;

      const arrival =
        destinationTime.arrivalTime;

      if (
        departure == null ||
        arrival == null
      ) {
        continue;
      }

      if (departure < now) {
        continue;
      }

      const route =
        db.routes.get(
          trip.routeId
        );

      const wait =
        Math.max(
          0,
          Math.ceil(
            (departure - now) / 60
          )
        );

      const ride =
        Math.max(
          0,
          Math.ceil(
            (arrival - departure) / 60
          )
        );

      const walk =
        originStop.walkingMinutes;

      const total =
        walk +
        wait +
        ride;

      candidates.push({
        type: "direct",

        route:
          route
            ? serializeRoute(route)
            : {
                id: trip.routeId,
                shortName: trip.routeId,
                longName: ""
              },

        tripId:
          trip.id,

        headsign:
          trip.headsign,

        directionId:
          trip.directionId,

        boardingStop:
          serializeStop(
            db.stops.get(
              originStop.id
            )
          ),

        destinationStop:
          serializeStop(
            destinationStop
          ),

        walkingDistanceMeters:
          originStop.distanceMeters,

        walkingTimeMinutes:
          walk,

        waitingTimeMinutes:
          wait,

        rideTimeMinutes:
          ride,

        totalTimeMinutes:
          total,

        departureTime:
          formatClock(departure),

        arrivalTime:
          formatClock(arrival),

        liveAvailable:
          false,

        liveNote:
          "Canlı araç konumu API üzerinden doğrulanamadığı için bu süre tarifeye göre hesaplanmıştır."
      });
    }
  }

  candidates.sort(
    (a, b) =>
      a.totalTimeMinutes -
      b.totalTimeMinutes
  );

  return candidates.slice(0, 20);
}

/* =========================================================
   MIDDLEWARE
========================================================= */

app.disable("x-powered-by");

app.use(
  cors({
    origin: true,
    credentials: false
  })
);

app.use(
  express.json({
    limit: "1mb"
  })
);

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      ok: db.ready,

      ready: db.ready,

      loading:
        db.loading,

      error:
        db.error,

      startedAt:
        appStartedAt,

      loadedAt:
        db.loadedAt,

      updatedAt:
        db.updatedAt,

      source:
        db.source,

      stats:
        db.stats
    });
  }
);

app.get(
  "/api/app-info",
  (req, res) => {
    res.json({
      name: "Konya Ulaşım Plus",
      version: "5.1.0",

      city: "Konya",

      dataSource:
        "Konya Büyükşehir Belediyesi Açık Veri",

      gtfs:
        true,

      liveVehicleData:
        false,

      api:
        true,

      status:
        db.ready
          ? "ready"
          : db.loading
            ? "loading"
            : "error",

      error:
        db.error,

      stats:
        db.stats,

      updatedAt:
        db.updatedAt
    });
  }
);

/* =========================================================
   STOPS API
========================================================= */

app.get(
  "/api/stops",
  (req, res) => {
    if (!db.ready) {
      return res.status(503).json({
        ok: false,
        error:
          db.error ||
          "Ulaşım verileri henüz hazır değil.",
        loading:
          db.loading
      });
    }

    const q =
      clean(req.query.q);

    const limit =
      Number(req.query.limit || 20);

    if (q) {
      return res.json({
        ok: true,
        results:
          searchStops(
            q,
            limit
          )
      });
    }

    return res.json({
      ok: true,

      results:
        [...db.stops.values()]
          .slice(
            0,
            Math.min(
              100,
              Math.max(
                1,
                limit
              )
            )
          )
          .map(serializeStop)
    });
  }
);

app.get(
  "/api/stops/nearby",
  (req, res) => {
    if (!db.ready) {
      return res.status(503).json({
        ok: false,
        error:
          db.error ||
          "Ulaşım verileri henüz hazır değil."
      });
    }

    const lat =
      number(req.query.lat);

    const lon =
      number(
        req.query.lon ??
        req.query.lng
      );

    const radius =
      number(
        req.query.radius
      ) ?? 3000;

    if (
      lat == null ||
      lon == null
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "Geçerli konum bilgisi gerekli."
      });
    }

    return res.json({
      ok: true,

      center: {
        lat,
        lon
      },

      radius,

      results:
        getNearbyStops(
          lat,
          lon,
          Math.min(
            10000,
            Math.max(
              100,
              radius
            )
          )
        ).slice(0, 50)
    });
  }
);

app.get(
  "/api/stops/:stopId",
  (req, res) => {
    if (!db.ready) {
      return res.status(503).json({
        ok: false,
        error:
          db.error ||
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

    const routes =
      (
        db.routesByStop.get(
          stop.id
        ) || []
      )
        .map(id =>
          db.routes.get(id)
        )
        .filter(Boolean)
        .map(serializeRoute);

    const departures =
      getUpcomingDepartures(
        stop.id,
        30
      );

    res.json({
      ok: true,

      stop:
        serializeStop(stop),

      routes,

      departures
    });
  }
);

/* =========================================================
   ROUTES API
========================================================= */

app.get(
  "/api/routes",
  (req, res) => {
    if (!db.ready) {
      return res.status(503).json({
        ok: false,
        error:
          db.error ||
          "Ulaşım verileri henüz hazır değil."
      });
    }

    const q =
      normalize(
        req.query.q || ""
      );

    let routes =
      [...db.routes.values()];

    if (q) {
      routes =
        routes.filter(route =>
          route.searchText.includes(q)
        );
    }

    routes =
      routes
        .slice(0, 100)
        .map(serializeRoute);

    res.json({
      ok: true,
      results: routes
    });
  }
);

app.get(
  "/api/routes/:routeId",
  (req, res) => {
    if (!db.ready) {
      return res.status(503).json({
        ok: false,
        error:
          db.error ||
          "Ulaşım verileri henüz hazır değil."
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

    const trips =
      db.tripsByRoute.get(
        route.id
      ) || [];

    const stopIds =
      new Set();

    for (const trip of trips) {
      const stopTimes =
        getStopTimesForTrip(
          trip.id
        );

      for (const st of stopTimes) {
        stopIds.add(
          st.stopId
        );
      }
    }

    const stops =
      [...stopIds]
        .map(id =>
          db.stops.get(id)
        )
        .filter(Boolean)
        .map(serializeStop);

    res.json({
      ok: true,

      route:
        serializeRoute(route),

      tripCount:
        trips.length,

      stops
    });
  }
);

/* =========================================================
   JOURNEY API
========================================================= */

app.post(
  "/api/journey/calculate",
  (req, res) => {
    if (!db.ready) {
      return res.status(503).json({
        ok: false,

        error:
          db.error ||
          "Ulaşım verileri henüz hazır değil.",

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
      number(origin.lat);

    const lon =
      number(
        origin.lon ??
        origin.lng
      );

    if (
      lat == null ||
      lon == null
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "Başlangıç konumu geçerli değil."
      });
    }

    let destinationStop = null;

    if (
      destination.stopId
    ) {
      destinationStop =
        db.stops.get(
          String(
            destination.stopId
          )
        );
    }

    if (
      !destinationStop &&
      destination.name
    ) {
      const q =
        normalize(
          destination.name
        );

      destinationStop =
        [...db.stops.values()]
          .find(stop =>
            stop.searchText === q
          ) ||
        [...db.stops.values()]
          .find(stop =>
            stop.searchText.includes(q)
          );
    }

    if (!destinationStop) {
      return res.status(404).json({
        ok: false,
        error:
          "Hedef durak bulunamadı."
      });
    }

    const routes =
      calculateDirectJourneys(
        {
          lat,
          lon
        },
        destinationStop
      );

    res.json({
      ok: true,

      request: {
        origin: {
          lat,
          lon
        },

        destination:
          serializeStop(
            destinationStop
          )
      },

      liveAvailable:
        false,

      liveNote:
        "Canlı araç verisi doğrulanabilir bir resmî API üzerinden alınamadığı için sonuçlar GTFS tarifesine göre hesaplanmıştır.",

      results:
        routes,

      transferSearch:
        false,

      transferNote:
        "Bu sürüm doğrudan hatları güvenilir şekilde hesaplar; doğrulanmamış aktarma üretmez."
    });
  }
);

/* =========================================================
   LIVE API
========================================================= */

app.get(
  "/api/live/:stopId",
  (req, res) => {
    if (!db.ready) {
      return res.status(503).json({
        ok: false,

        available: false,

        error:
          db.error ||
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
        available: false,
        error:
          "Durak bulunamadı."
      });
    }

    res.json({
      ok: true,

      available: false,

      stop:
        serializeStop(stop),

      message:
        "Canlı araç konum/varış API'si doğrulanamadığı için canlı veri gösterilmiyor.",

      scheduled:
        getUpcomingDepartures(
          stop.id,
          20
        )
    });
  }
);

/* =========================================================
   DEBUG / DATA STATUS
========================================================= */

app.get(
  "/api/data-status",
  (req, res) => {
    res.json({
      ok: db.ready,

      loading:
        db.loading,

      error:
        db.error,

      source:
        db.source,

      loadedAt:
        db.loadedAt,

      stats:
        db.stats
    });
  }
);

/* =========================================================
   STATIC FILES
========================================================= */

app.use(
  express.static(
    process.cwd(),
    {
      extensions: ["html"],
      index: "index.html"
    }
  )
);

/* =========================================================
   SPA FALLBACK
========================================================= */

app.use(
  (req, res, next) => {
    if (
      req.path.startsWith("/api/")
    ) {
      return next();
    }

    res.sendFile(
      `${process.cwd()}/index.html`
    );
  }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (err, req, res, next) => {
    console.error(
      "Sunucu hatası:",
      err
    );

    res.status(500).json({
      ok: false,

      error:
        err?.message ||
        "Sunucu hatası."
    });
  }
);

/* =========================================================
   STARTUP
========================================================= */

const server =
  app.listen(
    PORT,
    HOST,
    () => {
      console.log("");
      console.log(
        "=========================================="
      );

      console.log(
        "🚌 KONYA ULAŞIM PLUS"
      );

      console.log(
        "=========================================="
      );

      console.log(
        `Server: http://${HOST}:${PORT}`
      );

      console.log(
        `CKAN: ${CKAN_BASE}`
      );

      console.log(
        `Dataset: ${DATASET_ID}`
      );

      console.log(
        "GTFS: hazırlanıyor..."
      );

      console.log(
        "=========================================="
      );

      refreshGtfs();
    }
  );

/* =========================================================
   REFRESH
========================================================= */

const refreshTimer =
  setInterval(
    () => {
      refreshGtfs();
    },
    REFRESH_MS
  );

/* =========================================================
   GRACEFUL SHUTDOWN
========================================================= */

async function shutdown(signal) {
  console.log(
    `${signal} alındı. Sunucu kapatılıyor...`
  );

  clearInterval(
    refreshTimer
  );

  await new Promise(resolve => {
    server.close(
      resolve
    );
  });

  process.exit(0);
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
  "uncaughtException",
  error => {
    console.error(
      "uncaughtException:",
      error
    );
  }
);

process.on(
  "unhandledRejection",
  error => {
    console.error(
      "unhandledRejection:",
      error
    );
  }
);
