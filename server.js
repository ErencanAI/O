import express from "express";
import cors from "cors";
import AdmZip from "adm-zip";

const app = express();
const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";

const GTFS_URL =
  process.env.GTFS_URL ||
  "https://acikveri.konya.bel.tr/dataset/c2e034e6-e015-49c6-8eec-6e2f7de9c105/resource/ec944ecd-1c1f-4687-a7f6-fcf2dc5bb5db/download/gtfs_11_2025.zip";

const OFFICIAL_SOURCE =
  "https://acikveri.konya.bel.tr/dataset/groups/toplu-tasima-gtfs-verileri";

app.use(cors());
app.use(express.json());

const state = {
  ready: false,
  loading: false,
  error: null,
  lastUpdate: null,
  source: {
    name: "Konya Büyükşehir Belediyesi Açık Veri",
    url: OFFICIAL_SOURCE,
    gtfsUrl: GTFS_URL
  },
  connection: {
    ok: false,
    statusCode: null,
    bytes: 0,
    url: GTFS_URL,
    error: null
  },
  stats: {
    stops: 0,
    routes: 0,
    trips: 0,
    stopTimes: 0
  }
};

const db = {
  stops: new Map(),
  routes: new Map(),
  trips: new Map(),
  stopTimes: new Map(),
  stopRoutes: new Map(),
  routeTrips: new Map()
};

function clean(v) {
  return String(v ?? "")
    .replace(/^\uFEFF/, "")
    .trim();
}

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
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") {
      field += c;
    }
  }

  if (field || row.length) {
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
        obj[h] = clean(r[i]);
      });
      return obj;
    });
}

function zipFile(zip, filename) {
  const entry = zip.getEntries().find(e => {
    const name = e.entryName
      .replaceAll("\\", "/")
      .split("/")
      .pop();

    return name?.toLowerCase() === filename.toLowerCase();
  });

  return entry
    ? entry.getData().toString("utf8")
    : null;
}

function isZip(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    (
      buffer[2] === 0x03 ||
      buffer[2] === 0x05 ||
      buffer[2] === 0x07
    )
  );
}

function gtfsTime(value) {
  if (!value) return null;

  const p = value.split(":").map(Number);

  if (p.length !== 3 || p.some(Number.isNaN)) {
    return null;
  }

  return (
    p[0] * 3600 +
    p[1] * 60 +
    p[2]
  );
}

function distance(lat1, lon1, lat2, lon2) {
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

  return (
    2 *
    R *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    )
  );
}

function currentSeconds() {
  const d = new Date();

  return (
    d.getHours() * 3600 +
    d.getMinutes() * 60 +
    d.getSeconds()
  );
}

