import express from "express";
import cors from "cors";
import AdmZip from "adm-zip";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const app = express();

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";

const OFFICIAL_DATASET_PAGE =
  "https://acikveri.konya.bel.tr/dataset/groups/toplu-tasima-gtfs-verileri";

const MANUAL_GTFS_URL =
  process.env.GTFS_URL ||
  "https://acikveri.konya.bel.tr/dataset/c2e034e6-e015-49c6-8eec-6e2f7de9c105/resource/ec944ecd-1c1f-4687-a7f6-fcf2dc5bb5db/download/gtfs_11_2025.zip";

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const state = {
  loading: false,
  ready: false,
  error: null,
  lastUpdate: null,
  source: null,
  connection: {
    ok: false,
    statusCode: null,
    contentType: null,
    bytes: 0,
    url: null,
    error: null
  },
  stats: {
    stops: 0,
    routes: 0,
    trips: 0,
    stopTimes: 0,
    shapes: 0,
    calendars: 0
  }
};

const db = {
  stops: new Map(),
  routes: new Map(),
  trips: new Map(),
  stopTimesByTrip: new Map(),
  tripsByRoute: new Map(),
  stopRoutes: new Map(),
  calendars: new Map(),
  calendarDates: new Map()
};

/* -------------------------------------------------------
   GENEL YARDIMCILAR
------------------------------------------------------- */

function clean(v) {
  return String(v ?? "")
    .replace(/^\uFEFF/, "")
    .trim();
}

function csvParse(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  if (!rows.length) return [];

  const headers = rows[0].map(clean);

  return rows.slice(1)
    .filter(r => r.some(x => clean(x) !== ""))
    .map(r => {
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = clean(r[i] ?? "");
      });
      return obj;
    });
}

function getFile(zip, names) {
  const entries = zip.getEntries();

  for (const wanted of names) {
    const found = entries.find(e => {
      const n = e.entryName.replaceAll("\\", "/").split("/").pop();
      return n.toLowerCase() === wanted.toLowerCase();
    });

    if (found) {
      return found.getData().toString("utf8");
    }
  }

  return null;
}

function parseTime(value) {
  if (!value) return null;

  const p = value.split(":").map(Number);

  if (p.length !== 3 || p.some(Number.isNaN)) return null;

  let [h, m, s] = p;

  // GTFS gece saatlerinde 24:00+ kullanılabilir.
  h = Math.min(h, 47);

  return h * 3600 + m * 60 + s;
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const a1 = lat1 * Math.PI / 180;
  const a2 = lat2 * Math.PI / 180;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a1) *
      Math.cos(a2) *
      Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.asin(Math.sqrt(a));
}

function walkingMinutes(meters) {
  return Math.max(1, Math.round(meters / 80));
}

function nowSeconds() {
  const d = new Date();

  return (
    d.getHours() * 3600 +
    d.getMinutes() * 60 +
    d.getSeconds()
  );
}

/* -------------------------------------------------------
   RESMÎ GTFS KAYNAĞINI BUL
------------------------------------------------------- */

async function fetchBuffer(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);

  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; Konya-Ulasim-Plus/5.0)",
        "Accept":
          "application/zip,application/octet-stream,text/html,*/*"
      }
    });

    const arrayBuffer = await response.arrayBuffer();

    return {
      response,
      buffer: Buffer.from(arrayBuffer)
    };
  } finally {
    clearTimeout(timer);
  }
}

function isZip(buffer) {
  if (!buffer || buffer.length < 4) return false;

  return (
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    (
      buffer[2] === 0x03 ||
      buffer[2] === 0x05 ||
      buffer[2] === 0x07
    )
  );
}

