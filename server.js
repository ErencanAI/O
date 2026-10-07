import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const state = {
  ready: false,
  source: "official-konya-open-data",
  stops: [],
  routes: [],
  trips: [],
  error: null,
  loadedAt: null
};

/* -------------------------------------------------- */
/* CSV */
/* -------------------------------------------------- */

function parseCSV(text) {
  const lines = String(text || "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter(Boolean);

  if (!lines.length) return [];

  const parseLine = line => {
    const result = [];
    let value = "";
    let quoted = false;

    for (let i = 0; i < line.length; i++) {
      const c = line[i];

      if (c === '"') {
        if (quoted && line[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          quoted = !quoted;
        }
      } else if (c === "," && !quoted) {
        result.push(value);
        value = "";
      } else {
        value += c;
      }
    }

    result.push(value);
    return result;
  };

  const headers = parseLine(lines[0]).map(x =>
    String(x).trim().replace(/^"|"$/g, "")
  );

  return lines.slice(1).map(line => {
    const values = parseLine(line);
    const obj = {};

    headers.forEach((header, i) => {
      obj[header] = String(values[i] ?? "")
        .trim()
        .replace(/^"|"$/g, "");
    });

    return obj;
  });
}

/* -------------------------------------------------- */
/* LOCAL GTFS */
/* -------------------------------------------------- */

function loadLocalData() {
  const dataDir = path.join(__dirname, "data");

  const files = {
    stops: path.join(dataDir, "stops.txt"),
    routes: path.join(dataDir, "routes.txt"),
    trips: path.join(dataDir, "trips.txt")
  };

  if (!fs.existsSync(files.stops)) return false;
  if (!fs.existsSync(files.routes)) return false;

  try {
    const stops = parseCSV(
      fs.readFileSync(files.stops, "utf8")
    );

    const routes = parseCSV(
      fs.readFileSync(files.routes, "utf8")
    );

    const trips = fs.existsSync(files.trips)
      ? parseCSV(fs.readFileSync(files.trips, "utf8"))
      : [];

    state.stops = stops
      .map(x => ({
        id: x.stop_id,
        name: x.stop_name,
        code: x.stop_code || "",
        lat: Number(x.stop_lat),
        lon: Number(x.stop_lon)
      }))
      .filter(x =>
        x.id &&
        x.name &&
        Number.isFinite(x.lat) &&
        Number.isFinite(x.lon)
      );

    state.routes = routes
      .map(x => ({
        id: x.route_id,
        shortName: x.route_short_name || "",
        longName: x.route_long_name || "",
        type: x.route_type || ""
      }))
      .filter(x => x.id);

    state.trips = trips
      .map(x => ({
        id: x.trip_id,
        routeId: x.route_id,
        serviceId: x.service_id || "",
        headsign: x.trip_headsign || "",
        directionId: x.direction_id || ""
      }))
      .filter(x => x.id);

    if (!state.stops.length) {
      throw new Error("stops.txt içinde geçerli durak yok.");
    }

    state.ready = true;
    state.error = null;
    state.loadedAt = new Date().toISOString();

    return true;
  } catch (error) {
    state.error = error.message;
    return false;
  }
}

/* -------------------------------------------------- */
/* STARTUP */
/* -------------------------------------------------- */

function initialize() {
  /*
    Önce projeye eklenmiş resmî GTFS verisini kullan.
    Böylece Render'ın dışarıya erişmesine bağımlı olmaz.
  */

  if (loadLocalData()) {
    console.log(
      `GTFS hazır: ${state.stops.length} durak, ` +
      `${state.routes.length} hat, ` +
      `${state.trips.length} sefer`
    );
    return;
  }

  /*
    Veri yoksa SERVER YİNE DE ÇALIŞIR.
    Sahte veri oluşturulmaz.
  */

  state.ready = false;

  console.log(
    "GTFS yerel dosyaları bulunamadı."
  );
}

/* -------------------------------------------------- */
/* HEALTH */
/* -------------------------------------------------- */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "Konya Ulaşım Plus",
    status: "online",
    dataReady: state.ready,
    time: new Date().toISOString()
  });
});

/* -------------------------------------------------- */
/* DATA STATUS */
/* -------------------------------------------------- */

app.get("/api/data-status", (req, res) => {
  res.json({
    ok: true,
    available: state.ready,
    ready: state.ready,

    stopCount: state.stops.length,
    routeCount: state.routes.length,
    tripCount: state.trips.length,

    source: state.source,
    loadedAt: state.loadedAt,

    error: state.ready ? null : state.error,

    message: state.ready
      ? "Resmî Konya ulaşım verileri hazır."
      : "Resmî GTFS verisi projeye henüz eklenmedi."
  });
});

/* -------------------------------------------------- */
/* APP INFO */
/* -------------------------------------------------- */

app.get("/api/app-info", (req, res) => {
  res.json({
    ok: true,
    name: "Konya Ulaşım Plus",
    version: "10.0.0",
    city: "Konya",

    features: {
      nearbyStops: true,
      stopSearch: true,
      routes: true,
      journey: true,
      realtimeVehicles: false
    }
  });
});

