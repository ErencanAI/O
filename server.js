import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";

app.disable("x-powered-by");

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
  })
);

app.use(express.json({ limit: "2mb" }));

/* =====================================================
   RESMÎ KAYNAKLAR
===================================================== */

const SOURCES = [
  {
    name: "Konya Büyükşehir Belediyesi Açık Veri",
    url: "https://acikveri.konya.bel.tr",
    type: "official"
  },
  {
    name: "ATUS",
    url: "https://atus.konya.bel.tr",
    type: "official"
  }
];

/* =====================================================
   VERİTABANI
===================================================== */

const DB = {
  stops: new Map(),
  routes: new Map(),
  trips: new Map(),
  stopTimes: new Map(),
  stopRoutes: new Map(),
  routeTrips: new Map()
};

const STATE = {
  ready: false,
  loading: false,

  source: "none",

  lastUpdate: null,

  error: null,

  stats: {
    stops: 0,
    routes: 0,
    trips: 0,
    stopTimes: 0
  }
};

/* =====================================================
   HAZIRLIK
===================================================== */

function resetDatabase() {
  DB.stops.clear();
  DB.routes.clear();
  DB.trips.clear();
  DB.stopTimes.clear();
  DB.stopRoutes.clear();
  DB.routeTrips.clear();

  STATE.stats = {
    stops: 0,
    routes: 0,
    trips: 0,
    stopTimes: 0
  };
}

function clean(value) {
  return String(value ?? "")
    .replace(/^\uFEFF/, "")
    .trim();
}

function validNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/* =====================================================
   CSV PARSER
===================================================== */

function parseCSV(text) {
  if (!text) return [];

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
      continue;
    }

    if (c === ",") {
      row.push(field);
      field = "";
      continue;
    }

    if (c === "\n") {
      row.push(field);
      rows.push(row);

      row = [];
      field = "";

      continue;
    }

    if (c !== "\r") {
      field += c;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }

  if (!rows.length) {
    return [];
  }

  const headers =
    rows[0].map(clean);

  return rows
    .slice(1)
    .filter(r =>
      r.some(v => clean(v) !== "")
    )
    .map(r => {
      const obj = {};

      headers.forEach(
        (header, index) => {
          obj[header] =
            clean(r[index]);
        }
      );

      return obj;
    });
}

/* =====================================================
   MESAFE
===================================================== */

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
    (lat2 - lat1) *
    Math.PI / 180;

  const dl =
    (lon2 - lon1) *
    Math.PI / 180;

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

/* =====================================================
   KONYA SAATİ
===================================================== */

function konyaSeconds() {
  const parts =
    new Intl.DateTimeFormat(
      "tr-TR",
      {
        timeZone: "Europe/Istanbul",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      }
    )
      .formatToParts(new Date());

  const get = type =>
    Number(
      parts.find(
        x => x.type === type
      )?.value || 0
    );

  return (
    get("hour") * 3600 +
    get("minute") * 60 +
    get("second")
  );
}

function formatTime(seconds) {
  if (seconds == null) {
    return null;
  }

  seconds =
    ((seconds % 86400) + 86400) %
    86400;

  const h =
    Math.floor(seconds / 3600);

  const m =
    Math.floor(
      (seconds % 3600) / 60
    );

  return (
    String(h).padStart(2, "0") +
    ":" +
    String(m).padStart(2, "0")
  );
}

function gtfsTime(value) {
  if (!value) return null;

  const parts =
    value.split(":").map(Number);

  if (
    parts.length !== 3 ||
    parts.some(
      n => !Number.isFinite(n)
    )
  ) {
    return null;
  }

  return (
    parts[0] * 3600 +
    parts[1] * 60 +
    parts[2]
  );
}

/* =====================================================
   DOSYA OKUMA
===================================================== */

function findLocalFile(names) {
  for (const name of names) {
    const full =
      path.join(__dirname, name);

    if (fs.existsSync(full)) {
      return full;
    }
  }

  return null;
}

/*
  Eğer repository içine data klasörü koyarsan:

  data/stops.txt
  data/routes.txt
  data/trips.txt
  data/stop_times.txt

  sunucu doğrudan bunları kullanabilir.
*/

function localFile(name) {
  const locations = [
    path.join(__dirname, name),
    path.join(__dirname, "data", name),
    path.join(__dirname, "gtfs", name)
  ];

  for (const file of locations) {
    if (fs.existsSync(file)) {
      return file;
    }
  }

  return null;
}

/* =====================================================
   LOCAL GTFS
===================================================== */

