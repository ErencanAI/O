import express from "express";
import cors from "cors";
import AdmZip from "adm-zip";

const app = express();

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";

const SOURCE_URL =
  "https://acikveri.konya.bel.tr/dataset/groups/toplu-tasima-gtfs-verileri";

const GTFS_URL =
  process.env.GTFS_URL ||
  "https://acikveri.konya.bel.tr/dataset/c2e034e6-e015-49c6-8eec-6e2f7de9c105/resource/ec944ecd-1c1f-4687-a7f6-fcf2dc5bb5db/download/gtfs_11_2025.zip";

app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const db = {
  stops: new Map(),
  routes: new Map(),
  trips: new Map(),
  stopTimes: new Map(),
  stopRoutes: new Map(),
  routeTrips: new Map()
};

const state = {
  ready: false,
  loading: false,
  error: null,
  lastUpdate: null,
  connection: {
    ok: false,
    status: null,
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

function clean(value) {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .trim();
}

function parseCSV(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        value += c;
      }
      continue;
    }

    if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(value);
      value = "";
    } else if (c === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (c !== "\r") {
      value += c;
    }
  }

  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }

  if (!rows.length) return [];

  const headers = rows[0].map(clean);

  return rows
    .slice(1)
    .filter(r => r.some(v => clean(v)))
    .map(r => {
      const item = {};

      headers.forEach((header, i) => {
        item[header] = clean(r[i]);
      });

      return item;
    });
}

function zipText(zip, filename) {
  const entry = zip.getEntries().find(entry => {
    const name = entry.entryName
      .replaceAll("\\", "/")
      .split("/")
      .pop();

    return (
      name &&
      name.toLowerCase() === filename.toLowerCase()
    );
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
    [0x03, 0x05, 0x07].includes(buffer[2])
  );
}

function gtfsTime(value) {
  if (!value) return null;

  const p = value.split(":").map(Number);

  if (
    p.length !== 3 ||
    p.some(Number.isNaN)
  ) {
    return null;
  }

  return (
    p[0] * 3600 +
    p[1] * 60 +
    p[2]
  );
}

function formatTime(seconds) {
  if (seconds == null) return null;

  const total = seconds % 86400;

  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);

  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function konyaSeconds() {
  const parts = new Intl.DateTimeFormat(
    "tr-TR",
    {
      timeZone: "Europe/Istanbul",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }
  ).formatToParts(new Date());

  const get = type =>
    Number(
      parts.find(x => x.type === type)?.value || 0
    );

  return (
    get("hour") * 3600 +
    get("minute") * 60 +
    get("second")
  );
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;

  const a1 = lat1 * Math.PI / 180;
  const a2 = lat2 * Math.PI / 180;

  const da =
    (lat2 - lat1) * Math.PI / 180;

  const db =
    (lon2 - lon1) * Math.PI / 180;

  const a =
    Math.sin(da / 2) ** 2 +
    Math.cos(a1) *
    Math.cos(a2) *
    Math.sin(db / 2) ** 2;

  return (
    2 *
    R *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    )
  );
}

