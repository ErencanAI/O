import express from "express";
import cors from "cors";
import AdmZip from "adm-zip";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";

const CKAN_API =
  "https://acikveri.konya.bel.tr/api/3/action/package_search";

const GTFS_SEARCH =
  "Toplu Taşıma GTFS Verileri";

const REFRESH_INTERVAL =
  6 * 60 * 60 * 1000;

const WALKING_SPEED =
  80;

const MAX_NEARBY =
  50;

const db = {
  ready: false,
  loading: false,
  error: null,
  loadedAt: null,

  stops: new Map(),
  routes: new Map(),
  trips: new Map(),
  stopTimes: new Map(),
  tripsByStop: new Map(),
  routesByStop: new Map(),
  tripsByRoute: new Map(),
  sequences: new Map(),

  calendar: new Map(),
  calendarDates: new Map()
};

/* =====================================================
   EXPRESS
===================================================== */

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
  })
);

app.use(
  express.json({
    limit: "2mb"
  })
);

app.use(
  express.urlencoded({
    extended: true
  })
);

app.use(
  express.static(__dirname)
);

/* =====================================================
   YARDIMCI FONKSİYONLAR
===================================================== */

function clean(value) {
  return String(value ?? "").trim();
}

function normalize(value) {
  return clean(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("tr-TR");
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseTime(value) {
  if (!value) return null;

  const parts = clean(value).split(":");

  if (parts.length !== 3) {
    return null;
  }

  const h = Number(parts[0]);
  const m = Number(parts[1]);
  const s = Number(parts[2]);

  if (
    !Number.isFinite(h) ||
    !Number.isFinite(m) ||
    !Number.isFinite(s)
  ) {
    return null;
  }

  return h * 3600 + m * 60 + s;
}

function clock(seconds) {
  if (!Number.isFinite(seconds)) {
    return null;
  }

  const total =
    ((Math.round(seconds) % 86400) + 86400) %
    86400;

  const h =
    Math.floor(total / 3600);

  const m =
    Math.floor((total % 3600) / 60);

  return (
    String(h).padStart(2, "0") +
    ":" +
    String(m).padStart(2, "0")
  );
}

function nowKonyaSeconds() {
  const parts =
    new Intl.DateTimeFormat(
      "en-GB",
      {
        timeZone: "Europe/Istanbul",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23"
      }
    ).formatToParts(new Date());

  const get = type =>
    Number(
      parts.find(
        p => p.type === type
      )?.value || 0
    );

  return (
    get("hour") * 3600 +
    get("minute") * 60 +
    get("second")
  );
}

function todayKonya() {
  const parts =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone: "Europe/Istanbul",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        weekday: "short"
      }
    ).formatToParts(new Date());

  const get = type =>
    parts.find(
      p => p.type === type
    )?.value;

  const weekdays = {
    Sun: "sunday",
    Mon: "monday",
    Tue: "tuesday",
    Wed: "wednesday",
    Thu: "thursday",
    Fri: "friday",
    Sat: "saturday"
  };

  return {
    date:
      `${get("year")}${get("month")}${get("day")}`,

    weekday:
      weekdays[get("weekday")] ||
      "monday"
  };
}

function distanceMeters(
  lat1,
  lon1,
  lat2,
  lon2
) {
  const a1 = number(lat1);
  const o1 = number(lon1);
  const a2 = number(lat2);
  const o2 = number(lon2);

  if (
    a1 === null ||
    o1 === null ||
    a2 === null ||
    o2 === null
  ) {
    return Infinity;
  }

  const R = 6371000;

  const dLat =
    (a2 - a1) *
    Math.PI /
    180;

  const dLon =
    (o2 - o1) *
    Math.PI /
    180;

  const r1 =
    a1 * Math.PI / 180;

  const r2 =
    a2 * Math.PI / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(r1) *
    Math.cos(r2) *
    Math.sin(dLon / 2) ** 2;

  return (
    2 *
    R *
    Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    )
  );
}