/* -------------------------------------------------- */
/* STOP SEARCH */
/* -------------------------------------------------- */

app.get("/api/stops", (req, res) => {
  if (!state.ready) {
    return res.json({
      ok: true,
      available: false,
      stops: []
    });
  }

  const search = String(
    req.query.search || ""
  )
    .trim()
    .toLocaleLowerCase("tr-TR");

  let result = state.stops;

  if (search) {
    result = result.filter(stop =>
      stop.name
        .toLocaleLowerCase("tr-TR")
        .includes(search) ||

      String(stop.code)
        .toLocaleLowerCase("tr-TR")
        .includes(search)
    );
  }

  result = result.slice(0, 100);

  res.json({
    ok: true,
    available: true,
    count: result.length,
    stops: result
  });
});

/* -------------------------------------------------- */
/* NEARBY STOPS */
/* -------------------------------------------------- */

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
    R *
    2 *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    )
  );
}

app.get("/api/stops/nearby", (req, res) => {
  if (!state.ready) {
    return res.json({
      ok: true,
      available: false,
      stops: []
    });
  }

  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);

  if (!Number.isFinite(lat) ||
      !Number.isFinite(lon)) {
    return res.status(400).json({
      ok: false,
      available: false,
      stops: [],
      message: "Geçerli konum gerekli."
    });
  }

  const result = state.stops
    .map(stop => ({
      ...stop,
      distance: Math.round(
        distance(
          lat,
          lon,
          stop.lat,
          stop.lon
        )
      )
    }))
    .sort(
      (a, b) =>
        a.distance - b.distance
    )
    .slice(0, 20)
    .map(stop => ({
      ...stop,
      walkingMinutes:
        Math.max(
          1,
          Math.ceil(
            stop.distance / 80
          )
        )
    }));

  res.json({
    ok: true,
    available: true,
    count: result.length,
    stops: result
  });
});

/* -------------------------------------------------- */
/* STOP DETAIL */
/* -------------------------------------------------- */

app.get("/api/stops/:id", (req, res) => {
  if (!state.ready) {
    return res.json({
      ok: true,
      available: false,
      stop: null,
      routes: []
    });
  }

  const stop = state.stops.find(
    x => String(x.id) === String(req.params.id)
  );

  if (!stop) {
    return res.status(404).json({
      ok: false,
      available: true,
      stop: null,
      routes: []
    });
  }

  res.json({
    ok: true,
    available: true,
    stop,
    routes: []
  });
});

/* -------------------------------------------------- */
/* ROUTES */
/* -------------------------------------------------- */

app.get("/api/routes", (req, res) => {
  res.json({
    ok: true,
    available: state.ready,
    routes: state.ready
      ? state.routes
      : []
  });
});

/* -------------------------------------------------- */
/* LIVE VEHICLES */
/* -------------------------------------------------- */

app.get("/api/live/:stopId", (req, res) => {
  res.json({
    ok: true,
    available: false,
    realtime: false,
    stopId: req.params.stopId,
    vehicles: [],
    message:
      "Doğrulanmış canlı araç API'si kullanılmıyor."
  });
});

/* -------------------------------------------------- */
/* JOURNEY */
/* -------------------------------------------------- */

app.get("/api/journey/calculate", (req, res) => {
  if (!state.ready) {
    return res.json({
      ok: true,
      available: false,
      journeys: []
    });
  }

  const from = String(req.query.from || "");
  const to = String(req.query.to || "");

  const start = state.stops.find(
    x => String(x.id) === from
  );

  const target = state.stops.find(
    x => String(x.id) === to
  );

  if (!start || !target) {
    return res.status(404).json({
      ok: false,
      available: true,
      journeys: [],
      message: "Durak bulunamadı."
    });
  }

  /*
    Burada sahte sefer üretmiyoruz.
    stop_times.txt ayrıca eklenirse gerçek
    zaman çizelgesi üzerinden hesaplama yapılabilir.
  */

  res.json({
    ok: true,
    available: false,
    journeys: [],
    message:
      "Gerçek sefer hesaplaması için stop_times.txt gereklidir."
  });
});

/* -------------------------------------------------- */
/* ROOT */
/* -------------------------------------------------- */

app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "index.html")
  );
});

/* -------------------------------------------------- */
/* API 404 */
/* -------------------------------------------------- */

app.use("/api", (req, res) => {
  res.status(404).json({
    ok: false,
    message: "API adresi bulunamadı."
  });
});

/* -------------------------------------------------- */
/* ERROR */
/* -------------------------------------------------- */

app.use((err, req, res, next) => {
  console.error(err);

  res.status(500).json({
    ok: false,
    message: "Sunucu hatası."
  });
});

/* -------------------------------------------------- */
/* START */
/* -------------------------------------------------- */

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Konya Ulaşım Plus çalışıyor: ${PORT}`
    );

    initialize();
  }
);