async function findOfficialGtfsUrl() {
  // Önce bilinen resmî resource URL'sini dene.
  try {
    const result = await fetchBuffer(MANUAL_GTFS_URL);

    if (
      result.response.ok &&
      isZip(result.buffer)
    ) {
      return {
        url: MANUAL_GTFS_URL,
        buffer: result.buffer,
        statusCode: result.response.status,
        contentType:
          result.response.headers.get("content-type") || ""
      };
    }
  } catch (_) {
    // Aşağıda resmî veri sayfasından yeniden bulmayı deniyoruz.
  }

  // Resmî GTFS veri seti sayfasını aç.
  const page = await fetchBuffer(OFFICIAL_DATASET_PAGE);

  if (!page.response.ok) {
    throw new Error(
      `Resmî veri sayfası HTTP ${page.response.status}`
    );
  }

  const html = page.buffer.toString("utf8");

  const candidates = [];

  // href="..."
  const hrefRegex =
    /href\s*=\s*["']([^"']+)["']/gi;

  let match;

  while ((match = hrefRegex.exec(html)) !== null) {
    let href = match[1];

    if (
      /(\.zip|\/download\/|resource\/)/i.test(href)
    ) {
      try {
        const absolute = new URL(
          href,
          OFFICIAL_DATASET_PAGE
        ).href;

        candidates.push(absolute);
      } catch (_) {}
    }
  }

  const unique = [...new Set(candidates)];

  for (const url of unique) {
    try {
      const result = await fetchBuffer(url);

      if (
        result.response.ok &&
        isZip(result.buffer)
      ) {
        return {
          url,
          buffer: result.buffer,
          statusCode: result.response.status,
          contentType:
            result.response.headers.get("content-type") || ""
        };
      }
    } catch (_) {}
  }

  throw new Error(
    "Konya Büyükşehir Belediyesi resmî GTFS ZIP dosyasına ulaşılamadı."
  );
}

/* -------------------------------------------------------
   GTFS YÜKLE
------------------------------------------------------- */

async function loadGtfs() {
  if (state.loading) return;

  state.loading = true;
  state.ready = false;
  state.error = null;

  try {
    console.log("======================================");
    console.log("KONYA ULAŞIM PLUS - GTFS YÜKLENİYOR");
    console.log("Resmî kaynak:", OFFICIAL_DATASET_PAGE);
    console.log("======================================");

    const result = await findOfficialGtfsUrl();

    state.connection = {
      ok: true,
      statusCode: result.statusCode,
      contentType: result.contentType,
      bytes: result.buffer.length,
      url: result.url,
      error: null
    };

    console.log("GTFS bağlantısı başarılı.");
    console.log("Kaynak:", result.url);
    console.log(
      "Boyut:",
      Math.round(result.buffer.length / 1024),
      "KB"
    );

    const zip = new AdmZip(result.buffer);

    const stopsText = getFile(zip, ["stops.txt"]);
    const routesText = getFile(zip, ["routes.txt"]);
    const tripsText = getFile(zip, ["trips.txt"]);
    const stopTimesText = getFile(zip, ["stop_times.txt"]);
    const calendarText = getFile(zip, ["calendar.txt"]);
    const calendarDatesText =
      getFile(zip, ["calendar_dates.txt"]);

    if (!stopsText) {
      throw new Error("GTFS içinde stops.txt bulunamadı.");
    }

    if (!routesText) {
      throw new Error("GTFS içinde routes.txt bulunamadı.");
    }

    if (!tripsText) {
      throw new Error("GTFS içinde trips.txt bulunamadı.");
    }

    if (!stopTimesText) {
      throw new Error(
        "GTFS içinde stop_times.txt bulunamadı."
      );
    }

    // Eski verileri temizle.
    db.stops.clear();
    db.routes.clear();
    db.trips.clear();
    db.stopTimesByTrip.clear();
    db.tripsByRoute.clear();
    db.stopRoutes.clear();
    db.calendars.clear();
    db.calendarDates.clear();

    /* STOPS */

    for (const s of csvParse(stopsText)) {
      if (!s.stop_id) continue;

      const stop = {
        id: s.stop_id,
        name: s.stop_name || s.stop_id,
        lat: Number(s.stop_lat),
        lon: Number(s.stop_lon),
        code: s.stop_code || null
      };

      if (
        Number.isFinite(stop.lat) &&
        Number.isFinite(stop.lon)
      ) {
        db.stops.set(stop.id, stop);
      }
    }

    /* ROUTES */

    for (const r of csvParse(routesText)) {
      if (!r.route_id) continue;

      db.routes.set(r.route_id, {
        id: r.route_id,
        shortName:
          r.route_short_name ||
          r.route_long_name ||
          r.route_id,
        longName: r.route_long_name || "",
        type: r.route_type || "",
        color: r.route_color || null
      });
    }

    /* TRIPS */

    for (const t of csvParse(tripsText)) {
      if (!t.trip_id) continue;

      const trip = {
        id: t.trip_id,
        routeId: t.route_id,
        serviceId: t.service_id,
        headsign: t.trip_headsign || ""
      };

      db.trips.set(trip.id, trip);

      if (!db.tripsByRoute.has(trip.routeId)) {
        db.tripsByRoute.set(trip.routeId, []);
      }

      db.tripsByRoute.get(trip.routeId).push(trip);
    }

    /* CALENDAR */

    if (calendarText) {
      for (const c of csvParse(calendarText)) {
        if (c.service_id) {
          db.calendars.set(c.service_id, c);
        }
      }
    }

    /* CALENDAR DATES */

    if (calendarDatesText) {
      for (const c of csvParse(calendarDatesText)) {
        if (!c.service_id || !c.date) continue;

        const key = `${c.service_id}:${c.date}`;

        db.calendarDates.set(key, {
          serviceId: c.service_id,
          date: c.date,
          exceptionType: c.exception_type
        });
      }
    }

    /* STOP TIMES */

    let stopTimeCount = 0;

    for (const st of csvParse(stopTimesText)) {
      if (!st.trip_id || !st.stop_id) continue;

      const item = {
        tripId: st.trip_id,
        stopId: st.stop_id,
        stopSequence:
          Number(st.stop_sequence) || 0,
        arrivalTime: parseTime(st.arrival_time),
        departureTime: parseTime(st.departure_time)
      };

      if (!db.stopTimesByTrip.has(item.tripId)) {
        db.stopTimesByTrip.set(item.tripId, []);
      }

      db.stopTimesByTrip
        .get(item.tripId)
        .push(item);

      if (!db.stopRoutes.has(item.stopId)) {
        db.stopRoutes.set(item.stopId, new Set());
      }

      const trip = db.trips.get(item.tripId);

      if (trip) {
        db.stopRoutes
          .get(item.stopId)
          .add(trip.routeId);
      }

      stopTimeCount++;
    }

    // Sıralama
    for (const list of db.stopTimesByTrip.values()) {
      list.sort(
        (a, b) =>
          a.stopSequence - b.stopSequence
      );
    }

    state.stats = {
      stops: db.stops.size,
      routes: db.routes.size,
      trips: db.trips.size,
      stopTimes: stopTimeCount,
      shapes: 0,
      calendars: db.calendars.size
    };

    state.source = {
      name:
        "Konya Büyükşehir Belediyesi Açık Veri Platformu",
      dataset:
        "Toplu Taşıma GTFS Verileri",
      url: result.url,
      officialPage: OFFICIAL_DATASET_PAGE
    };

    state.lastUpdate = new Date().toISOString();
    state.ready = true;

    console.log("--------------------------------------");
    console.log("GTFS HAZIR");
    console.log("Durak:", db.stops.size);
    console.log("Hat:", db.routes.size);
    console.log("Sefer:", db.trips.size);
    console.log("StopTime:", stopTimeCount);
    console.log("--------------------------------------");
  } catch (error) {
    state.ready = false;
    state.error = error?.message || String(error);

    state.connection = {
      ...state.connection,
      ok: false,
      error: state.error
    };

    console.error("GTFS HATASI:", state.error);
  } finally {
    state.loading = false;
  }
}