function walkingTime(meters) {
  if (!Number.isFinite(meters)) {
    return null;
  }

  return Math.max(
    1,
    Math.ceil(
      meters / WALKING_SPEED
    )
  );
}

/* =====================================================
   BASİT CSV PARSER
===================================================== */

function parseCSV(text) {
  const rows = [];

  let row = [];
  let value = "";
  let quote = false;

  for (
    let i = 0;
    i < text.length;
    i++
  ) {
    const c = text[i];

    if (c === '"') {
      if (
        quote &&
        text[i + 1] === '"'
      ) {
        value += '"';
        i++;
      } else {
        quote = !quote;
      }

      continue;
    }

    if (
      c === "," &&
      !quote
    ) {
      row.push(value);
      value = "";
      continue;
    }

    if (
      (c === "\n" ||
        c === "\r") &&
      !quote
    ) {
      if (
        c === "\r" &&
        text[i + 1] === "\n"
      ) {
        i++;
      }

      row.push(value);
      value = "";

      if (
        row.some(
          x => clean(x) !== ""
        )
      ) {
        rows.push(row);
      }

      row = [];
      continue;
    }

    value += c;
  }

  if (
    value.length ||
    row.length
  ) {
    row.push(value);

    if (
      row.some(
        x => clean(x) !== ""
      )
    ) {
      rows.push(row);
    }
  }

  if (!rows.length) {
    return [];
  }

  const headers =
    rows[0].map(
      x => clean(x).replace(/^\uFEFF/, "")
    );

  return rows.slice(1).map(values => {
    const item = {};

    headers.forEach(
      (header, index) => {
        item[header] =
          clean(values[index]);
      }
    );

    return item;
  });
}

/* =====================================================
   GTFS DOSYA OKUMA
===================================================== */

function getZipFile(
  zip,
  fileName
) {
  const wanted =
    fileName.toLowerCase();

  const entry =
    zip
      .getEntries()
      .find(entry =>
        entry.entryName
          .toLowerCase()
          .split("/")
          .pop() === wanted
      );

  if (!entry) {
    return [];
  }

  try {
    return parseCSV(
      entry
        .getData()
        .toString("utf8")
    );
  } catch (error) {
    console.error(
      `GTFS ${fileName} okunamadı`,
      error.message
    );

    return [];
  }
}

/* =====================================================
   CKAN GTFS BUL
===================================================== */

async function downloadGTFS() {
  const url =
    `${CKAN_API}?q=${encodeURIComponent(
      GTFS_SEARCH
    )}&rows=50`;

  const response =
    await fetch(url, {
      headers: {
        Accept:
          "application/json"
      },
      signal:
        AbortSignal.timeout(30000)
    });

  if (!response.ok) {
    throw new Error(
      `Konya açık veri HTTP ${response.status}`
    );
  }

  const json =
    await response.json();

  const datasets =
    json?.result?.results || [];

  if (!datasets.length) {
    throw new Error(
      "Konya GTFS veri seti bulunamadı."
    );
  }

  const dataset =
    datasets.find(item =>
      normalize(item.title)
        .includes(
          normalize(GTFS_SEARCH)
        )
    ) ||
    datasets[0];

  const resources =
    dataset.resources || [];

  const zipResource =
    resources.find(resource => {
      const name =
        normalize(resource.name);

      const format =
        normalize(resource.format);

      return (
        name.endsWith(".zip") ||
        format === "zip"
      );
    });

  if (!zipResource?.url) {
    throw new Error(
      "GTFS ZIP dosyası bulunamadı."
    );
  }

  console.log(
    "GTFS indiriliyor:",
    zipResource.url
  );

  const zipResponse =
    await fetch(
      zipResource.url,
      {
        signal:
          AbortSignal.timeout(120000)
      }
    );

  if (!zipResponse.ok) {
    throw new Error(
      `GTFS ZIP HTTP ${zipResponse.status}`
    );
  }

  const buffer =
    Buffer.from(
      await zipResponse.arrayBuffer()
    );

  return {
    zip:
      new AdmZip(buffer),

    title:
      dataset.title,

    resource:
      zipResource.url
  };
}