async function downloadGTFS() {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    60000
  );

  try {
    const response = await fetch(GTFS_URL, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Konya-Ulasim-Plus",
        "Accept":
          "application/zip,application/octet-stream,*/*"
      }
    });

    const buffer = Buffer.from(
      await response.arrayBuffer()
    );

    state.connection = {
      ok: response.ok && isZip(buffer),
      statusCode: response.status,
      bytes: buffer.length,
      url: response.url || GTFS_URL,
      error: null
    };

    if (!response.ok) {
      throw new Error(
        `Resmî GTFS bağlantısı HTTP ${response.status}`
      );
    }

    if (!isZip(buffer)) {
      throw new Error(
        "Resmî sunucu ZIP dosyası yerine geçersiz veri gönderdi."
      );
    }

    return buffer;
  } catch (error) {
    state.connection.ok = false;
    state.connection.error =
      error?.name === "AbortError"
        ? "GTFS bağlantısı 60 saniyede kurulamadı."
        : error?.message || String(error);

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadGTFS() {
  if (state.loading) return;

  state.loading = true;
  state.ready = false;
  state.error = null;

  try {
    console.log("GTFS yükleniyor...");

    const buffer = await downloadGTFS();
    const zip = new AdmZip(buffer);

    const stopsText =
      zipFile(zip, "stops.txt");

    const routesText =
      zipFile(zip, "routes.txt");

    const tripsText =
      zipFile(zip, "trips.txt");

    const stopTimesText =
      zipFile(zip, "stop_times.txt");

    if (!stopsText)
      throw new Error("GTFS stops.txt bulunamadı.");

    if (!routesText)
      throw new Error("GTFS routes.txt bulunamadı.");

    if (!tripsText)
      throw new Error("GTFS trips.txt bulunamadı.");

    if (!stopTimesText)
      throw new Error("GTFS stop_times.txt bulunamadı.");

    db.stops.clear();
    db.routes.clear();
    db.trips.clear();
    db.stopTimes.clear();
    db.stopRoutes.clear();
    db.routeTrips.clear();

    for (const s of parseCSV(stopsText)) {
      const lat = Number(s.stop_lat);
      const lon = Number(s.stop_lon);

      if (
        !s.stop_id ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lon)
      ) continue;

      db.stops.set(s.stop_id, {
        id: s.stop_id,
        name: s.stop_name || s.stop_id,
        lat,
        lon,
        code: s.stop_code || null
      });
    }

    for (const r of parseCSV(routesText)) {
      if (!r.route_id) continue;

      db.routes.set(r.route_id, {
        id: r.route_id,
        shortName:
          r.route_short_name || r.route_id,
        longName:
          r.route_long_name || "",
        type:
          r.route_type || ""
      });
    }

    for (const t of parseCSV(tripsText)) {
      if (!t.trip_id) continue;

      const trip = {
        id: t.trip_id,
        routeId: t.route_id,
        serviceId: t.service_id || "",
        headsign: t.trip_headsign || ""
      };

      db.trips.set(trip.id, trip);

      if (!db.routeTrips.has(trip.routeId)) {
        db.routeTrips.set(trip.routeId, []);
      }

      db.routeTrips
        .get(trip.routeId)
        .push(trip);
    }

    let stopTimeCount = 0;

    for (const s of parseCSV(stopTimesText)) {
      if (!s.trip_id || !s.stop_id) continue;

      const item = {
        tripId: s.trip_id,
        stopId: s.stop_id,
        sequence:
          Number(s.stop_sequence) || 0,
        arrival:
          gtfsTime(s.arrival_time),
        departure:
          gtfsTime(s.departure_time)
      };

      if (!db.stopTimes.has(item.tripId)) {
        db.stopTimes.set(item.tripId, []);
      }

      db.stopTimes
        .get(item.tripId)
        .push(item);

      if (!db.stopRoutes.has(item.stopId)) {
        db.stopRoutes.set(
          item.stopId,
          new Set()
        );
      }

      const trip =
        db.trips.get(item.tripId);

      if (trip) {
        db.stopRoutes
          .get(item.stopId)
          .add(trip.routeId);
      }

      stopTimeCount++;
    }

    for (const times of db.stopTimes.values()) {
      times.sort(
        (a, b) =>
          a.sequence - b.sequence
      );
    }

    state.stats = {
      stops: db.stops.size,
      routes: db.routes.size,
      trips: db.trips.size,
      stopTimes: stopTimeCount
    };

    state.ready = true;
    state.error = null;
    state.lastUpdate =
      new Date().toISOString();

    console.log("GTFS BAŞARILI");
    console.log("Durak:", db.stops.size);
    console.log("Hat:", db.routes.size);
    console.log("Sefer:", db.trips.size);
    console.log(
      "StopTime:",
      stopTimeCount
    );
  } catch (error) {
    state.ready = false;
    state.error =
      error?.message || String(error);

    console.error(
      "GTFS YÜKLEME HATASI:",
      state.error
    );
  } finally {
    state.loading = false;
  }
}

/* HEALTH */