/* -------------------------------------------------------
   API
------------------------------------------------------- */

app.get("/api/health", (req, res) => {
  res.json({
    ok: state.ready,
    ready: state.ready,
    loading: state.loading,
    error: state.error,

    connection: state.connection,

    source: state.source,

    lastUpdate: state.lastUpdate,

    stats: state.stats,

    serverTime: new Date().toISOString()
  });
});

app.get("/api/app-info", (req, res) => {
  res.json({
    name: "Konya Ulaşım Plus",
    version: "5.0.0",
    city: "Konya",
    dataType: "GTFS",
    official: true,
    source:
      "Konya Büyükşehir Belediyesi Açık Veri Platformu",
    officialPage: OFFICIAL_DATASET_PAGE,
    liveVehicleApi: false
  });
});

app.get("/api/data-status", (req, res) => {
  res.json({
    ready: state.ready,
    loading: state.loading,
    error: state.error,
    source: state.source,
    connection: state.connection,
    stats: state.stats,
    lastUpdate: state.lastUpdate
  });
});

/* DURAKLAR */

app.get("/api/stops", (req, res) => {
  if (!state.ready) {
    return res.status(503).json({
      ok: false,
      error:
        state.error ||
        "GTFS verisi henüz hazır değil."
    });
  }

  const q = clean(req.query.q || "").toLocaleLowerCase("tr-TR");
  const limit = Math.min(
    Number(req.query.limit) || 100,
    500
  );

  let result = [...db.stops.values()];

  if (q) {
    result = result.filter(s =>
      `${s.name} ${s.code || ""}`
        .toLocaleLowerCase("tr-TR")
        .includes(q)
    );
  }

  result = result.slice(0, limit);

  res.json({
    ok: true,
    count: result.length,
    stops: result
  });
});