/* =====================================================
   DATABASE TEMİZLE
===================================================== */

function clearDB() {
  db.stops.clear();
  db.routes.clear();
  db.trips.clear();
  db.stopTimes.clear();
  db.tripsByStop.clear();
  db.routesByStop.clear();
  db.tripsByRoute.clear();
  db.sequences.clear();

  db.calendar.clear();
  db.calendarDates.clear();
}

/* =====================================================
   ARRAY MAP
===================================================== */

function pushMap(
  map,
  key,
  value
) {
  if (!map.has(key)) {
    map.set(key, []);
  }

  map.get(key).push(value);
}

/* =====================================================
   GTFS YÜKLE
===================================================== */

function loadGTFS(zip) {
  const stops =
    getZipFile(
      zip,
      "stops.txt"
    );

  const routes =
    getZipFile(
      zip,
      "routes.txt"
    );

  const trips =
    getZipFile(
      zip,
      "trips.txt"
    );

  const stopTimes =
    getZipFile(
      zip,
      "stop_times.txt"
    );

  const calendar =
    getZipFile(
      zip,
      "calendar.txt"
    );

  const calendarDates =
    getZipFile(
      zip,
      "calendar_dates.txt"
    );

  if (!stops.length) {
    throw new Error(
      "GTFS stops.txt bulunamadı."
    );
  }

  if (!routes.length) {
    throw new Error(
      "GTFS routes.txt bulunamadı."
    );
  }

  if (!trips.length) {
    throw new Error(
      "GTFS trips.txt bulunamadı."
    );
  }

  if (!stopTimes.length) {
    throw new Error(
      "GTFS stop_times.txt bulunamadı."
    );
  }

  clearDB();

  /* STOPS */

  for (const stop of stops) {
    const id =
      clean(stop.stop_id);

    const name =
      clean(stop.stop_name);

    const lat =
      number(stop.stop_lat);

    const lon =
      number(stop.stop_lon);

    if (
      !id ||
      !name ||
      lat === null ||
      lon === null
    ) {
      continue;
    }

    if (
      lat < -90 ||
      lat > 90 ||
      lon < -180 ||
      lon > 180
    ) {
      continue;
    }

    db.stops.set(
      id,
      {
        id,
        name,
        lat,
        lon,
        code:
          clean(stop.stop_code) ||
          null,
        search:
          normalize(name)
      }
    );
  }

  /* ROUTES */

  for (const route of routes) {
    const id =
      clean(route.route_id);

    if (!id) continue;

    db.routes.set(
      id,
      route
    );
  }

  /* TRIPS */

  for (const trip of trips) {
    const id =
      clean(trip.trip_id);

    if (!id) continue;

    db.trips.set(
      id,
      trip
    );

    pushMap(
      db.tripsByRoute,
      trip.route_id,
      id
    );
  }

  /* CALENDAR */

  for (const item of calendar) {
    if (!item.service_id) {
      continue;
    }

    db.calendar.set(
      item.service_id,
      item
    );
  }

  /* CALENDAR DATES */

  for (
    const item of calendarDates
  ) {
    if (
      !item.service_id ||
      !item.date
    ) {
      continue;
    }

    if (
      !db.calendarDates.has(
        item.service_id
      )
    ) {
      db.calendarDates.set(
        item.service_id,
        new Map()
      );
    }

    db.calendarDates
      .get(item.service_id)
      .set(
        item.date,
        item.exception_type
      );
  }

  /* STOP TIMES */

  for (
    const row of stopTimes
  ) {
    const tripId =
      clean(row.trip_id);

    const stopId =
      clean(row.stop_id);

    if (
      !tripId ||
      !stopId
    ) {
      continue;
    }

    if (
      !db.stops.has(stopId) ||
      !db.trips.has(tripId)
    ) {
      continue;
    }

    const item = {
      tripId,

      stopId,

      sequence:
        Number(row.stop_sequence) || 0,

      arrival:
        parseTime(row.arrival_time),

      departure:
        parseTime(
          row.departure_time
        )
    };

    if (
      item.arrival === null &&
      item.departure === null
    ) {
      continue;
    }

    pushMap(
      db.stopTimes,
      tripId,
      item
    );

    pushMap(
      db.tripsByStop,
      stopId,
      tripId
    );
  }

  /* SEQUENCE */

  for (
    const [tripId, rows]
    of db.stopTimes
  ) {
    rows.sort(
      (a, b) =>
        a.sequence - b.sequence
    );

    db.sequences.set(
      tripId,
      rows
    );
  }

  /* ROUTE -> STOP */

  for (
    const [tripId, sequence]
    of db.sequences
  ) {
    const trip =
      db.trips.get(tripId);

    if (!trip) continue;

    const routeId =
      trip.route_id;

    for (
      const row of sequence
    ) {
      pushMap(
        db.routesByStop,
        row.stopId,
        routeId
      );
    }
  }

  /* DUPLICATE TEMİZLE */

  for (
    const [key, values]
    of db.tripsByStop
  ) {
    db.tripsByStop.set(
      key,
      [...new Set(values)]
    );
  }

  for (
    const [key, values]
    of db.routesByStop
  ) {
    db.routesByStop.set(
      key,
      [...new Set(values)]
    );
  }

  for (
    const [key, values]
    of db.tripsByRoute
  ) {
    db.tripsByRoute.set(
      key,
      [...new Set(values)]
    );
  }

  db.ready = true;
  db.loadedAt = new Date();
  db.error = null;

  console.log(
    "================================="
  );

  console.log(
    "KONYA GTFS HAZIR"
  );

  console.log(
    "Durak:",
    db.stops.size
  );

  console.log(
    "Hat:",
    db.routes.size
  );

  console.log(
    "Sefer:",
    db.trips.size
  );

  console.log(
    "Durak zaman kaydı:",
    [...db.stopTimes.values()]
      .reduce(
        (sum, x) =>
          sum + x.length,
        0
      )
  );

  console.log(
    "================================="
  );
}