async function downloadGTFS() {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    90000
  );

  try {
    const response = await fetch(GTFS_URL, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 Konya-Ulasim-Plus/5.0",
        "Accept":
          "application/zip, application/octet-stream, */*"
      }
    });

    const buffer = Buffer.from(
      await response.arrayBuffer()
    );

    state.connection = {
      ok: response.ok && isZip(buffer),
      status: response.status,
      bytes: buffer.length,
      url: response.url || GTFS_URL,
      error: null
    };

    if (!response.ok) {
      throw new Error(
        `GTFS HTTP ${response.status}`
      );
    }

    if (!isZip(buffer)) {
      throw new Error(
        "GTFS kaynağı ZIP döndürmedi."
      );
    }

    return buffer;
  } catch (error) {
    state.connection.ok = false;
    state.connection.error =
      error?.name === "AbortError"
        ? "GTFS bağlantısı zaman aşımına uğradı."
        : error?.message ||
          "GTFS bağlantısı kurulamadı.";

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function loadGTFS() {
  if (state.loading) return;

  state.loading = true;
  state.error = null;

  try {
    console.log("GTFS yükleniyor...");

    const buffer =
      await downloadGTFS();

    const zip =
      new AdmZip(buffer);

    const files = {
      stops:
        zipText(zip, "stops.txt"),
      routes:
        zipText(zip, "routes.txt"),
      trips:
        zipText(zip, "trips.txt"),
      stopTimes:
        zipText(zip, "stop_times.txt")
    };

    if (!files.stops)
      throw new Error("stops.txt bulunamadı.");

    if (!files.routes)
      throw new Error("routes.txt bulunamadı.");

    if (!files.trips)
      throw new Error("trips.txt bulunamadı.");

    if (!files.stopTimes)
      throw new Error("stop_times.txt bulunamadı.");

    const newStops = new Map();
    const newRoutes = new Map();
    const newTrips = new Map();
    const newStopTimes = new Map();
    const newStopRoutes = new Map();
    const newRouteTrips = new Map();

    for (const s of parseCSV(files.stops)) {
      const id = clean(s.stop_id);

      const lat = Number(s.stop_lat);
      const lon = Number(s.stop_lon);

      if (
        !id ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lon)
      ) {
        continue;
      }

      newStops.set(id, {
        id,
        name:
          clean(s.stop_name) || id,
        lat,
        lon,
        code:
          clean(s.stop_code) || null
      });
    }

    for (const r of parseCSV(files.routes)) {
      const id = clean(r.route_id);

      if (!id) continue;

      newRoutes.set(id, {
        id,
        shortName:
          clean(r.route_short_name) || id,
        longName:
          clean(r.route_long_name),
        type:
          clean(r.route_type)
      });
    }

    for (const t of parseCSV(files.trips)) {
      const id = clean(t.trip_id);

      if (!id) continue;

      const trip = {
        id,
        routeId:
          clean(t.route_id),
        serviceId:
          clean(t.service_id),
        headsign:
          clean(t.trip_headsign)
      };

      newTrips.set(id, trip);

      if (!newRouteTrips.has(trip.routeId)) {
        newRouteTrips.set(
          trip.routeId,
          []
        );
      }

      newRouteTrips
        .get(trip.routeId)
        .push(trip);
    }

    let stopTimeCount = 0;

    for (const s of parseCSV(files.stopTimes)) {
      const tripId =
        clean(s.trip_id);

      const stopId =
        clean(s.stop_id);

      if (!tripId || !stopId) {
        continue;
      }

      const item = {
        tripId,
        stopId,
        sequence:
          Number(s.stop_sequence) || 0,
        arrival:
          gtfsTime(s.arrival_time),
        departure:
          gtfsTime(s.departure_time)
      };

      if (!newStopTimes.has(tripId)) {
        newStopTimes.set(
          tripId,
          []
        );
      }

      newStopTimes
        .get(tripId)
        .push(item);

      if (!newStopRoutes.has(stopId)) {
        newStopRoutes.set(
          stopId,
          new Set()
        );
      }

      const trip =
        newTrips.get(tripId);

      if (trip) {
        newStopRoutes
          .get(stopId)
          .add(trip.routeId);
      }

      stopTimeCount++;
    }

    for (const list of newStopTimes.values()) {
      list.sort(
        (a, b) =>
          a.sequence - b.sequence
      );
    }

    db.stops = newStops;
    db.routes = newRoutes;
    db.trips = newTrips;
    db.stopTimes = newStopTimes;
    db.stopRoutes = newStopRoutes;
    db.routeTrips = newRouteTrips;

    state.stats = {
      stops: newStops.size,
      routes: newRoutes.size,
      trips: newTrips.size,
      stopTimes: stopTimeCount
    };

    state.ready = true;
    state.lastUpdate =
      new Date().toISOString();

    console.log("GTFS hazır.");
    console.log(state.stats);
  } catch (error) {
    state.ready = false;
    state.error =
      error?.message ||
      "GTFS yüklenemedi.";

    console.error(
      "GTFS HATASI:",
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
    stats: state.stats,
    lastUpdate: state.lastUpdate
  });
});