function loadLocalGTFS() {
  const stopsFile =
    localFile("stops.txt");

  const routesFile =
    localFile("routes.txt");

  const tripsFile =
    localFile("trips.txt");

  const stopTimesFile =
    localFile("stop_times.txt");

  if (
    !stopsFile ||
    !routesFile ||
    !tripsFile ||
    !stopTimesFile
  ) {
    return false;
  }

  try {
    resetDatabase();

    const stopsText =
      fs.readFileSync(
        stopsFile,
        "utf8"
      );

    const routesText =
      fs.readFileSync(
        routesFile,
        "utf8"
      );

    const tripsText =
      fs.readFileSync(
        tripsFile,
        "utf8"
      );

    const stopTimesText =
      fs.readFileSync(
        stopTimesFile,
        "utf8"
      );

    buildDatabase(
      stopsText,
      routesText,
      tripsText,
      stopTimesText
    );

    STATE.ready =
      DB.stops.size > 0;

    STATE.source =
      "official-local-gtfs";

    STATE.lastUpdate =
      new Date().toISOString();

    STATE.error = null;

    console.log(
      "Yerel resmî GTFS kullanılıyor."
    );

    return STATE.ready;
  } catch (error) {
    console.error(
      "Yerel GTFS hatası:",
      error.message
    );

    return false;
  }
}

/* =====================================================
   DATABASE OLUŞTUR
===================================================== */

function buildDatabase(
  stopsText,
  routesText,
  tripsText,
  stopTimesText
) {
  resetDatabase();

  /* STOPS */

  for (
    const item
    of parseCSV(stopsText)
  ) {
    const id =
      clean(item.stop_id);

    const lat =
      validNumber(item.stop_lat);

    const lon =
      validNumber(item.stop_lon);

    if (
      !id ||
      lat === null ||
      lon === null
    ) {
      continue;
    }

    DB.stops.set(
      id,
      {
        id,

        name:
          clean(
            item.stop_name
          ) || id,

        code:
          clean(
            item.stop_code
          ) || null,

        lat,
        lon
      }
    );
  }

  /* ROUTES */

  for (
    const item
    of parseCSV(routesText)
  ) {
    const id =
      clean(item.route_id);

    if (!id) continue;

    DB.routes.set(
      id,
      {
        id,

        shortName:
          clean(
            item.route_short_name
          ) || id,

        longName:
          clean(
            item.route_long_name
          ),

        type:
          clean(
            item.route_type
          )
      }
    );
  }

  /* TRIPS */

  for (
    const item
    of parseCSV(tripsText)
  ) {
    const id =
      clean(item.trip_id);

    if (!id) continue;

    const trip = {
      id,

      routeId:
        clean(item.route_id),

      serviceId:
        clean(item.service_id),

      headsign:
        clean(
          item.trip_headsign
        )
    };

    DB.trips.set(
      id,
      trip
    );

    if (
      !DB.routeTrips.has(
        trip.routeId
      )
    ) {
      DB.routeTrips.set(
        trip.routeId,
        []
      );
    }

    DB.routeTrips
      .get(trip.routeId)
      .push(trip);
  }

  /* STOP TIMES */

  let count = 0;

  for (
    const item
    of parseCSV(stopTimesText)
  ) {
    const tripId =
      clean(item.trip_id);

    const stopId =
      clean(item.stop_id);

    if (
      !tripId ||
      !stopId
    ) {
      continue;
    }

    const stopTime = {
      tripId,
      stopId,

      sequence:
        Number(
          item.stop_sequence
        ) || 0,

      arrival:
        gtfsTime(
          item.arrival_time
        ),

      departure:
        gtfsTime(
          item.departure_time
        )
    };

    if (
      !DB.stopTimes.has(
        tripId
      )
    ) {
      DB.stopTimes.set(
        tripId,
        []
      );
    }

    DB.stopTimes
      .get(tripId)
      .push(stopTime);

    if (
      !DB.stopRoutes.has(
        stopId
      )
    ) {
      DB.stopRoutes.set(
        stopId,
        new Set()
      );
    }

    const trip =
      DB.trips.get(tripId);

    if (trip) {
      DB.stopRoutes
        .get(stopId)
        .add(trip.routeId);
    }

    count++;
  }

  for (
    const list
    of DB.stopTimes.values()
  ) {
    list.sort(
      (a, b) =>
        a.sequence -
        b.sequence
    );
  }

  STATE.stats = {
    stops:
      DB.stops.size,

    routes:
      DB.routes.size,

    trips:
      DB.trips.size,

    stopTimes:
      count
  };
}

/* =====================================================
   API: HEALTH
===================================================== */

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      ok: true,

      service:
        "Konya Ulaşım Plus",

      ready:
        STATE.ready,

      loading:
        STATE.loading,

      source:
        STATE.source,

      error:
        STATE.error,

      stats:
        STATE.stats,

      lastUpdate:
        STATE.lastUpdate
    });
  }
);