/* =====================================================
   REFRESH
===================================================== */

async function refresh() {
  if (db.loading) {
    return;
  }

  db.loading = true;

  try {
    console.log(
      "Konya GTFS güncelleniyor..."
    );

    const result =
      await downloadGTFS();

    loadGTFS(
      result.zip
    );

    console.log(
      "GTFS başarıyla güncellendi."
    );
  } catch (error) {
    console.error(
      "GTFS HATASI:",
      error
    );

    db.error =
      error?.message ||
      String(error);

    /*
      Daha önce çalışan veri varsa
      onu silmiyoruz.
    */
  } finally {
    db.loading = false;
  }
}

/* =====================================================
   REQUIRE DATA
===================================================== */

function requireData(res) {
  if (
    db.ready &&
    db.stops.size > 0
  ) {
    return true;
  }

  res.status(503).json({
    ok: false,

    ready: false,

    loading:
      db.loading,

    message:
      db.loading
        ? "Konya ulaşım verileri hazırlanıyor. Birkaç saniye sonra tekrar deneyin."
        : "Konya ulaşım verileri henüz yüklenemedi.",

    error:
      db.error || null
  });

  return false;
}

/* =====================================================
   STOP OBJECT
===================================================== */

function stopObject(stop) {
  if (!stop) {
    return null;
  }

  return {
    id: stop.id,
    stopId: stop.id,

    name: stop.name,
    stopName: stop.name,

    lat: stop.lat,
    lon: stop.lon,

    code: stop.code
  };
}

/* =====================================================
   ROUTE OBJECT
===================================================== */

function routeObject(routeId) {
  const route =
    db.routes.get(
      routeId
    );

  if (!route) {
    return null;
  }

  return {
    id:
      route.route_id,

    shortName:
      route.route_short_name ||
      "",

    longName:
      route.route_long_name ||
      "",

    color:
      route.route_color ||
      null,

    type:
      route.route_type ||
      null
  };
}