/* INFO */

app.get("/api/app-info", (req, res) => {
  res.json({
    name: "Konya Ulaşım Plus",
    version: "5.0.0",
    city: "Konya",
    source:
      "Konya Büyükşehir Belediyesi Açık Veri",
    sourceUrl: SOURCE_URL,
    official: true,
    liveVehicleApi: false
  });
});

/* DATA STATUS */

app.get("/api/data-status", (req, res) => {
  res.json({
    ready: state.ready,
    loading: state.loading,
    error: state.error,
    connection: state.connection,
    stats: state.stats,
    source: SOURCE_URL,
    lastUpdate: state.lastUpdate
  });
});

/* SEARCH STOPS */

app.get("/api/stops", (req, res) => {
  if (!state.ready) {
    return res.status(503).json({
      ok: false,
      error:
        state.error ||
        "Veri henüz hazır değil."
    });
  }

  const q =
    clean(req.query.q)
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
    count:
      Math.min(stops.length, limit),
    stops:
      stops.slice(0, limit)
  });
});

/* NEARBY */

app.get(
  "/api/stops/nearby",
  (req, res) => {
    if (!state.ready) {
      return res.status(503).json({
        ok: false,
        error:
          state.error ||
          "Veri henüz hazır değil."
      });
    }

    const lat =
      Number(req.query.lat);

    const lon =
      Number(req.query.lon);

    const radius = Math.min(
      Math.max(
        Number(req.query.radius) || 2000,
        100
      ),
      10000
    );

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      lat < -90 ||
      lat > 90 ||
      lon < -180 ||
      lon > 180
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "Geçerli enlem ve boylam gerekli."
      });
    }

    const result = [];

    for (const stop of db.stops.values()) {
      const meters =
        haversine(
          lat,
          lon,
          stop.lat,
          stop.lon
        );

      if (meters <= radius) {
        result.push({
          ...stop,
          distanceMeters:
            Math.round(meters),
          walkingMinutes:
            Math.max(
              1,
              Math.ceil(meters / 80)
            )
        });
      }
    }

    result.sort(
      (a, b) =>
        a.distanceMeters -
        b.distanceMeters
    );

    res.json({
      ok: true,
      count: result.length,
      stops:
        result.slice(0, 100)
    });
  }
);

/* STOP DETAIL */

app.get(
  "/api/stops/:stopId",
  (req, res) => {
    if (!state.ready) {
      return res.status(503).json({
        ok: false,
        error:
          state.error ||
          "Veri henüz hazır değil."
      });
    }

    const stop =
      db.stops.get(
        req.params.stopId
      );

    if (!stop) {
      return res.status(404).json({
        ok: false,
        error: "Durak bulunamadı."
      });
    }

    const routeIds =
      [
        ...(db.stopRoutes.get(
          stop.id
        ) || new Set())
      ];

    const routes =
      routeIds
        .map(id =>
          db.routes.get(id)
        )
        .filter(Boolean);

    res.json({
      ok: true,
      stop,
      routes
    });
  }
);

/* ROUTES */