/* =====================================================
   API: INFO
===================================================== */

app.get(
  "/api/app-info",
  (req, res) => {
    res.json({
      ok: true,

      name:
        "Konya Ulaşım Plus",

      version:
        "7.0.0",

      city:
        "Konya",

      official:
        true,

      sources:
        SOURCES,

      liveVehicleApi:
        false
    });
  }
);

/* =====================================================
   API: DATA STATUS
===================================================== */

app.get(
  "/api/data-status",
  (req, res) => {
    res.json({
      ok: true,

      ready:
        STATE.ready,

      loading:
        STATE.loading,

      source:
        STATE.source,

      error:
        STATE.error,

      stats:
        STATE.stats,

      lastUpdate:
        STATE.lastUpdate
    });
  }
);

/* =====================================================
   API: STOPS
===================================================== */

app.get(
  "/api/stops",
  (req, res) => {
    const q =
      clean(req.query.q)
        .toLocaleLowerCase(
          "tr-TR"
        );

    const limit =
      Math.min(
        Math.max(
          Number(
            req.query.limit
          ) || 100,
          1
        ),
        500
      );

    let stops =
      [...DB.stops.values()];

    if (q) {
      stops =
        stops.filter(
          stop =>
            `${stop.name} ${stop.code || ""}`
              .toLocaleLowerCase(
                "tr-TR"
              )
              .includes(q)
        );
    }

    res.json({
      ok: true,

      available:
        stops.length > 0,

      count:
        Math.min(
          stops.length,
          limit
        ),

      stops:
        stops.slice(
          0,
          limit
        )
    });
  }
);

/* =====================================================
   API: NEARBY
===================================================== */

app.get(
  "/api/stops/nearby",
  (req, res) => {
    const lat =
      Number(req.query.lat);

    const lon =
      Number(req.query.lon);

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      lat < -90 ||
      lat > 90 ||
      lon < -180 ||
      lon > 180
    ) {
      return res.json({
        ok: true,

        available:
          false,

        count: 0,

        stops: [],

        message:
          "Konum bilgisi alınamadı."
      });
    }

    const radius =
      Math.min(
        Math.max(
          Number(
            req.query.radius
          ) || 3000,
          100
        ),
        15000
      );

    const result = [];

    for (
      const stop
      of DB.stops.values()
    ) {
      const distance =
        distanceMeters(
          lat,
          lon,
          stop.lat,
          stop.lon
        );

      if (
        distance <= radius
      ) {
        result.push({
          ...stop,

          distance:
            Math.round(
              distance
            ),

          walkingMinutes:
            Math.max(
              1,
              Math.ceil(
                distance / 80
              )
            )
        });
      }
    }

    result.sort(
      (a, b) =>
        a.distance -
        b.distance
    );

    res.json({
      ok: true,

      available:
        result.length > 0,

      count:
        result.length,

      stops:
        result.slice(
          0,
          100
        )
    });
  }
);

/* =====================================================
   API: STOP DETAIL
===================================================== */

app.get(
  "/api/stops/:stopId",
  (req, res) => {
    const stop =
      DB.stops.get(
        req.params.stopId
      );

    if (!stop) {
      return res.json({
        ok: true,

        found:
          false,

        stop:
          null,

        routes:
          []
      });
    }

    const routeIds =
      [
        ...(
          DB.stopRoutes.get(
            stop.id
          ) || new Set()
        )
      ];

    const routes =
      routeIds
        .map(id =>
          DB.routes.get(id)
        )
        .filter(Boolean);

    res.json({
      ok: true,

      found:
        true,

      stop,

      routes
    });
  }
);

/* =====================================================
   API: ROUTES
===================================================== */

app.get(
  "/api/routes",
  (req, res) => {
    const q =
      clean(req.query.q)
        .toLocaleLowerCase(
          "tr-TR"
        );

    let routes =
      [...DB.routes.values()];

    if (q) {
      routes =
        routes.filter(
          route =>
            `${route.shortName} ${route.longName}`
              .toLocaleLowerCase(
                "tr-TR"
              )
              .includes(q)
        );
    }

    res.json({
      ok: true,

      count:
        routes.length,

      routes
    });
  }
);

/* =====================================================
   API: ROUTE DETAIL
===================================================== */

app.get(
  "/api/routes/:routeId",
  (req, res) => {
    const route =
      DB.routes.get(
        req.params.routeId
      );

    if (!route) {
      return res.json({
        ok: true,

        found:
          false,

        route:
          null,

        trips:
          []
      });
    }

    res.json({
      ok: true,

      found:
        true,

      route,

      trips:
        DB.routeTrips.get(
          route.id
        ) || []
    });
  }
);

/* =====================================================
   API: JOURNEY
===================================================== */