/* =====================================================
   NEARBY STOPS
===================================================== */

function nearbyStops(
  lat,
  lon,
  radius
) {
  const result = [];

  for (
    const stop
    of db.stops.values()
  ) {
    const distance =
      distanceMeters(
        lat,
        lon,
        stop.lat,
        stop.lon
      );

    if (
      !Number.isFinite(
        distance
      )
    ) {
      continue;
    }

    if (
      distance > radius
    ) {
      continue;
    }

    const routeIds =
      db.routesByStop.get(
        stop.id
      ) || [];

    const routes =
      [
        ...new Set(routeIds)
      ]
        .map(routeObject)
        .filter(Boolean);

    result.push({
      ...stopObject(stop),

      distanceMeters:
        Math.round(distance),

      distanceKm:
        Number(
          (
            distance / 1000
          ).toFixed(2)
        ),

      walkingMinutes:
        walkingTime(distance),

      routes,

      routeCount:
        routes.length
    });
  }

  result.sort(
    (a, b) =>
      a.distanceMeters -
      b.distanceMeters
  );

  return result.slice(
    0,
    MAX_NEARBY
  );
}

/* =====================================================
   HEALTH
===================================================== */

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      ok: true,

      service:
        "Konya Ulaşım Plus",

      ready:
        db.ready,

      loading:
        db.loading,

      loadedAt:
        db.loadedAt,

      error:
        db.error,

      timezone:
        "Europe/Istanbul",

      source:
        "Konya Büyükşehir Belediyesi Açık Veri Platformu",

      stats: {
        stops:
          db.stops.size,

        routes:
          db.routes.size,

        trips:
          db.trips.size,

        stopTimeRecords:
          [...db.stopTimes.values()]
            .reduce(
              (sum, x) =>
                sum + x.length,
              0
            )
      }
    });
  }
);

/* =====================================================
   STOPS SEARCH
===================================================== */

app.get(
  "/api/stops",
  (req, res) => {
    if (!requireData(res)) {
      return;
    }

    const query =
      normalize(
        req.query.q || ""
      );

    let limit =
      Number(
        req.query.limit
      );

    if (
      !Number.isFinite(limit)
    ) {
      limit = 100;
    }

    limit =
      Math.min(
        Math.max(
          Math.floor(limit),
          1
        ),
        500
      );

    let results =
      [...db.stops.values()];

    if (query) {
      results =
        results.filter(
          stop =>
            stop.search.includes(
              query
            )
        );
    }

    results =
      results
        .slice(0, limit)
        .map(stopObject);

    res.json({
      ok: true,

      count:
        results.length,

      stops:
        results
    });
  }
);

/* =====================================================
   NEARBY
===================================================== */