app.get("/api/routes", (req, res) => {
  if (!state.ready) {
    return res.status(503).json({
      ok: false,
      error:
        state.error ||
        "Veri henüz hazır değil."
    });
  }

  const q =
    clean(req.query.q)
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

app.get(
  "/api/routes/:routeId",
  (req, res) => {
    if (!state.ready) {
      return res.status(503).json({
        ok: false,
        error:
          state.error ||
          "Veri henüz hazır değil."
      });
    }

    const route =
      db.routes.get(
        req.params.routeId
      );

    if (!route) {
      return res.status(404).json({
        ok: false,
        error: "Hat bulunamadı."
      });
    }

    const trips =
      db.routeTrips.get(
        route.id
      ) || [];

    res.json({
      ok: true,
      route,
      trips
    });
  }
);

/* JOURNEY */

app.get(
  "/api/journey/calculate",
  (req, res) => {
    if (!state.ready) {
      return res.status(503).json({
        ok: false,
        error:
          state.error ||
          "Veri henüz hazır değil."
      });
    }

    const from =
      clean(req.query.from);

    const to =
      clean(req.query.to);

    if (!from || !to) {
      return res.status(400).json({
        ok: false,
        error:
          "from ve to gerekli."
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
      [...fromRoutes].filter(
        routeId =>
          toRoutes.has(routeId)
      );

    const now =
      konyaSeconds();

    const journeys = [];

    for (const routeId of commonRoutes) {
      const trips =
        db.routeTrips.get(
          routeId
        ) || [];

      for (const trip of trips) {
        const times =
          db.stopTimes.get(
            trip.id
          ) || [];

        const start =
          times.find(
            x => x.stopId === from
          );

        const finish =
          times.find(
            x => x.stopId === to
          );

        if (!start || !finish) {
          continue;
        }

        if (
          start.sequence >=
          finish.sequence
        ) {
          continue;
        }

        const departure =
          start.departure ??
          start.arrival;

        const arrival =
          finish.arrival ??
          finish.departure;

        if (
          departure == null ||
          arrival == null
        ) {
          continue;
        }

        let wait =
          departure - now;

        if (wait < 0) {
          wait += 86400;
        }

        journeys.push({
          routeId,
          tripId: trip.id,
          route:
            db.routes.get(routeId),
          headsign:
            trip.headsign,
          departure,
          departureTime:
            formatTime(departure),
          arrival,
          arrivalTime:
            formatTime(arrival),
          waitingMinutes:
            Math.round(wait / 60),
          rideMinutes:
            Math.max(
              0,
              Math.round(
                (arrival - departure) /
                60
              )
            ),
          transferCount: 0
        });
      }
    }

    journeys.sort(
      (a, b) =>
        a.waitingMinutes -
        b.waitingMinutes
    );

    const unique = [];
    const seen = new Set();

    for (const journey of journeys) {
      const key =
        `${journey.routeId}-${journey.departure}`;

      if (seen.has(key)) continue;

      seen.add(key);
      unique.push(journey);

      if (unique.length >= 20) {
        break;
      }
    }

    res.json({
      ok: true,
      from: fromStop,
      to: toStop,
      transferCount: 0,
      journeys: unique
    });
  }
);

/* LIVE VEHICLES */

app.get(
  "/api/live/:stopId",
  (req, res) => {
    res.json({
      ok: false,
      available: false,
      live: false,
      stopId:
        req.params.stopId,
      message:
        "Doğrulanmış resmî canlı araç konum API'si bağlı değil."
    });
  }
);

/* ROOT */

app.get("/", (req, res) => {
  res.sendFile(
    "index.html",
    {
      root: process.cwd()
    }
  );
});

/* STATIC */

app.use(
  express.static(
    process.cwd()
  )
);

/* 404 */

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: "Endpoint bulunamadı."
  });
});

/* ERROR */

app.use(
  (err, req, res, next) => {
    console.error(err);

    res.status(500).json({
      ok: false,
      error:
        err?.message ||
        "Sunucu hatası."
    });
  }
);

/* START */

app.listen(
  PORT,
  HOST,
  () => {
    console.log(
      `Konya Ulaşım Plus çalışıyor: http://${HOST}:${PORT}`
    );

    loadGTFS().catch(error => {
      console.error(
        "İlk GTFS yükleme hatası:",
        error
      );
    });
  }
);

/* REFRESH */

setInterval(
  () => {
    if (!state.loading) {
      loadGTFS().catch(error => {
        console.error(
          "GTFS yenileme hatası:",
          error
        );
      });
    }
  },
  30 * 60 * 1000
);