app.get("/api/health", (req, res) => {
  res.json({
    ok: state.ready,
    ready: state.ready,
    loading: state.loading,
    error: state.error,
    connection: state.connection,
    source: state.source,
    stats: state.stats,
    lastUpdate: state.lastUpdate
  });
});

/* APP INFO */

app.get("/api/app-info", (req, res) => {
  res.json({
    name: "Konya Ulaşım Plus",
    version: "5.0.0",
    city: "Konya",
    source: "Konya Büyükşehir Belediyesi Açık Veri",
    official: true,
    officialUrl: OFFICIAL_SOURCE,
    liveVehicleApi: false
  });
});

/* DATA STATUS */

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

/* STOPS */

app.get("/api/stops", (req, res) => {
  if (!state.ready) {
    return res.status(503).json({
      ok: false,
      error:
        state.error ||
        "Resmî GTFS verisi hazır değil."
    });
  }

  const q = clean(req.query.q)
    .toLocaleLowerCase("tr-TR");

  const limit = Math.min(
    Math.max(
      Number(req.query.limit) || 100,
      1
    ),
    500
  );

  let stops =
    [...db.stops.values()];

  if (q) {
    stops = stops.filter(stop =>
      `${stop.name} ${stop.code || ""}`
        .toLocaleLowerCase("tr-TR")
        .includes(q)
    );
  }

  res.json({
    ok: true,
    count: Math.min(stops.length, limit),
    stops: stops.slice(0, limit)
  });
});

/* NEARBY STOPS */

app.get("/api/stops/nearby", (req, res) => {
  if (!state.ready) {
    return res.status(503).json({
      ok: false,
      error:
        state.error ||
        "Resmî GTFS verisi hazır değil."
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
      error: "Geçerli konum gerekli."
    });
  }

  const result = [];

  for (const stop of db.stops.values()) {
    const meters = distance(
      lat,
      lon,
      stop.lat,
      stop.lon
    );

    if (meters <= radius) {
      result.push({
        ...stop,
        distance: Math.round(meters),
        walkingMinutes:
          Math.max(
            1,
            Math.round(meters / 80)
          )
      });
    }
  }

  result.sort(
    (a, b) =>
      a.distance - b.distance
  );

  res.json({
    ok: true,
    count: result.length,
    stops: result.slice(0, 100)
  });
});

/* STOP DETAIL */

app.get("/api/stops/:stopId", (req, res) => {
  if (!state.ready) {
    return res.status(503).json({
      ok: false,
      error:
        state.error ||
        "Resmî GTFS verisi hazır değil."
    });
  }

  const stop =
    db.stops.get(req.params.stopId);

  if (!stop) {
    return res.status(404).json({
      ok: false,
      error: "Durak bulunamadı."
    });
  }

  const routeIds =
    [...(
      db.stopRoutes.get(stop.id) ||
      new Set()
    )];

  const routes = routeIds
    .map(id => db.routes.get(id))
    .filter(Boolean);

  res.json({
    ok: true,
    stop,
    routes
  });
});

/* ROUTES */