app.get(
  "/api/stops/nearby",
  (req, res) => {
    /*
      EN ÖNEMLİ BÖLÜM

      Frontend konum göndermese bile
      anlaşılır hata dönüyor.
    */

    if (!requireData(res)) {
      return;
    }

    const lat =
      number(
        req.query.lat
      );

    const lon =
      number(
        req.query.lon
      );

    let radius =
      number(
        req.query.radius
      );

    if (
      lat === null ||
      lon === null
    ) {
      return res.status(400).json({
        ok: false,

        error:
          "Konum bilgisi eksik.",

        detail:
          "lat ve lon parametreleri gereklidir.",

        example:
          "/api/stops/nearby?lat=37.8746&lon=32.4932&radius=2000"
      });
    }

    if (
      lat < -90 ||
      lat > 90 ||
      lon < -180 ||
      lon > 180
    ) {
      return res.status(400).json({
        ok: false,

        error:
          "Geçersiz koordinat."
      });
    }

    if (
      radius === null
    ) {
      radius = 2000;
    }

    radius =
      Math.min(
        Math.max(
          radius,
          100
        ),
        10000
      );

    let stops =
      nearbyStops(
        lat,
        lon,
        radius
      );

    /*
      2 km'de durak yoksa
      otomatik olarak alanı
      genişletiyoruz.
    */

    if (
      stops.length === 0 &&
      radius < 5000
    ) {
      stops =
        nearbyStops(
          lat,
          lon,
          5000
        );
    }

    res.json({
      ok: true,

      source:
        "Konya Büyükşehir Belediyesi GTFS",

      origin: {
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

/* =====================================================
   STOP DETAIL
===================================================== */

app.get(
  "/api/stops/:stopId",
  (req, res) => {
    if (!requireData(res)) {
      return;
    }

    const id =
      clean(
        req.params.stopId
      );

    const stop =
      db.stops.get(id);

    if (!stop) {
      return res.status(404).json({
        ok: false,

        error:
          "Durak bulunamadı."
      });
    }

    const routes =
      [
        ...new Set(
          db.routesByStop.get(
            id
          ) || []
        )
      ]
        .map(routeObject)
        .filter(Boolean);

    res.json({
      ok: true,

      stop:
        stopObject(stop),

      routes
    });
  }
);

/* =====================================================
   ROUTES
===================================================== */

app.get(
  "/api/routes",
  (req, res) => {
    if (!requireData(res)) {
      return;
    }

    const query =
      normalize(
        req.query.q || ""
      );

    let routes =
      [...db.routes.values()];

    if (query) {
      routes =
        routes.filter(
          route =>
            normalize(
              route.route_short_name
            ).includes(query) ||
            normalize(
              route.route_long_name
            ).includes(query)
        );
    }

    res.json({
      ok: true,

      count:
        routes.length,

      routes:
        routes
          .slice(0, 500)
          .map(route =>
            routeObject(
              route.route_id
            )
          )
          .filter(Boolean)
    });
  }
);

/* =====================================================
   ROUTE DETAIL
===================================================== */

app.get(
  "/api/routes/:routeId",
  (req, res) => {
    if (!requireData(res)) {
      return;
    }

    const routeId =
      clean(
        req.params.routeId
      );

    const route =
      routeObject(
        routeId
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
        routeId
      ) || [];

    const stopMap =
      new Map();

    for (
      const tripId
      of trips
    ) {
      const sequence =
        db.sequences.get(
          tripId
        ) || [];

      for (
        const row
        of sequence
      ) {
        const stop =
          db.stops.get(
            row.stopId
          );

        if (stop) {
          stopMap.set(
            stop.id,
            stopObject(stop)
          );
        }
      }
    }

    res.json({
      ok: true,

      route,

      stops:
        [...stopMap.values()]
    });
  }
);

/* =====================================================
   SERVICE ACTIVE
===================================================== */

function serviceActive(
  serviceId
) {
  if (!serviceId) {
    return true;
  }

  const today =
    todayKonya();

  const exceptions =
    db.calendarDates.get(
      serviceId
    );

  if (
    exceptions?.has(
      today.date
    )
  ) {
    return (
      exceptions.get(
        today.date
      ) === "1"
    );
  }

  const calendar =
    db.calendar.get(
      serviceId
    );

  if (!calendar) {
    return true;
  }

  if (
    today.date <
    calendar.start_date ||
    today.date >
    calendar.end_date
  ) {
    return false;
  }

  return (
    calendar[today.weekday] === "1"
  );
}

/* =====================================================
   DIRECT JOURNEY
===================================================== */

function directJourneys(
  originId,
  destinationId,
  now
) {
  const tripIds =
    db.tripsByStop.get(
      originId
    ) || [];

  const result = [];

  for (
    const tripId
    of tripIds
  ) {
    const trip =
      db.trips.get(
        tripId
      );

    if (!trip) continue;

    if (
      !serviceActive(
        trip.service_id
      )
    ) {
      continue;
    }

    const sequence =
      db.sequences.get(
        tripId
      ) || [];

    const fromIndex =
      sequence.findIndex(
        row =>
          row.stopId ===
          originId
      );

    if (fromIndex < 0) {
      continue;
    }

    const from =
      sequence[fromIndex];

    let to = null;

    for (
      let i =
        fromIndex + 1;
      i <
      sequence.length;
      i++
    ) {
      if (
        sequence[i].stopId ===
        destinationId
      ) {
        to =
          sequence[i];

        break;
      }
    }

    if (!to) {
      continue;
    }

    const departure =
      from.departure ??
      from.arrival;

    const arrival =
      to.arrival ??
      to.departure;

    if (
      departure === null ||
      arrival === null
    ) {
      continue;
    }

    if (
      departure < now
    ) {
      continue;
    }

    const wait =
      Math.ceil(
        (departure - now) /
        60
      );

    const ride =
      Math.max(
        0,
        Math.ceil(
          (arrival -
            departure) /
            60
        )
      );

    result.push({
      type:
        "direct",

      transfers:
        0,

      route:
        routeObject(
          trip.route_id
        ),

      tripId,

      departureTime:
        clock(departure),

      arrivalTime:
        clock(arrival),

      waitMinutes:
        wait,

      rideMinutes:
        ride,

      totalTransitMinutes:
        wait + ride,

      from:
        stopObject(
          db.stops.get(
            originId
          )
        ),

      to:
        stopObject(
          db.stops.get(
            destinationId
          )
        )
    });
  }

  return result;
}

/* =====================================================
   JOURNEY API
===================================================== */

app.post(
  "/api/journey/calculate",
  (req, res) => {
    if (!requireData(res)) {
      return;
    }

    const body =
      req.body || {};

    const origin =
      body.origin || {};

    const destination =
      body.destination || {};

    let originId =
      clean(
        origin.stopId
      );

    let destinationId =
      clean(
        destination.stopId
      );

    /*
      GPS -> EN YAKIN DURAK
    */

    if (
      !originId &&
      number(origin.lat) !== null &&
      number(origin.lon) !== null
    ) {
      const nearest =
        nearbyStops(
          number(origin.lat),
          number(origin.lon),
          5000
        );

      originId =
        nearest[0]?.id || "";
    }

    /*
      DESTINATION STOP ID YOKSA
      İSİMDEN BUL
    */

    if (
      !destinationId &&
      destination.name
    ) {
      const query =
        normalize(
          destination.name
        );

      const exact =
        [...db.stops.values()]
          .find(
            stop =>
              stop.search ===
              query
          );

      const partial =
        exact ||
        [...db.stops.values()]
          .find(
            stop =>
              stop.search.includes(
                query
              )
          );

      destinationId =
        partial?.id || "";
    }

    if (!originId) {
      return res.status(400).json({
        ok: false,

        error:
          "Başlangıç durağı bulunamadı."
      });
    }

    if (!destinationId) {
      return res.status(400).json({
        ok: false,

        error:
          "Varış durağı bulunamadı."
      });
    }

    const originStop =
      db.stops.get(
        originId
      );

    const destinationStop =
      db.stops.get(
        destinationId
      );

    if (
      !originStop ||
      !destinationStop
    ) {
      return res.status(404).json({
        ok: false,

        error:
          "Durak bilgisi bulunamadı."
      });
    }

    const now =
      nowKonyaSeconds();

    const direct =
      directJourneys(
        originId,
        destinationId,
        now
      );

    let walkingMeters =
      number(
        origin.walkingMeters
      );

    if (
      walkingMeters === null &&
      number(origin.lat) !== null &&
      number(origin.lon) !== null
    ) {
      walkingMeters =
        distanceMeters(
          origin.lat,
          origin.lon,
          originStop.lat,
          originStop.lon
        );
    }

    if (
      walkingMeters === null
    ) {
      walkingMeters = 0;
    }

    const walkMinutes =
      walkingTime(
        walkingMeters
      ) || 0;

    const journeys =
      direct.map(item => ({
        ...item,

        walkingMeters:
          Math.round(
            walkingMeters
          ),

        walkingMinutes:
          walkMinutes,

        totalDurationMinutes:
          walkMinutes +
          item.totalTransitMinutes
      }));

    journeys.sort(
      (a, b) =>
        a.totalDurationMinutes -
        b.totalDurationMinutes
    );

    res.json({
      ok: true,

      generatedAt:
        new Date().toISOString(),

      timezone:
        "Europe/Istanbul",

      currentTime:
        clock(now),

      origin: {
        stop:
          stopObject(
            originStop
          ),

        walkingMeters:
          Math.round(
            walkingMeters
          ),

        walkingMinutes:
          walkMinutes
      },

      destination: {
        stop:
          stopObject(
            destinationStop
          )
      },

      journeys:
        journeys.slice(
          0,
          20
        ),

      count:
        journeys.length,

      note:
        journeys.length
          ? null
          : "Şu an için doğrudan uygun tarifeli sefer bulunamadı."
    });
  }
);

/* =====================================================
   LIVE
===================================================== */

app.get(
  "/api/live/:stopId",
  (req, res) => {
    if (!requireData(res)) {
      return;
    }

    const stop =
      db.stops.get(
        clean(
          req.params.stopId
        )
      );

    if (!stop) {
      return res.status(404).json({
        ok: false,

        error:
          "Durak bulunamadı."
      });
    }

    /*
      SAHTE CANLI VERİ YOK.
    */

    res.json({
      ok: true,

      liveAvailable:
        false,

      stop:
        stopObject(stop),

      vehicles: [],

      arrivals: [],

      message:
        "Doğrulanmış ATUS canlı araç API'si bağlanmadan sahte araç konumu gösterilmiyor.",

      updatedAt:
        new Date().toISOString(),

      officialSource:
        "ATUS Otobüsüm Nerede"
    });
  }
);

/* =====================================================
   APP INFO
===================================================== */

app.get(
  "/api/app-info",
  (req, res) => {
    res.json({
      ok: true,

      name:
        "Konya Ulaşım Plus",

      version:
        "5.0.0",

      city:
        "Konya",

      timezone:
        "Europe/Istanbul",

      data:
        "Konya Büyükşehir Belediyesi Açık Veri / GTFS",

      features: [
        "GPS konumu",
        "Yakındaki gerçek duraklar",
        "Durak arama",
        "Hat arama",
        "Gerçek GTFS seferleri",
        "Yürüme mesafesi",
        "Yürüme süresi",
        "Bekleme süresi",
        "Tahmini varış",
        "Rota analizi",
        "Aktarmalı rota altyapısı",
        "Numune Hastanesi referansı"
      ]
    });
  }
);

/* =====================================================
   API 404
===================================================== */

app.use(
  "/api",
  (req, res) => {
    res.status(404).json({
      ok: false,

      error:
        "API adresi bulunamadı.",

      path:
        req.originalUrl
    });
  }
);

/* =====================================================
   FRONTEND FALLBACK
===================================================== */

app.get(
  "*splat",
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "index.html"
      )
    );
  }
);

/* =====================================================
   GLOBAL ERROR
===================================================== */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      "GLOBAL SERVER ERROR:",
      error
    );

    if (
      res.headersSent
    ) {
      return next(error);
    }

    res.status(500).json({
      ok: false,

      error:
        "Sunucu hatası.",

      detail:
        error?.message ||
        "Bilinmeyen hata"
    });
  }
);

/* =====================================================
   SERVER
===================================================== */

app.listen(
  PORT,
  HOST,
  async () => {
    console.log("");
    console.log(
      "========================================"
    );
    console.log(
      " KONYA ULAŞIM PLUS"
    );
    console.log(
      " Server başlatıldı"
    );
    console.log(
      ` Port: ${PORT}`
    );
    console.log(
      " Timezone: Europe/Istanbul"
    );
    console.log(
      "========================================"
    );
    console.log("");

    await refresh();

    setInterval(
      refresh,
      REFRESH_INTERVAL
    );
  }
);
