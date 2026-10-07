import express from "express";
import cors from "cors";
import AdmZip from "adm-zip";

const app = express();

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";

const CKAN_API =
  process.env.CKAN_API ||
  "https://acikveri.konya.bel.tr/api/3/action";

const DATASET_ID =
  process.env.GTFS_DATASET_ID ||
  "toplu-tasima-gtfs-verileri";

const REFRESH_MS =
  6 * 60 * 60 * 1000;

const FETCH_TIMEOUT =
  60_000;

const WALKING_SPEED_M_PER_MIN =
  80;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

/* =========================================================
   DATABASE
========================================================= */

let db = {
  ready: false,
  loading: false,
  error: null,

  lastAttempt: null,
  lastSuccessfulLoad: null,

  sourceUrl: null,
  sourceName: "Konya Büyükşehir Belediyesi Açık Veri",

  stops: new Map(),
  routes: new Map(),
  trips: new Map(),
  stopTimes: new Map(),
  tripsByStop: new Map(),
  routesByStop: new Map(),
  tripsByRoute: new Map(),

  services: new Map(),
  calendarDates: new Map(),

  stats: {
    stops: 0,
    routes: 0,
    trips: 0,
    stopTimes: 0,
    services: 0
  }
};

/* =========================================================
   GENERAL HELPERS
========================================================= */

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeTurkish(value) {
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

function validNumber(value) {
  const n = Number(value);
  return Number.isFinite(n);
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;

  const p1 = Number(lat1) * Math.PI / 180;
  const p2 = Number(lat2) * Math.PI / 180;

  const dp =
    (Number(lat2) - Number(lat1)) *
    Math.PI / 180;

  const dl =
    (Number(lon2) - Number(lon1)) *
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

function walkingMinutes(meters) {
  return Math.max(
    1,
    Math.ceil(
      Number(meters) /
      WALKING_SPEED_M_PER_MIN
    )
  );
}

function parseGtfsTime(value) {
  const parts =
    clean(value).split(":");

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

function formatClock(seconds) {
  if (!Number.isFinite(seconds)) {
    return "--:--";
  }

  const total =
    ((Math.floor(seconds) % 86400) + 86400) %
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

function durationMinutes(
  start,
  end
) {
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end)
  ) {
    return null;
  }

  return Math.max(
    0,
    Math.ceil(
      (end - start) / 60
    )
  );
}

/* =========================================================
   KONYA LOCAL TIME
========================================================= */

function konyaNow() {
  const parts =
    new Intl.DateTimeFormat(
      "en-GB",
      {
        timeZone:
          "Europe/Istanbul",
        hour12: false,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        weekday: "short"
      }
    ).formatToParts(
      new Date()
    );

  const get =
    type =>
      parts.find(
        p => p.type === type
      )?.value;

  const hour =
    Number(get("hour"));

  const minute =
    Number(get("minute"));

  const second =
    Number(get("second"));

  const weekday =
    get("weekday");

  const weekdayMap = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7
  };

  return {
    hour,
    minute,
    second,
    seconds:
      hour * 3600 +
      minute * 60 +
      second,
    weekday:
      weekdayMap[weekday] || 1
  };
}

/* =========================================================
   CSV PARSER
========================================================= */

function parseCSV(text) {
  text =
    String(text ?? "")
      .replace(/^\uFEFF/, "");

  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (
    let i = 0;
    i < text.length;
    i++
  ) {
    const char =
      text[i];

    if (char === '"') {
      if (
        quoted &&
        text[i + 1] === '"'
      ) {
        field += '"';
        i++;
      } else {
        quoted = !quoted;
      }

      continue;
    }

    if (
      char === "," &&
      !quoted
    ) {
      row.push(field);
      field = "";
      continue;
    }

    if (
      (char === "\n" ||
       char === "\r") &&
      !quoted
    ) {
      if (
        char === "\r" &&
        text[i + 1] === "\n"
      ) {
        i++;
      }

      row.push(field);
      field = "";

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

    field += char;
  }

  if (
    field.length ||
    row.length
  ) {
    row.push(field);

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
      h =>
        clean(h)
          .replace(/^\uFEFF/, "")
    );

  return rows
    .slice(1)
    .map(values => {
      const object = {};

      headers.forEach(
        (header, index) => {
          object[header] =
            values[index] ?? "";
        }
      );

      return object;
    });
}

/* =========================================================
   FETCH
========================================================= */

async function fetchBuffer(
  url
) {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      FETCH_TIMEOUT
    );

  try {
    const response =
      await fetch(
        url,
        {
          signal:
            controller.signal,
          headers: {
            "User-Agent":
              "Konya-Ulasim-Plus/5.0"
          }
        }
      );

    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} - ${response.statusText}`
      );
    }

    const arrayBuffer =
      await response.arrayBuffer();

    return Buffer.from(
      arrayBuffer
    );

  } finally {
    clearTimeout(
      timeout
    );
  }
}

/* =========================================================
   FIND GTFS RESOURCE
========================================================= */

async function findGtfsUrl() {
  const url =
    `${CKAN_API}/package_show?id=${encodeURIComponent(DATASET_ID)}`;

  const response =
    await fetch(
      url,
      {
        headers: {
          "User-Agent":
            "Konya-Ulasim-Plus/5.0"
        }
      }
    );

  if (!response.ok) {
    throw new Error(
      `CKAN API HTTP ${response.status}`
    );
  }

  const json =
    await response.json();

  if (
    !json?.success ||
    !json?.result
  ) {
    throw new Error(
      "Konya Açık Veri API veri setini döndürmedi."
    );
  }

  const resources =
    Array.isArray(
      json.result.resources
    )
      ? json.result.resources
      : [];

  const candidates =
    resources.filter(
      resource => {
        const format =
          clean(
            resource.format
          ).toLowerCase();

        const name =
          clean(
            resource.name
          ).toLowerCase();

        const url =
          clean(
            resource.url
          ).toLowerCase();

        return (
          format === "zip" ||
          name.endsWith(".zip") ||
          url.endsWith(".zip")
        );
      }
    );

  if (!candidates.length) {
    throw new Error(
      "GTFS ZIP kaynağı bulunamadı."
    );
  }

  const resource =
    candidates[0];

  return {
    url: resource.url,
    name:
      resource.name ||
      "Toplu Taşıma GTFS Verileri"
  };
}

/* =========================================================
   ZIP HELPERS
========================================================= */

function findZipEntry(
  zip,
  filename
) {
  const wanted =
    filename.toLowerCase();

  const entries =
    zip.getEntries();

  return (
    entries.find(
      entry =>
        !entry.isDirectory &&
        entry.entryName
          .split("/")
          .pop()
          .toLowerCase() ===
          wanted
    ) ||
    null
  );
}

function readZipCSV(
  zip,
  filename,
  required = true
) {
  const entry =
    findZipEntry(
      zip,
      filename
    );

  if (!entry) {
    if (required) {
      throw new Error(
        `GTFS içinde ${filename} bulunamadı.`
      );
    }

    return [];
  }

  const buffer =
    entry.getData();

  return parseCSV(
    buffer.toString("utf8")
  );
}

/* =========================================================
   SERVICE CHECK
========================================================= */

function buildServices(
  calendarRows,
  calendarDateRows
) {
  const services =
    new Map();

  for (
    const row of calendarRows
  ) {
    services.set(
      clean(row.service_id),
      {
        serviceId:
          clean(row.service_id),

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
          clean(row.sunday) === "1",

        exceptions: new Map()
      }
    );
  }

  for (
    const row of calendarDateRows
  ) {
    const serviceId =
      clean(row.service_id);

    if (!serviceId) {
      continue;
    }

    if (
      !services.has(serviceId)
    ) {
      services.set(
        serviceId,
        {
          serviceId,
          startDate: "",
          endDate: "",
          exceptions:
            new Map()
        }
      );
    }

    services
      .get(serviceId)
      .exceptions.set(
        clean(row.date),
        Number(
          row.exception_type
        )
      );
  }

  return services;
}

function serviceRunsToday(
  service,
  now = konyaNow()
) {
  if (!service) {
    return true;
  }

  const date =
    new Intl.DateTimeFormat(
      "en-CA",
      {
        timeZone:
          "Europe/Istanbul"
      }
    ).format(
      new Date()
    ).replaceAll("-", "");

  const exception =
    service.exceptions?.get(
      date
    );

  if (exception === 2) {
    return false;
  }

  if (exception === 1) {
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

  const flags = {
    1: service.monday,
    2: service.tuesday,
    3: service.wednesday,
    4: service.thursday,
    5: service.friday,
    6: service.saturday,
    7: service.sunday
  };

  return flags[now.weekday] !== false;
}

/* =========================================================
   LOAD GTFS
========================================================= */

async function loadGtfs() {
  if (db.loading) {
    return;
  }

  db.loading = true;
  db.error = null;
  db.lastAttempt =
    new Date().toISOString();

  console.log(
    "GTFS yükleniyor..."
  );

  try {
    const resource =
      await findGtfsUrl();

    console.log(
      "GTFS kaynağı:",
      resource.url
    );

    const buffer =
      await fetchBuffer(
        resource.url
      );

    console.log(
      "GTFS ZIP indirildi:",
      Math.round(
        buffer.length / 1024
      ),
      "KB"
    );

    const zip =
      new AdmZip(
        buffer
      );

    const stopsRows =
      readZipCSV(
        zip,
        "stops.txt",
        true
      );

    const routesRows =
      readZipCSV(
        zip,
        "routes.txt",
        true
      );

    const tripsRows =
      readZipCSV(
        zip,
        "trips.txt",
        true
      );

    const stopTimesRows =
      readZipCSV(
        zip,
        "stop_times.txt",
        true
      );

    const calendarRows =
      readZipCSV(
        zip,
        "calendar.txt",
        false
      );

    const calendarDateRows =
      readZipCSV(
        zip,
        "calendar_dates.txt",
        false
      );

    if (
      !stopsRows.length ||
      !routesRows.length ||
      !tripsRows.length ||
      !stopTimesRows.length
    ) {
      throw new Error(
        "GTFS dosyaları boş veya eksik."
      );
    }

    /* -----------------------------------------------
       NEW DATABASE
    ------------------------------------------------ */

    const next = {
      stops: new Map(),
      routes: new Map(),
      trips: new Map(),
      stopTimes: new Map(),
      tripsByStop: new Map(),
      routesByStop: new Map(),
      tripsByRoute: new Map(),
      services:
        buildServices(
          calendarRows,
          calendarDateRows
        ),
      calendarDates:
        new Map()
    };

    /* -----------------------------------------------
       STOPS
    ------------------------------------------------ */

    for (
      const row of stopsRows
    ) {
      const id =
        clean(row.stop_id);

      if (!id) {
        continue;
      }

      const lat =
        Number(
          row.stop_lat
        );

      const lon =
        Number(
          row.stop_lon
        );

      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon)
      ) {
        continue;
      }

      next.stops.set(
        id,
        {
          id,
          name:
            clean(
              row.stop_name
            ) ||
            id,

          code:
            clean(
              row.stop_code
            ),

          lat,
          lon,

          locationType:
            clean(
              row.location_type
            )
        }
      );
    }

    /* -----------------------------------------------
       ROUTES
    ------------------------------------------------ */

    for (
      const row of routesRows
    ) {
      const id =
        clean(row.route_id);

      if (!id) {
        continue;
      }

      next.routes.set(
        id,
        {
          id,

          shortName:
            clean(
              row.route_short_name
            ),

          longName:
            clean(
              row.route_long_name
            ),

          type:
            Number(
              row.route_type
            ) || 3
        }
      );
    }

    /* -----------------------------------------------
       TRIPS
    ------------------------------------------------ */

    for (
      const row of tripsRows
    ) {
      const id =
        clean(row.trip_id);

      if (!id) {
        continue;
      }

      const routeId =
        clean(row.route_id);

      const serviceId =
        clean(row.service_id);

      const trip = {
        id,
        routeId,
        serviceId,

        headsign:
          clean(
            row.trip_headsign
          ),

        directionId:
          clean(
            row.direction_id
          ),

        stopTimes: []
      };

      next.trips.set(
        id,
        trip
      );

      if (
        !next.tripsByRoute.has(
          routeId
        )
      ) {
        next.tripsByRoute.set(
          routeId,
          new Set()
        );
      }

      next.tripsByRoute
        .get(routeId)
        .add(id);
    }

    /* -----------------------------------------------
       STOP TIMES
    ------------------------------------------------ */

    for (
      const row of stopTimesRows
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
        !next.trips.has(
          tripId
        )
      ) {
        continue;
      }

      const arrival =
        parseGtfsTime(
          row.arrival_time
        );

      const departure =
        parseGtfsTime(
          row.departure_time
        );

      if (
        arrival === null &&
        departure === null
      ) {
        continue;
      }

      const stopSequence =
        Number(
          row.stop_sequence
        );

      const item = {
        tripId,

        stopId,

        arrival:
          arrival ??
          departure,

        departure:
          departure ??
          arrival,

        stopSequence:
          Number.isFinite(
            stopSequence
          )
            ? stopSequence
            : 0,

        pickupType:
          clean(
            row.pickup_type
          ),

        dropOffType:
          clean(
            row.drop_off_type
          )
      };

      if (
        !next.stopTimes.has(
          tripId
        )
      ) {
        next.stopTimes.set(
          tripId,
          []
        );
      }

      next.stopTimes
        .get(tripId)
        .push(item);

      next.trips
        .get(tripId)
        .stopTimes
        .push(item);

      if (
        !next.tripsByStop.has(
          stopId
        )
      ) {
        next.tripsByStop.set(
          stopId,
          new Set()
        );
      }

      next.tripsByStop
        .get(stopId)
        .add(tripId);
    }

    /* -----------------------------------------------
       SORT TRIP STOP TIMES
    ------------------------------------------------ */

    for (
      const trip of next.trips.values()
    ) {
      trip.stopTimes.sort(
        (a, b) =>
          a.stopSequence -
          b.stopSequence
      );
    }

    /* -----------------------------------------------
       ROUTES BY STOP
    ------------------------------------------------ */

    for (
      const [
        tripId,
        trip
      ] of next.trips
    ) {
      const route =
        next.routes.get(
          trip.routeId
        );

      if (!route) {
        continue;
      }

      for (
        const stopTime of
        trip.stopTimes
      ) {
        const stopId =
          stopTime.stopId;

        if (
          !next.routesByStop.has(
            stopId
          )
        ) {
          next.routesByStop.set(
            stopId,
            new Set()
          );
        }

        next.routesByStop
          .get(stopId)
          .add(
            route.id
          );
      }
    }

    /* -----------------------------------------------
       VALIDATION
    ------------------------------------------------ */

    if (
      next.stops.size === 0
    ) {
      throw new Error(
        "Hiç durak yüklenemedi."
      );
    }

    if (
      next.routes.size === 0
    ) {
      throw new Error(
        "Hiç hat yüklenemedi."
      );
    }

    if (
      next.trips.size === 0
    ) {
      throw new Error(
        "Hiç sefer yüklenemedi."
      );
    }

    if (
      next.stopTimes.size === 0
    ) {
      throw new Error(
        "Hiç durak-sefer eşleşmesi yüklenemedi."
      );
    }

    /* -----------------------------------------------
       ATOMIC SWAP
    ------------------------------------------------ */

    db.stops =
      next.stops;

    db.routes =
      next.routes;

    db.trips =
      next.trips;

    db.stopTimes =
      next.stopTimes;

    db.tripsByStop =
      next.tripsByStop;

    db.routesByStop =
      next.routesByStop;

    db.tripsByRoute =
      next.tripsByRoute;

    db.services =
      next.services;

    db.calendarDates =
      next.calendarDates;

    db.stats = {
      stops:
        db.stops.size,

      routes:
        db.routes.size,

      trips:
        db.trips.size,

      stopTimes:
        stopTimesRows.length,

      services:
        db.services.size
    };

    db.sourceUrl =
      resource.url;

    db.sourceName =
      resource.name;

    db.lastSuccessfulLoad =
      new Date().toISOString();

    db.ready = true;
    db.error = null;

    console.log(
      "GTFS başarıyla hazırlandı:",
      db.stats
    );

  } catch (error) {

    console.error(
      "GTFS yükleme hatası:",
      error
    );

    db.error =
      error?.message ||
      "GTFS yüklenemedi.";

    /*
      Eski veri varsa silme.
      Böylece yenileme sırasında
      uygulama boş kalmaz.
    */

    if (
      db.stops.size === 0
    ) {
      db.ready = false;
    }

  } finally {
    db.loading = false;
  }
}

/* =========================================================
   API READY CHECK
========================================================= */

function requireReady(
  res
) {
  if (db.ready) {
    return true;
  }

  res.status(503).json({
    ok: false,
    ready: false,
    loading: db.loading,

    error:
      db.loading
        ? "Ulaşım verileri hazırlanıyor..."
        : (
            db.error ||
            "Ulaşım verileri henüz hazır değil."
          )
  });

  return false;
}

/* =========================================================
   HEALTH
========================================================= */

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      ok: true,

      ready:
        db.ready,

      loading:
        db.loading,

      error:
        db.error,

      lastAttempt:
        db.lastAttempt,

      lastSuccessfulLoad:
        db.lastSuccessfulLoad,

      source: {
        name:
          db.sourceName,

        url:
          db.sourceUrl
      },

      stats:
        db.stats
    });
  }
);

/* =========================================================
   APP INFO
========================================================= */

app.get(
  "/api/app-info",
  (req, res) => {
    res.json({
      name:
        "Konya Ulaşım Plus",

      version:
        "5.0.0",

      dataSource:
        "Konya Büyükşehir Belediyesi Açık Veri Platformu",

      gtfs:
        true,

      liveVehicleApi:
        false,

      ready:
        db.ready,

      stats:
        db.stats
    });
  }
);

/* =========================================================
   STOPS
========================================================= */

app.get(
  "/api/stops",
  (req, res) => {
    if (!requireReady(res)) {
      return;
    }

    const q =
      normalizeTurkish(
        req.query.q
      );

    const limitRaw =
      Number(
        req.query.limit
      );

    const limit =
      Math.min(
        100,
        Math.max(
          1,
          Number.isFinite(limitRaw)
            ? limitRaw
            : 20
        )
      );

    let results = [];

    for (
      const stop of
      db.stops.values()
    ) {
      if (
        q &&
        !normalizeTurkish(
          stop.name
        ).includes(q)
      ) {
        continue;
      }

      const routeIds =
        db.routesByStop.get(
          stop.id
        ) || new Set();

      const routes =
        [...routeIds]
          .map(
            id =>
              db.routes.get(id)
          )
          .filter(Boolean)
          .slice(0, 10)
          .map(route => ({
            id: route.id,
            shortName:
              route.shortName,
            longName:
              route.longName
          }));

      results.push({
        ...stop,
        routes
      });

      if (
        results.length >=
        limit
      ) {
        break;
      }
    }

    res.json({
      ok: true,
      count:
        results.length,
      stops:
        results
    });
  }
);

/* =========================================================
   NEARBY STOPS
========================================================= */

app.get(
  "/api/stops/nearby",
  (req, res) => {
    if (!requireReady(res)) {
      return;
    }

    const lat =
      Number(
        req.query.lat
      );

    const lon =
      Number(
        req.query.lon
      );

    const radiusRaw =
      Number(
        req.query.radius
      );

    const radius =
      Math.min(
        10000,
        Math.max(
          100,
          Number.isFinite(radiusRaw)
            ? radiusRaw
            : 3000
        )
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
          "Geçersiz konum."
      });
    }

    const results = [];

    for (
      const stop of
      db.stops.values()
    ) {
      const distance =
        haversine(
          lat,
          lon,
          stop.lat,
          stop.lon
        );

      if (
        distance > radius
      ) {
        continue;
      }

      const routeIds =
        db.routesByStop.get(
          stop.id
        ) || new Set();

      const routes =
        [...routeIds]
          .map(
            id =>
              db.routes.get(id)
          )
          .filter(Boolean)
          .slice(0, 8)
          .map(route => ({
            id: route.id,
            shortName:
              route.shortName,
            longName:
              route.longName
          }));

      results.push({
        ...stop,

        distanceMeters:
          Math.round(distance),

        distanceKm:
          Number(
            (
              distance / 1000
            ).toFixed(2)
          ),

        walkingMinutes:
          walkingMinutes(
            distance
          ),

        routes
      });
    }

    results.sort(
      (a, b) =>
        a.distanceMeters -
        b.distanceMeters
    );

    res.json({
      ok: true,

      origin: {
        lat,
        lon
      },

      radius,

      count:
        results.length,

      stops:
        results.slice(0, 50)
    });
  }
);

/* =========================================================
   SINGLE STOP
========================================================= */

app.get(
  "/api/stops/:stopId",
  (req, res) => {
    if (!requireReady(res)) {
      return;
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
      db.routesByStop.get(
        stop.id
      ) || new Set();

    const routes =
      [...routeIds]
        .map(
          id =>
            db.routes.get(id)
        )
        .filter(Boolean)
        .map(route => ({
          id: route.id,
          shortName:
            route.shortName,
          longName:
            route.longName
        }));

    res.json({
      ok: true,

      stop: {
        ...stop,
        routes
      }
    });
  }
);

/* =========================================================
   ROUTES
========================================================= */

app.get(
  "/api/routes",
  (req, res) => {
    if (!requireReady(res)) {
      return;
    }

    const routes =
      [...db.routes.values()]
        .map(route => ({
          id: route.id,
          shortName:
            route.shortName,
          longName:
            route.longName
        }));

    res.json({
      ok: true,
      count:
        routes.length,
      routes
    });
  }
);

/* =========================================================
   ROUTE DETAIL
========================================================= */

app.get(
  "/api/routes/:routeId",
  (req, res) => {
    if (!requireReady(res)) {
      return;
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

    const stopsMap =
      new Map();

    for (
      const tripId of tripIds
    ) {
      const trip =
        db.trips.get(
          tripId
        );

      if (!trip) {
        continue;
      }

      for (
        const st of
        trip.stopTimes
      ) {
        if (
          !stopsMap.has(
            st.stopId
          )
        ) {
          const stop =
            db.stops.get(
              st.stopId
            );

          if (stop) {
            stopsMap.set(
              st.stopId,
              {
                ...stop,
                sequence:
                  st.stopSequence
              }
            );
          }
        }
      }

      if (
        stopsMap.size > 300
      ) {
        break;
      }
    }

    const stops =
      [...stopsMap.values()]
        .sort(
          (a, b) =>
            a.sequence -
            b.sequence
        );

    res.json({
      ok: true,

      route: {
        ...route,

        stops
      }
    });
  }
);

/* =========================================================
   TRIP AFTER DEPARTURE
========================================================= */

function getNextDeparture(
  stopId,
  earliestSeconds,
  allowedRouteIds = null
) {
  const tripIds =
    db.tripsByStop.get(
      stopId
    );

  if (!tripIds) {
    return null;
  }

  let best =
    null;

  for (
    const tripId of tripIds
  ) {
    const trip =
      db.trips.get(
        tripId
      );

    if (!trip) {
      continue;
    }

    if (
      allowedRouteIds &&
      !allowedRouteIds.has(
        trip.routeId
      )
    ) {
      continue;
    }

    const service =
      db.services.get(
        trip.serviceId
      );

    if (
      service &&
      !serviceRunsToday(
        service
      )
    ) {
      continue;
    }

    const stopTime =
      trip.stopTimes.find(
        st =>
          st.stopId ===
          stopId
      );

    if (!stopTime) {
      continue;
    }

    const departure =
      stopTime.departure;

    if (
      departure <
      earliestSeconds
    ) {
      continue;
    }

    if (
      !best ||
      departure <
      best.departure
    ) {
      best = {
        trip,
        stopTime,
        departure
      };
    }
  }

  return best;
}

/* =========================================================
   DIRECT JOURNEY
========================================================= */

function findDirectJourneys(
  boardingStop,
  destinationStop,
  earliestSeconds,
  maxResults = 6
) {
  const tripIds =
    db.tripsByStop.get(
      boardingStop.id
    );

  if (!tripIds) {
    return [];
  }

  const results = [];

  for (
    const tripId of tripIds
  ) {
    const trip =
      db.trips.get(
        tripId
      );

    if (!trip) {
      continue;
    }

    const service =
      db.services.get(
        trip.serviceId
      );

    if (
      service &&
      !serviceRunsToday(
        service
      )
    ) {
      continue;
    }

    const boardIndex =
      trip.stopTimes.findIndex(
        st =>
          st.stopId ===
          boardingStop.id
      );

    if (
      boardIndex < 0
    ) {
      continue;
    }

    const destinationIndex =
      trip.stopTimes.findIndex(
        (st, index) =>
          index > boardIndex &&
          st.stopId ===
          destinationStop.id
      );

    if (
      destinationIndex < 0
    ) {
      continue;
    }

    const boardTime =
      trip.stopTimes[
        boardIndex
      ];

    const arrivalTime =
      trip.stopTimes[
        destinationIndex
      ];

    if (
      boardTime.departure <
      earliestSeconds
    ) {
      continue;
    }

    const route =
      db.routes.get(
        trip.routeId
      );

    if (!route) {
      continue;
    }

    results.push({
      trip,
      route,
      boardTime,
      arrivalTime
    });
  }

  results.sort(
    (a, b) =>
      a.boardTime.departure -
      b.boardTime.departure
  );

  return results.slice(
    0,
    maxResults
  );
}

/* =========================================================
   JOURNEY CALCULATE
========================================================= */

app.post(
  "/api/journey/calculate",
  (req, res) => {
    if (!requireReady(res)) {
      return;
    }

    const body =
      req.body || {};

    const origin =
      body.origin || {};

    const destination =
      body.destination || {};

    const lat =
      Number(
        origin.lat
      );

    const lon =
      Number(
        origin.lon
      );

    const destinationId =
      clean(
        destination.stopId
      );

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon)
    ) {
      return res.status(400).json({
        ok: false,
        error:
          "Başlangıç konumu geçersiz."
      });
    }

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

    /* -----------------------------------------------
       NEAREST BOARDING STOPS
    ------------------------------------------------ */

    const nearby = [];

    for (
      const stop of
      db.stops.values()
    ) {
      if (
        stop.id ===
        destinationStop.id
      ) {
        continue;
      }

      const distance =
        haversine(
          lat,
          lon,
          stop.lat,
          stop.lon
        );

      if (
        distance > 3000
      ) {
        continue;
      }

      const routeIds =
        db.routesByStop.get(
          stop.id
        );

      if (
        !routeIds ||
        routeIds.size === 0
      ) {
        continue;
      }

      nearby.push({
        stop,
        distance,
        walkingMinutes:
          walkingMinutes(
            distance
          )
      });
    }

    nearby.sort(
      (a, b) =>
        a.distance -
        b.distance
    );

    const boardingStops =
      nearby.slice(
        0,
        20
      );

    const now =
      konyaNow();

    const journeys = [];

    /* -----------------------------------------------
       DIRECT ROUTES
    ------------------------------------------------ */

    for (
      const boarding of
      boardingStops
    ) {
      const earliest =
        now.seconds +
        boarding.walkingMinutes *
          60;

      const direct =
        findDirectJourneys(
          boarding.stop,
          destinationStop,
          earliest,
          4
        );

      for (
        const item of direct
      ) {
        const waitSeconds =
          Math.max(
            0,
            item.boardTime.departure -
            earliest
          );

        const waitMinutes =
          Math.ceil(
            waitSeconds / 60
          );

        const rideMinutes =
          durationMinutes(
            item.boardTime.departure,
            item.arrivalTime.arrival
          );

        const total =
          boarding.walkingMinutes +
          waitMinutes +
          (rideMinutes || 0);

        journeys.push({
          route: {
            id:
              item.route.id,

            shortName:
              item.route.shortName,

            longName:
              item.route.longName
          },

          departureTime:
            formatClock(
              item.boardTime.departure
            ),

          arrivalTime:
            formatClock(
              item.arrivalTime.arrival
            ),

          walkingMinutes:
            boarding.walkingMinutes,

          waitMinutes,

          rideMinutes,

          totalDurationMinutes:
            total,

          transfers: 0,

          from: {
            name:
              boarding.stop.name,
            id:
              boarding.stop.id
          },

          to: {
            name:
              destinationStop.name,
            id:
              destinationStop.id
          },

          boardingStop: {
            id:
              boarding.stop.id,
            name:
              boarding.stop.name,
            distanceMeters:
              Math.round(
                boarding.distance
              )
          },

          liveAvailable:
            false,

          scheduledAvailable:
            true
        });
      }
    }

    /* -----------------------------------------------
       DEDUPLICATE
    ------------------------------------------------ */

    const seen =
      new Set();

    const unique =
      journeys.filter(
        journey => {
          const key =
            [
              journey.route.id,
              journey.departureTime,
              journey.arrivalTime,
              journey.boardingStop.id
            ].join("|");

          if (
            seen.has(key)
          ) {
            return false;
          }

          seen.add(key);

          return true;
        }
      );

    /* -----------------------------------------------
       SORT
    ------------------------------------------------ */

    unique.sort(
      (a, b) => {

        if (
          a.totalDurationMinutes !==
          b.totalDurationMinutes
        ) {
          return (
            a.totalDurationMinutes -
            b.totalDurationMinutes
          );
        }

        if (
          a.transfers !==
          b.transfers
        ) {
          return (
            a.transfers -
            b.transfers
          );
        }

        return (
          a.walkingMinutes -
          b.walkingMinutes
        );
      }
    );

    res.json({
      ok: true,

      liveAvailable:
        false,

      liveMessage:
        "Gerçek zamanlı araç konumu için doğrulanmış ATUS API bağlantısı bulunmadığından yalnızca resmî GTFS programı kullanılıyor.",

      scheduledAvailable:
        true,

      destination: {
        id:
          destinationStop.id,

        name:
          destinationStop.name
      },

      journeys:
        unique.slice(
          0,
          12
        )
    });
  }
);

/* =========================================================
   LIVE
========================================================= */

app.get(
  "/api/live/:stopId",
  (req, res) => {
    if (!requireReady(res)) {
      return;
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

    res.json({
      ok: true,

      available:
        false,

      stop: {
        id:
          stop.id,

        name:
          stop.name
      },

      message:
        "Bu sunucuda doğrulanmış gerçek zamanlı araç API'si kullanılmıyor. Programlı GTFS verisi kullanılabilir."
    });
  }
);

/* =========================================================
   STATIC FRONTEND
========================================================= */

app.use(
  express.static(
    process.cwd(),
    {
      extensions: ["html"]
    }
  )
);

/*
  Express 5'te app.get("*")
  kullanmıyoruz.
*/

app.use(
  (req, res) => {

    if (
      req.method === "GET" &&
      !req.path.startsWith(
        "/api/"
      )
    ) {
      return res.sendFile(
        process.cwd() +
        "/index.html"
      );
    }

    res.status(404).json({
      ok: false,
      error:
        "Endpoint bulunamadı."
    });
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
      "Sunucu hatası:",
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
        "Sunucu tarafında beklenmeyen bir hata oluştu."
    });
  }
);

/* =========================================================
   START
========================================================= */

const server =
  app.listen(
    PORT,
    HOST,
    () => {

      console.log(
        "======================================"
      );

      console.log(
        "Konya Ulaşım Plus"
      );

      console.log(
        `Server: http://${HOST}:${PORT}`
      );

      console.log(
        "GTFS: yükleniyor..."
      );

      console.log(
        "======================================"
      );

      loadGtfs();
    }
  );

/* =========================================================
   REFRESH
========================================================= */

setInterval(
  () => {
    loadGtfs();
  },
  REFRESH_MS
);

/* =========================================================
   PROCESS ERRORS
========================================================= */

process.on(
  "unhandledRejection",
  error => {
    console.error(
      "Unhandled rejection:",
      error
    );
  }
);

process.on(
  "uncaughtException",
  error => {
    console.error(
      "Uncaught exception:",
      error
    );
  }
);

/* =========================================================
   SHUTDOWN
========================================================= */

function shutdown(
  signal
) {
  console.log(
    `${signal} alındı. Server kapatılıyor...`
  );

  server.close(
    () => {
      process.exit(0);
    }
  );

  setTimeout(
    () => {
      process.exit(1);
    },
    10000
  );
}

process.on(
  "SIGTERM",
  () =>
    shutdown("SIGTERM")
);

process.on(
  "SIGINT",
  () =>
    shutdown("SIGINT")
);