/* YAKIN DURAKLAR */

app.get("/api/stops/nearby", (req, res) => {
  if (!state.ready) {
    return res.status(503).json({
      ok: false,
      error:
        state.error ||
        "GTFS verisi henüz hazır değil."
    });
  }

  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const radius = Math.min(
    Number(req.query.radius) || 2000,
    10000
  );

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon)
  ) {
    return res.status(400).json({
      ok: false,
      error: "Geçerli konum gönderilmedi."
    });
  }

  const result = [];

  for (const stop of db.stops.values()) {
    const distance = distanceMeters(
      lat,
      lon,
      stop.lat,
      stop.lon
    );

    if (distance <= radius) {
      result.push({
        ...stop,
        distance: Math.round(distance),
        walkingMinutes:
          walkingMinutes(distance)
      });
    }
  }

  result.sort(
    (a, b) => a.distance - b.distance
  );

  res.json({
    ok: true,
    count: result.length,
    stops: result.slice(0, 100)
  });
});

/* TEK DURAK */

app.get("/api/stops/:stopId", (req, res) => {
  if (!state.ready) {
    return res.status(503).json({
      ok: false,
      error:
        state.error ||
        "GTFS verisi henüz hazır değil."
    });
  }

  const stop = db.stops.get(req.params.stopId);

  if (!stop) {
    return res.status(404).json({
      ok: false,
      error: "Durak bulunamadı."
    });
  }

  const routeIds = [
    ...(db.stopRoutes.get(stop.id) || [])
  ];

  const routes = routeIds
    .map(id => db.routes.get(id))
    .filter(Boolean);

  res.json({
    ok: true,
    stop,
    routes
  });
});

/* HATLAR */

app.get("/api/routes", (req, res) => {
  if (!state.ready) {
    return res.status(503).json({
      ok: false,
      error:
        state.error ||
        "GTFS verisi henüz hazır değil."
    });
  }

  const q = clean(req.query.q || "").toLocaleLowerCase("tr-TR");

  let routes = [...db.routes.values()];

  if (q) {
    routes = routes.filter(r =>
      `${r.shortName} ${r.longName}`
        .toLocaleLowerCase("tr-TR")
        .includes(q)
    );
  }

  res.json({
    ok: true,
    count: routes.length,
    routes
  });
});

/* TEK HAT */

app.get("/api/routes/:routeId", (req, res) => {
  if (!state.ready) {
    return res.status(503).json({
      ok: false,
      error:
        state.error ||
        "GTFS verisi henüz hazır değil."
    });
  }

  const route = db.routes.get(
    req.params.routeId
  );

  if (!route) {
    return res.status(404).json({
      ok: false,
      error: "Hat bulunamadı."
    });
  }

  const trips =
    db.tripsByRoute.get(route.id) || [];

  res.json({
    ok: true,
    route,
    trips: trips.map(t => ({
      id: t.id,
      headsign: t.headsign,
      serviceId: t.serviceId
    }))
  });
});

/* -------------------------------------------------------
   SEFER HESAPLA
------------------------------------------------------- */

function getNextDeparture(tripId, stopId, afterSeconds) {
  const times =
    db.stopTimesByTrip.get(tripId) || [];

  const item = times.find(
    x =>
      x.stopId === stopId &&
      x.departureTime != null &&
      x.departureTime >= afterSeconds
  );

  return item || null;
}