app.get(
  "/api/journey/calculate",
  (req, res) => {
    const from =
      clean(req.query.from);

    const to =
      clean(req.query.to);

    if (!from || !to) {
      return res.json({
        ok: true,

        available:
          false,

        journeys:
          [],

        message:
          "Başlangıç ve hedef seçilmedi."
      });
    }

    const fromStop =
      DB.stops.get(from);

    const toStop =
      DB.stops.get(to);

    if (
      !fromStop ||
      !toStop
    ) {
      return res.json({
        ok: true,

        available:
          false,

        journeys:
          [],

        message:
          "Durak bulunamadı."
      });
    }

    const fromRoutes =
      DB.stopRoutes.get(from) ||
      new Set();

    const toRoutes =
      DB.stopRoutes.get(to) ||
      new Set();

    const commonRoutes =
      [
        ...fromRoutes
      ].filter(
        id =>
          toRoutes.has(id)
      );

    const now =
      konyaSeconds();

    const journeys = [];

    for (
      const routeId
      of commonRoutes
    ) {
      const trips =
        DB.routeTrips.get(
          routeId
        ) || [];

      for (
        const trip
        of trips
      ) {
        const times =
          DB.stopTimes.get(
            trip.id
          ) || [];

        const start =
          times.find(
            x =>
              x.stopId ===
              from
          );

        const finish =
          times.find(
            x =>
              x.stopId ===
              to
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

        let waiting =
          departure - now;

        if (waiting < 0) {
          waiting += 86400;
        }

        let ride =
          arrival -
          departure;

        if (ride < 0) {
          ride += 86400;
        }

        journeys.push({
          route:
            DB.routes.get(
              routeId
            ),

          routeId,

          tripId:
            trip.id,

          headsign:
            trip.headsign,

          departure:
            formatTime(
              departure
            ),

          arrival:
            formatTime(
              arrival
            ),

          waitingMinutes:
            Math.round(
              waiting / 60
            ),

          rideMinutes:
            Math.round(
              ride / 60
            ),

          transferCount:
            0
        });
      }
    }

    journeys.sort(
      (a, b) =>
        a.waitingMinutes -
        b.waitingMinutes
    );

    res.json({
      ok: true,

      available:
        journeys.length > 0,

      from:
        fromStop,

      to:
        toStop,

      journeys:
        journeys.slice(
          0,
          20
        )
    });
  }
);

/* =====================================================
   API: LIVE
===================================================== */

app.get(
  "/api/live/:stopId",
  (req, res) => {
    res.json({
      ok: true,

      available:
        false,

      live:
        false,

      stopId:
        req.params.stopId,

      message:
        "Canlı araç verisi için doğrulanmış resmî API bağlantısı bulunmuyor."
    });
  }
);

/* =====================================================
   FRONTEND
===================================================== */

app.get(
  "/",
  (req, res) => {
    const index =
      path.join(
        __dirname,
        "index.html"
      );

    if (
      fs.existsSync(index)
    ) {
      return res.sendFile(
        index
      );
    }

    res.json({
      ok: true,

      name:
        "Konya Ulaşım Plus",

      message:
        "Sunucu çalışıyor.",

      api:
        "/api/health"
    });
  }
);

app.use(
  express.static(
    __dirname
  )
);

/* =====================================================
   404
===================================================== */

app.use(
  (req, res) => {
    res.status(404).json({
      ok: false,

      error:
        "Endpoint bulunamadı."
    });
  }
);

/* =====================================================
   ERROR
===================================================== */

app.use(
  (err, req, res, next) => {
    console.error(
      "SERVER ERROR:",
      err
    );

    res.status(500).json({
      ok: false,

      error:
        "Sunucu hatası."
    });
  }
);

/* =====================================================
   START
===================================================== */

app.listen(
  PORT,
  HOST,
  () => {
    console.log(
      "================================"
    );

    console.log(
      " KONYA ULAŞIM PLUS"
    );

    console.log(
      ` PORT: ${PORT}`
    );

    console.log(
      "================================"
    );

    /*
      Öncelik yerel resmî GTFS.
      Böylece Render'ın dışarıdaki
      sunucuya erişememesi uygulamayı
      bozmaz.
    */

    const loaded =
      loadLocalGTFS();

    if (!loaded) {
      STATE.ready = false;

      STATE.source =
        "waiting-for-official-data";

      STATE.error =
        null;

      console.log(
        "Yerel GTFS bulunamadı."
      );

      console.log(
        "Sunucu çalışıyor; veri kaynağı hazır olduğunda yüklenecek."
      );
    }
  }
);

/* =====================================================
   OTOMATİK YENİLEME
===================================================== */

setInterval(
  () => {
    if (!STATE.loading) {
      loadLocalGTFS();
    }
  },
  30 * 60 * 1000
);