app.get("/api/routes", (req, res) => {
  if (!state.ready) {
    return res.status(503).json({
      ok: false,
      error:
        state.error ||
        "Resmî GTFS verisi hazır değil."
    });
  }

  const q = clean(req.query.q)
    .toLocaleLowerCase("tr-TR");

  let routes =
    [...db.routes.values()];

  if (q) {
    routes = routes.filter(route =>
      `${route.shortName} ${route.longName}`
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

/* ROUTE DETAIL */

app.get("/api/routes/:routeId", (req, res) => {
  if (!state.ready) {
    return res.status(503).json({
      ok: false,
      error:
        state.error ||
        "Resmî GTFS verisi hazır değil."
    });
  }

  const route =
    db.routes.get(req.params.routeId);

  if (!route) {
    return res.status(404).json({
      ok: false,
      error: "Hat bulunamadı."
    });
  }

  const trips =
    db.routeTrips.get(route.id) || [];

  res.json({
    ok: true,
    route,
    trips
  });
});

/* JOURNEY */

app.get("/api/journey/calculate", (req, res) => {
  if (!state.ready) {
    return res.status(503).json({
      ok: false,
      error:
        state.error ||
        "Resmî GTFS verisi hazır değil."
    });
  }

  const from = clean(req.query.from);
  const to = clean(req.query.to);

  if (!from || !to) {
    return res.status(400).json({
      ok: false,
      error:
        "from ve to durak ID'leri gerekli."
    });
  }

  const fromStop =
    db.stops.get(from);

  const toStop =
    db.stops.get(to);

  if (!fromStop) {
    return res.status(404).json({
      ok: false,
      error:
        "Başlangıç durağı bulunamadı."
    });
  }

  if (!toStop) {
    return res.status(404).json({
      ok: false,
      error:
        "Hedef durağı bulunamadı."
    });
  }

  const fromRoutes =
    db.stopRoutes.get(from) ||
    new Set();

  const toRoutes =
    db.stopRoutes.get(to) ||
    new Set();

  const commonRoutes =
    [...fromRoutes]
      .filter(id => toRoutes.has(id));

  const journeys = [];

  for (const routeId of commonRoutes) {
    const trips =
      db.routeTrips.get(routeId) || [];

    for (const trip of trips) {
      const times =
        db.stopTimes.get(trip.id) || [];

      const fromTime =
        times.find(
          x => x.stopId === from
        );

      const toTime =
        times.find(
          x => x.stopId === to
        );

      if (!fromTime || !toTime) continue;

      if (
        fromTime.sequence >=
        toTime.sequence
      ) {
        continue;
      }

      const departure =
        fromTime.departure ??
        fromTime.arrival;

      const arrival =
        toTime.arrival ??
        toTime.departure;

      if (
        departure == null ||
        arrival == null
      ) {
        continue;
      }

      journeys.push({
        routeId,
        tripId: trip.id,
        route:
          db.routes.get(routeId),
        headsign:
          trip.headsign,
        departure,
        arrival,
        rideMinutes:
          Math.max(
            0,
            Math.round(
              (arrival - departure) /
              60
            )
          )
      });
    }
  }

  const now = currentSeconds();

  const upcoming =
    journeys
      .filter(j =>
        j.departure >= now
      )
      .sort(
        (a, b) =>
          a.departure - b.departure
      )
      .slice(0, 20)
      .map(j => ({
        ...j,
        waitingMinutes:
          Math.round(
            (j.departure - now) /
            60
          )
      }));

  res.json({
    ok: true,
    from: fromStop,
    to: toStop,
    transferCount: 0,
    journeys: upcoming
  });
});

/* LIVE VEHICLE */

app.get("/api/live/:stopId", (req, res) => {
  res.json({
    ok: false,
    available: false,
    live: false,
    stopId: req.params.stopId,
    message:
      "Doğrulanmış resmî canlı araç API'si bağlı olmadığı için sahte canlı konum gösterilmiyor."
  });
});

/* ROOT */

app.get("/", (req, res) => {
  res.sendFile(
    "index.html",
    { root: process.cwd() }
  );
});

/* STATIC */

app.use(
  express.static(process.cwd())
);

/* 404 */

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "İstek bulunamadı."
  });
});

/* ERROR */

app.use((err, req, res, next) => {
  console.error(err);

  res.status(500).json({
    ok: false,
    error:
      err?.message ||
      "Sunucu hatası."
  });
});

/* START */

app.listen(
  PORT,
  HOST,
  async () => {
    console.log(
      `Konya Ulaşım Plus çalışıyor: ${PORT}`
    );

    await loadGTFS();
  }
);

/* REFRESH */

setInterval(
  () => {
    if (!state.loading) {
      loadGTFS().catch(console.error);
    }
  },
  30 * 60 * 1000
);