function findDirectJourneys(fromStopId, toStopId) {
  const fromRoutes =
    db.stopRoutes.get(fromStopId) || new Set();

  const toRoutes =
    db.stopRoutes.get(toStopId) || new Set();

  const commonRoutes = [
    ...fromRoutes
  ].filter(r => toRoutes.has(r));

  const results = [];

  for (const routeId of commonRoutes) {
    const trips =
      db.tripsByRoute.get(routeId) || [];

    for (const trip of trips) {
      const times =
        db.stopTimesByTrip.get(trip.id) || [];

      const from = times.find(
        x => x.stopId === fromStopId
      );

      const to = times.find(
        x => x.stopId === toStopId
      );

      if (
        !from ||
        !to ||
        from.stopSequence >= to.stopSequence
      ) {
        continue;
      }

      const departure =
        from.departureTime ??
        from.arrivalTime;

      const arrival =
        to.arrivalTime ??
        to.departureTime;

      if (
        departure == null ||
        arrival == null
      ) {
        continue;
      }

      results.push({
        routeId,
        tripId: trip.id,
        route: db.routes.get(routeId),
        headsign: trip.headsign,
        departure,
        arrival,
        rideMinutes: Math.max(
          0,
          Math.round(
            (arrival - departure) / 60
          )
        )
      });
    }
  }

  return results;
}

app.get("/api/journey/calculate", (req, res) => {
  if (!state.ready) {
    return res.status(503).json({
      ok: false,
      error:
        state.error ||
        "GTFS verisi henüz hazır değil."
    });
  }

  const from = clean(req.query.from);
  const to = clean(req.query.to);

  if (!from || !to) {
    return res.status(400).json({
      ok: false,
      error:
        "Başlangıç ve hedef durak gerekli."
    });
  }

  if (!db.stops.has(from)) {
    return res.status(404).json({
      ok: false,
      error:
        "Başlangıç durağı GTFS verisinde bulunamadı."
    });
  }

  if (!db.stops.has(to)) {
    return res.status(404).json({
      ok: false,
      error:
        "Hedef durağı GTFS verisinde bulunamadı."
    });
  }

  const journeys =
    findDirectJourneys(from, to);

  const current = nowSeconds();

  const upcoming = journeys
    .filter(j => j.departure >= current)
    .sort(
      (a, b) => a.departure - b.departure
    )
    .slice(0, 20);

  res.json({
    ok: true,
    from: db.stops.get(from),
    to: db.stops.get(to),
    transferCount: 0,
    journeys: upcoming.map(j => ({
      ...j,
      waitingMinutes: Math.max(
        0,
        Math.round(
          (j.departure - current) / 60
        )
      )
    }))
  });
});

/* -------------------------------------------------------
   CANLI VERİ
------------------------------------------------------- */

app.get("/api/live/:stopId", (req, res) => {
  res.json({
    ok: false,
    available: false,
    live: false,
    stopId: req.params.stopId,
    message:
      "Konya ATUS canlı araç konumu için doğrulanmış resmî API bağlantısı bu sunucuda bulunmuyor. Tahmini canlı araç verisi gösterilmiyor."
  });
});

/* -------------------------------------------------------
   STATIC
------------------------------------------------------- */

const publicDir = process.cwd();

app.use(
  express.static(publicDir, {
    extensions: ["html"]
  })
);

app.get("*", (req, res, next) => {
  if (
    req.path.startsWith("/api/")
  ) {
    return next();
  }

  res.sendFile(
    path.join(publicDir, "index.html")
  );
});

/* -------------------------------------------------------
   HATA YÖNETİMİ
------------------------------------------------------- */

app.use((err, req, res, next) => {
  console.error("SERVER ERROR:", err);

  res.status(500).json({
    ok: false,
    error:
      err?.message ||
      "Sunucu hatası oluştu."
  });
});

/* -------------------------------------------------------
   SUNUCU
------------------------------------------------------- */

const server = app.listen(
  PORT,
  HOST,
  async () => {
    console.log("");
    console.log("======================================");
    console.log(" KONYA ULAŞIM PLUS");
    console.log("======================================");
    console.log(
      `Server: http://${HOST}:${PORT}`
    );
    console.log(
      "Resmî veri kaynağı hazırlanıyor..."
    );
    console.log("");

    await loadGtfs();
  }
);

/* -------------------------------------------------------
   PERİYODİK VERİ YENİLEME
------------------------------------------------------- */

setInterval(
  async () => {
    if (!state.loading) {
      console.log(
        "GTFS periyodik yenileme..."
      );

      await loadGtfs();
    }
  },
  30 * 60 * 1000
);

/* -------------------------------------------------------
   KAPATMA
------------------------------------------------------- */

function shutdown(signal) {
  console.log(
    `${signal} alındı. Sunucu kapatılıyor...`
  );

  server.close(() => {
    process.exit(0);
  });
}

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);
