import express from "express";
import cors from "cors";
import AdmZip from "adm-zip";

const app = express();

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";

const GTFS_URL =
  "https://acikveri.konya.bel.tr/dataset/c2e034e6-e015-49c6-8eec-6e2f7de9c105/resource/ec944ecd-1c1f-4687-a7f6-fcf2dc5bb5db/download/gtfs_11_2025.zip";

const REFRESH_MS =
  6 * 60 * 60 * 1000;

const FETCH_TIMEOUT =
  120000;

const WALK_SPEED =
  80;

const db = {
  ready: false,
  loading: false,
  error: null,

  source: {
    name: "Konya Büyükşehir Belediyesi Açık Veri",
    url: GTFS_URL,
    date: "10 Kasım 2025",
    type: "GTFS"
  },

  loadedAt: null,

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
   YARDIMCI FONKSİYONLAR
========================================================= */

function clean(v) {
  return String(v ?? "")
    .replace(/^\uFEFF/, "")
    .trim();
}

function normalize(v) {
  return clean(v)
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

function toNumber(v) {
  const n = Number(
    String(v ?? "").replace(",", ".")
  );

  return Number.isFinite(n)
    ? n
    : null;
}

function haversine(
  lat1,
  lon1,
  lat2,
  lon2
) {
  const R = 6371000;

  const p1 =
    Number(lat1) *
    Math.PI /
    180;

  const p2 =
    Number(lat2) *
    Math.PI /
    180;

  const dp =
    (Number(lat2) -
      Number(lat1)) *
    Math.PI /
    180;

  const dl =
    (Number(lon2) -
      Number(lon1)) *
    Math.PI /
    180;

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
      meters / WALK_SPEED
    )
  );
}

function distanceText(meters) {
  if (meters < 1000) {
    return `${Math.round(meters)} m`;
  }

  return `${(
    meters / 1000
  ).toFixed(1)} km`;
}

function parseTime(value) {
  const s = clean(value);

  if (!s) return null;

  const p =
    s.split(":").map(Number);

  if (
    p.length !== 3 ||
    p.some(x => !Number.isFinite(x))
  ) {
    return null;
  }

  return (
    p[0] * 3600 +
    p[1] * 60 +
    p[2]
  );
}

function clock(seconds) {
  if (seconds == null) {
    return "--:--";
  }

  const total =
    ((seconds % 86400) +
      86400) %
    86400;

  const h =
    Math.floor(
      total / 3600
    );

  const m =
    Math.floor(
      (total % 3600) / 60
    );

  return (
    String(h).padStart(2, "0") +
    ":" +
    String(m).padStart(2, "0")
  );
}

function nowTurkey() {
  const parts =
    new Intl.DateTimeFormat(
      "en-GB",
      {
        timeZone:
          "Europe/Istanbul",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23"
      }
    ).formatToParts(
      new Date()
    );

  const o = {};

  for (const p of parts) {
    if (p.type !== "literal") {
      o[p.type] = p.value;
    }
  }

  return (
    Number(o.hour) * 3600 +
    Number(o.minute) * 60 +
    Number(o.second)
  );
}

function todayTurkey() {
  const parts =
    new Intl.DateTimeFormat(
      "en-GB",
      {
        timeZone:
          "Europe/Istanbul",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }
    ).formatToParts(
      new Date()
    );

  const o = {};

  for (const p of parts) {
    if (p.type !== "literal") {
      o[p.type] = p.value;
    }
  }

  return {
    year: Number(o.year),
    month: Number(o.month),
    day: Number(o.day),

    date:
      `${o.year}${o.month}${o.day}`
  };
}

/* =========================================================
   CSV
========================================================= */

function parseCSV(text) {
  const rows = [];

  let row = [];
  let field = "";
  let quoted = false;

  for (
    let i = 0;
    i < text.length;
    i++
  ) {
    const c = text[i];

    if (quoted) {
      if (c === '"') {
        if (
          text[i + 1] === '"'
        ) {
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

      if (
        row.some(
          x => clean(x) !== ""
        )
      ) {
        rows.push(row);
      }

      row = [];
    } else if (c !== "\r") {
      field += c;
    }
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
    rows[0].map(clean);

  return rows
    .slice(1)
    .map(values => {
      const obj = {};

      for (
        let i = 0;
        i < headers.length;
        i++
      ) {
        obj[headers[i]] =
          clean(
            values[i] ?? ""
          );
      }

      return obj;
    });
}

/* =========================================================
   DOĞRUDAN RESMÎ GTFS İNDİR
========================================================= */

async function downloadGTFS() {
  console.log(
    "Resmî GTFS indiriliyor..."
  );

  console.log(
    GTFS_URL
  );

  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () =>
        controller.abort(),
      FETCH_TIMEOUT
    );

  try {
    const response =
      await fetch(
        GTFS_URL,
        {
          method: "GET",
          redirect: "follow",
          signal:
            controller.signal,

          headers: {
            "User-Agent":
              "Konya-Ulasim-Plus/1.0",
            "Accept":
              "application/zip,application/octet-stream,*/*"
          }
        }
      );

    const buffer =
      Buffer.from(
        await response.arrayBuffer()
      );

    console.log(
      "HTTP:",
      response.status
    );

    console.log(
      "Boyut:",
      `${(
        buffer.length /
        1024 /
        1024
      ).toFixed(2)} MB`
    );

    if (!response.ok) {
      throw new Error(
        `Resmî GTFS indirme HTTP ${response.status} ${response.statusText}`
      );
    }

    if (
      buffer.length < 100
    ) {
      throw new Error(
        "Resmî GTFS cevabı boş veya geçersiz."
      );
    }

    /*
     * ZIP imzası:
     * PK
     */
    if (
      buffer[0] !== 0x50 ||
      buffer[1] !== 0x4b
    ) {
      const preview =
        buffer
          .toString("utf8")
          .slice(0, 300)
          .replace(/\s+/g, " ");

      throw new Error(
        "Sunucu ZIP yerine başka bir içerik döndürdü." +
        (preview
          ? ` Cevap: ${preview}`
          : "")
      );
    }

    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

/* =========================================================
   ZIP OKUMA
========================================================= */

function findEntry(
  zip,
  filename
) {
  const wanted =
    filename.toLowerCase();

  return zip
    .getEntries()
    .find(entry => {
      const name =
        entry.entryName
          .replaceAll(
            "\\",
            "/"
          )
          .split("/")
          .pop()
          .toLowerCase();

      return (
        name === wanted
      );
    });
}

function readGTFSFile(
  zip,
  filename,
  required = true
) {
  const entry =
    findEntry(
      zip,
      filename
    );

  if (!entry) {
    if (required) {
      throw new Error(
        `${filename} GTFS ZIP içinde bulunamadı.`
      );
    }

    return null;
  }

  return entry
    .getData()
    .toString("utf8");
}

/* =========================================================
   MAP ARRAY
========================================================= */

function pushMap(
  map,
  key,
  value
) {
  if (!map.has(key)) {
    map.set(
      key,
      []
    );
  }

  map
    .get(key)
    .push(value);
}

/* =========================================================
   GTFS VERİTABANI OLUŞTUR
========================================================= */

function buildDatabase(
  buffer
) {
  const zip =
    new AdmZip(buffer);

  const stopsText =
    readGTFSFile(
      zip,
      "stops.txt"
    );

  const routesText =
    readGTFSFile(
      zip,
      "routes.txt"
    );

  const tripsText =
    readGTFSFile(
      zip,
      "trips.txt"
    );

  const stopTimesText =
    readGTFSFile(
      zip,
      "stop_times.txt"
    );

  const calendarText =
    readGTFSFile(
      zip,
      "calendar.txt",
      false
    );

  const calendarDatesText =
    readGTFSFile(
      zip,
      "calendar_dates.txt",
      false
    );

  const stopsRows =
    parseCSV(
      stopsText
    );

  const routesRows =
    parseCSV(
      routesText
    );

  const tripsRows =
    parseCSV(
      tripsText
    );

  const stopTimesRows =
    parseCSV(
      stopTimesText
    );

  const calendarRows =
    calendarText
      ? parseCSV(
          calendarText
        )
      : [];

  const calendarDatesRows =
    calendarDatesText
      ? parseCSV(
          calendarDatesText
        )
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

  /* DURAKLAR */

  for (
    const row of stopsRows
  ) {
    const id =
      clean(row.stop_id);

    if (!id) continue;

    const lat =
      toNumber(
        row.stop_lat
      );

    const lon =
      toNumber(
        row.stop_lon
      );

    if (
      lat == null ||
      lon == null
    ) {
      continue;
    }

    const stop = {
      id,

      name:
        clean(
          row.stop_name
        ) || id,

      code:
        clean(
          row.stop_code
        ),

      lat,
      lon,

      parentStation:
        clean(
          row.parent_station
        )
    };

    stop.search =
      normalize(
        `${stop.name} ${stop.code}`
      );

    next.stops.set(
      id,
      stop
    );
  }

  /* HATLAR */

  for (
    const row of routesRows
  ) {
    const id =
      clean(row.route_id);

    if (!id) continue;

    const route = {
      id,

      shortName:
        clean(
          row.route_short_name
        ) || id,

      longName:
        clean(
          row.route_long_name
        ),

      type:
        clean(
          row.route_type
        ),

      color:
        clean(
          row.route_color
        ),

      textColor:
        clean(
          row.route_text_color
        )
    };

    route.search =
      normalize(
        `${route.shortName} ${route.longName}`
      );

    next.routes.set(
      id,
      route
    );
  }

  /* SEFERLER */

  for (
    const row of tripsRows
  ) {
    const id =
      clean(row.trip_id);

    if (!id) continue;

    const trip = {
      id,

      routeId:
        clean(
          row.route_id
        ),

      serviceId:
        clean(
          row.service_id
        ),

      headsign:
        clean(
          row.trip_headsign
        ),

      directionId:
        clean(
          row.direction_id
        )
    };

    next.trips.set(
      id,
      trip
    );

    pushMap(
      next.tripsByRoute,
      trip.routeId,
      trip
    );
  }

  /* TAKVİM */

  for (
    const row of calendarRows
  ) {
    const id =
      clean(
        row.service_id
      );

    if (!id) continue;

    next.services.set(
      id,
      {
        start:
          clean(
            row.start_date
          ),

        end:
          clean(
            row.end_date
          ),

        monday:
          row.monday === "1",

        tuesday:
          row.tuesday === "1",

        wednesday:
          row.wednesday === "1",

        thursday:
          row.thursday === "1",

        friday:
          row.friday === "1",

        saturday:
          row.saturday === "1",

        sunday:
          row.sunday === "1"
      }
    );
  }

  /* TAKVİM İSTİSNALARI */

  for (
    const row of calendarDatesRows
  ) {
    const serviceId =
      clean(
        row.service_id
      );

    const date =
      clean(row.date);

    if (
      !serviceId ||
      !date
    ) {
      continue;
    }

    pushMap(
      next.calendarDates,
      serviceId,
      {
        date,

        exception:
          clean(
            row.exception_type
          )
      }
    );
  }

  /* DURAK-ZAMAN */

  for (
    const row of stopTimesRows
  ) {
    const tripId =
      clean(
        row.trip_id
      );

    const stopId =
      clean(
        row.stop_id
      );

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

    if (
      !next.stops.has(
        stopId
      )
    ) {
      continue;
    }

    const arrival =
      parseTime(
        row.arrival_time
      );

    const departure =
      parseTime(
        row.departure_time
      );

    if (
      arrival == null &&
      departure == null
    ) {
      continue;
    }

    const st = {
      tripId,
      stopId,

      arrival:
        arrival ??
        departure,

      departure:
        departure ??
        arrival,

      sequence:
        Number(
          row.stop_sequence
        ) || 0
    };

    next.stopTimes.push(
      st
    );

    pushMap(
      next.tripsByStop,
      stopId,
      st
    );
  }

  /* DURAK -> HATLAR */

  for (
    const [
      stopId,
      stopTimes
    ] of next.tripsByStop
  ) {
    const ids =
      new Set();

    for (
      const st of stopTimes
    ) {
      const trip =
        next.trips.get(
          st.tripId
        );

      if (
        trip?.routeId
      ) {
        ids.add(
          trip.routeId
        );
      }
    }

    next.routesByStop.set(
      stopId,
      [...ids]
    );
  }

  /* KONTROLLER */

  if (
    next.stops.size === 0
  ) {
    throw new Error(
      "GTFS yüklendi fakat geçerli durak bulunamadı."
    );
  }

  if (
    next.routes.size === 0
  ) {
    throw new Error(
      "GTFS yüklendi fakat hat bulunamadı."
    );
  }

  if (
    next.trips.size === 0
  ) {
    throw new Error(
      "GTFS yüklendi fakat sefer bulunamadı."
    );
  }

  if (
    next.stopTimes.length === 0
  ) {
    throw new Error(
      "GTFS yüklendi fakat stop_times verisi bulunamadı."
    );
  }

  return next;
}

/* =========================================================
   VERİYİ YÜKLE
========================================================= */

async function loadGTFS() {
  if (db.loading) {
    return;
  }

  db.loading = true;
  db.error = null;

  console.log(
    "===================================="
  );

  console.log(
    "🚌 KONYA ULAŞIM PLUS"
  );

  console.log(
    "GTFS yükleniyor..."
  );

  try {
    const buffer =
      await downloadGTFS();

    const data =
      buildDatabase(
        buffer
      );

    /*
     * Başarılı veri hazırlandıktan sonra
     * mevcut veriyi değiştiriyoruz.
     */
    db.stops =
      data.stops;

    db.routes =
      data.routes;

    db.trips =
      data.trips;

    db.stopTimes =
      data.stopTimes;

    db.tripsByStop =
      data.tripsByStop;

    db.routesByStop =
      data.routesByStop;

    db.tripsByRoute =
      data.tripsByRoute;

    db.services =
      data.services;

    db.calendarDates =
      data.calendarDates;

    db.stats = {
      stops:
        db.stops.size,

      routes:
        db.routes.size,

      trips:
        db.trips.size,

      stopTimes:
        db.stopTimes.length
    };

    db.loadedAt =
      new Date().toISOString();

    db.ready = true;
    db.error = null;

    console.log(
      "✅ GTFS BAŞARIYLA YÜKLENDİ"
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

  } catch (error) {
    db.error =
      error?.message ||
      String(error);

    /*
     * Daha önce başarılı veri varsa
     * onu koruyoruz.
     */
    if (
      db.stats.stops === 0
    ) {
      db.ready = false;
    }

    console.error(
      "❌ GTFS HATASI:",
      db.error
    );

  } finally {
    db.loading = false;

    console.log(
      "===================================="
    );
  }
}

/* =========================================================
   SERVİS GÜNÜ
========================================================= */

function serviceRunsToday(
  serviceId
) {
  const today =
    todayTurkey();

  const exceptions =
    db.calendarDates.get(
      serviceId
    ) || [];

  const exception =
    exceptions.find(
      x =>
        x.date ===
        today.date
    );

  if (exception) {
    if (
      exception.exception ===
      "1"
    ) {
      return true;
    }

    if (
      exception.exception ===
      "2"
    ) {
      return false;
    }
  }

  const service =
    db.services.get(
      serviceId
    );

  /*
   * Takvim yoksa seferi
   * otomatik olarak engellemiyoruz.
   */
  if (!service) {
    return true;
  }

  if (
    service.start &&
    today.date <
      service.start
  ) {
    return false;
  }

  if (
    service.end &&
    today.date >
      service.end
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

  const days = [
    service.sunday,
    service.monday,
    service.tuesday,
    service.wednesday,
    service.thursday,
    service.friday,
    service.saturday
  ];

  return Boolean(
    days[weekday]
  );
}

/* =========================================================
   SERIALIZE
========================================================= */

function stopJSON(
  stop
) {
  return {
    id: stop.id,
    name: stop.name,
    code: stop.code,
    lat: stop.lat,
    lon: stop.lon,
    parentStation:
      stop.parentStation
  };
}

function routeJSON(
  route
) {
  return {
    id: route.id,
    shortName:
      route.shortName,
    longName:
      route.longName,
    type:
      route.type,
    color:
      route.color,
    textColor:
      route.textColor
  };
}

/* =========================================================
   YAKIN DURAKLAR
========================================================= */

function nearbyStops(
  lat,
  lon,
  radius = 3000
) {
  const result = [];

  for (
    const stop of db.stops.values()
  ) {
    const distance =
      haversine(
        lat,
        lon,
        stop.lat,
        stop.lon
      );

    if (
      distance <= radius
    ) {
      const walk =
        walkingMinutes(
          distance
        );

      result.push({
        ...stopJSON(stop),

        distanceMeters:
          Math.round(
            distance
          ),

        distanceText:
          distanceText(
            distance
          ),

        walkingMinutes:
          walk,

        walkingText:
          `${walk} dk yürüyüş`
      });
    }
  }

  result.sort(
    (a, b) =>
      a.distanceMeters -
      b.distanceMeters
  );

  return result;
}

/* =========================================================
   DURAK ARAMA
========================================================= */

function searchStops(
  query,
  limit = 20
) {
  const q =
    normalize(query);

  if (!q) {
    return [];
  }

  return [
    ...db.stops.values()
  ]
    .filter(
      stop =>
        stop.search.includes(q)
    )
    .slice(
      0,
      Math.min(
        100,
        Math.max(
          1,
          Number(limit) || 20
        )
      )
    )
    .map(stopJSON);
}

/* =========================================================
   TARİFE
========================================================= */

function upcoming(
  stopId,
  limit = 20
) {
  const now =
    nowTurkey();

  const list =
    db.tripsByStop.get(
      stopId
    ) || [];

  const result = [];

  for (
    const st of list
  ) {
    const trip =
      db.trips.get(
        st.tripId
      );

    if (!trip) continue;

    if (
      !serviceRunsToday(
        trip.serviceId
      )
    ) {
      continue;
    }

    if (
      st.departure == null
    ) {
      continue;
    }

    if (
      st.departure < now
    ) {
      continue;
    }

    const route =
      db.routes.get(
        trip.routeId
      );

    result.push({
      tripId:
        trip.id,

      route:
        route
          ? routeJSON(route)
          : {
              id:
                trip.routeId,

              shortName:
                trip.routeId,

              longName:
                ""
            },

      headsign:
        trip.headsign,

      directionId:
        trip.directionId,

      departureTime:
        clock(
          st.departure
        ),

      waitMinutes:
        Math.ceil(
          (
            st.departure -
            now
          ) / 60
        )
    });
  }

  result.sort(
    (a, b) =>
      a.waitMinutes -
      b.waitMinutes
  );

  return result.slice(
    0,
    limit
  );
}

/* =========================================================
   DOĞRUDAN YOLCULUK
========================================================= */

function tripStopTimes(
  tripId
) {
  return db.stopTimes
    .filter(
      x =>
        x.tripId ===
        tripId
    )
    .sort(
      (a, b) =>
        a.sequence -
        b.sequence
    );
}

function directJourneys(
  origin,
  destination
) {
  const now =
    nowTurkey();

  const nearby =
    nearbyStops(
      origin.lat,
      origin.lon,
      3000
    );

  const destinationTimes =
    db.tripsByStop.get(
      destination.id
    ) || [];

  const result = [];

  /*
   * En yakın 30 biniş durağı
   */
  for (
    const board of nearby.slice(
      0,
      30
    )
  ) {
    const originTimes =
      db.tripsByStop.get(
        board.id
      ) || [];

    const byTrip =
      new Map();

    for (
      const x of originTimes
    ) {
      byTrip.set(
        x.tripId,
        x
      );
    }

    for (
      const destTime of
        destinationTimes
    ) {
      const originTime =
        byTrip.get(
          destTime.tripId
        );

      if (!originTime) {
        continue;
      }

      if (
        destTime.sequence <=
        originTime.sequence
      ) {
        continue;
      }

      const trip =
        db.trips.get(
          destTime.tripId
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
        originTime.departure;

      const arrival =
        destTime.arrival;

      if (
        departure == null ||
        arrival == null
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
          (
            departure -
            now
          ) / 60
        );

      const ride =
        Math.max(
          0,
          Math.ceil(
            (
              arrival -
              departure
            ) / 60
          )
        );

      const walk =
        board.walkingMinutes;

      const total =
        walk +
        wait +
        ride;

      const route =
        db.routes.get(
          trip.routeId
        );

      result.push({
        type:
          "direct",

        route:
          route
            ? routeJSON(route)
            : {
                id:
                  trip.routeId,

                shortName:
                  trip.routeId,

                longName:
                  ""
              },

        tripId:
          trip.id,

        headsign:
          trip.headsign,

        directionId:
          trip.directionId,

        boardingStop:
          stopJSON(
            db.stops.get(
              board.id
            )
          ),

        destinationStop:
          stopJSON(
            destination
          ),

        walkingDistanceMeters:
          board.distanceMeters,

        walkingTimeMinutes:
          walk,

        waitingTimeMinutes:
          wait,

        rideTimeMinutes:
          ride,

        totalTimeMinutes:
          total,

        departureTime:
          clock(
            departure
          ),

        arrivalTime:
          clock(
            arrival
          ),

        liveAvailable:
          false,

        liveNote:
          "Sonuç GTFS tarifesine göre hesaplanmıştır."
      });
    }
  }

  /*
   * Aynı yolculukları ayıkla
   */
  const unique =
    new Map();

  for (
    const item of result
  ) {
    const key =
      [
        item.tripId,
        item.boardingStop.id,
        item.destinationStop.id
      ].join("|");

    if (
      !unique.has(key)
    ) {
      unique.set(
        key,
        item
      );
    }
  }

  return [
    ...unique.values()
  ]
    .sort(
      (a, b) =>
        a.totalTimeMinutes -
        b.totalTimeMinutes
    )
    .slice(
      0,
      30
    );
}

/* =========================================================
   API
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

      source:
        db.source,

      loadedAt:
        db.loadedAt,

      stats:
        db.stats
    });
  }
);

app.get(
  "/api/app-info",
  (req, res) => {
    res.json({
      name:
        "Konya Ulaşım Plus",

      version:
        "6.0.0",

      source:
        db.source,

      ready:
        db.ready,

      loading:
        db.loading,

      error:
        db.error,

      liveAvailable:
        false,

      stats:
        db.stats,

      updatedAt:
        db.loadedAt
    });
  }
);

/* DURAK ARAMA */

app.get(
  "/api/stops",
  (req, res) => {
    if (!db.ready) {
      return res
        .status(503)
        .json({
          ok: false,

          error:
            db.error ||
            "Ulaşım verileri henüz hazır değil."
        });
    }

    const q =
      clean(req.query.q);

    const limit =
      Number(
        req.query.limit || 20
      );

    res.json({
      ok: true,

      results:
        q
          ? searchStops(
              q,
              limit
            )
          : [
              ...db.stops.values()
            ]
              .slice(
                0,
                Math.min(
                  100,
                  limit
                )
              )
              .map(stopJSON)
    });
  }
);

/* YAKIN DURAK */

app.get(
  "/api/stops/nearby",
  (req, res) => {
    if (!db.ready) {
      return res
        .status(503)
        .json({
          ok: false,

          error:
            db.error ||
            "Ulaşım verileri henüz hazır değil."
        });
    }

    const lat =
      toNumber(
        req.query.lat
      );

    const lon =
      toNumber(
        req.query.lon ??
        req.query.lng
      );

    const radius =
      toNumber(
        req.query.radius
      ) ?? 3000;

    if (
      lat == null ||
      lon == null
    ) {
      return res
        .status(400)
        .json({
          ok: false,

          error:
            "Geçerli konum gerekli."
        });
    }

    res.json({
      ok: true,

      center: {
        lat,
        lon
      },

      radius,

      results:
        nearbyStops(
          lat,
          lon,
          Math.min(
            10000,
            Math.max(
              100,
              radius
            )
          )
        ).slice(
          0,
          50
        )
    });
  }
);

/* DURAK DETAY */

app.get(
  "/api/stops/:id",
  (req, res) => {
    if (!db.ready) {
      return res
        .status(503)
        .json({
          ok: false,
          error:
            db.error ||
            "Ulaşım verileri hazır değil."
        });
    }

    const stop =
      db.stops.get(
        req.params.id
      );

    if (!stop) {
      return res
        .status(404)
        .json({
          ok: false,
          error:
            "Durak bulunamadı."
        });
    }

    const routeIds =
      db.routesByStop.get(
        stop.id
      ) || [];

    const routes =
      routeIds
        .map(
          id =>
            db.routes.get(id)
        )
        .filter(Boolean)
        .map(routeJSON);

    res.json({
      ok: true,

      stop:
        stopJSON(stop),

      routes,

      departures:
        upcoming(
          stop.id,
          30
        )
    });
  }
);

/* HATLAR */

app.get(
  "/api/routes",
  (req, res) => {
    if (!db.ready) {
      return res
        .status(503)
        .json({
          ok: false,
          error:
            db.error ||
            "Ulaşım verileri hazır değil."
        });
    }

    const q =
      normalize(
        req.query.q || ""
      );

    let routes =
      [
        ...db.routes.values()
      ];

    if (q) {
      routes =
        routes.filter(
          r =>
            r.search.includes(q)
        );
    }

    res.json({
      ok: true,

      results:
        routes
          .slice(
            0,
            100
          )
          .map(routeJSON)
    });
  }
);

/* YOLCULUK */

app.post(
  "/api/journey/calculate",
  (req, res) => {
    if (!db.ready) {
      return res
        .status(503)
        .json({
          ok: false,

          error:
            db.error ||
            "Ulaşım verileri henüz hazır değil."
        });
    }

    const body =
      req.body || {};

    const origin =
      body.origin || {};

    const destination =
      body.destination || {};

    const lat =
      toNumber(
        origin.lat
      );

    const lon =
      toNumber(
        origin.lon ??
        origin.lng
      );

    if (
      lat == null ||
      lon == null
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          error:
            "Başlangıç konumu geçerli değil."
        });
    }

    let stop = null;

    if (
      destination.stopId
    ) {
      stop =
        db.stops.get(
          String(
            destination.stopId
          )
        );
    }

    if (
      !stop &&
      destination.name
    ) {
      const q =
        normalize(
          destination.name
        );

      stop =
        [
          ...db.stops.values()
        ].find(
          x =>
            x.search === q
        ) ||
        [
          ...db.stops.values()
        ].find(
          x =>
            x.search.includes(q)
        );
    }

    if (!stop) {
      return res
        .status(404)
        .json({
          ok: false,
          error:
            "Hedef durak bulunamadı."
        });
    }

    const results =
      directJourneys(
        {
          lat,
          lon
        },
        stop
      );

    res.json({
      ok: true,

      destination:
        stopJSON(stop),

      liveAvailable:
        false,

      liveNote:
        "Canlı araç API'si doğrulanmadığı için tarifeye göre sonuç veriliyor.",

      results,

      transferSearch:
        false,

      transferNote:
        "Doğrulanmamış aktarma rotası üretilmiyor."
    });
  }
);

/* CANLI */

app.get(
  "/api/live/:id",
  (req, res) => {
    if (!db.ready) {
      return res
        .status(503)
        .json({
          ok: false,
          available: false,
          error:
            db.error ||
            "Ulaşım verileri hazır değil."
        });
    }

    const stop =
      db.stops.get(
        req.params.id
      );

    if (!stop) {
      return res
        .status(404)
        .json({
          ok: false,
          available: false,
          error:
            "Durak bulunamadı."
        });
    }

    res.json({
      ok: true,

      available:
        false,

      stop:
        stopJSON(stop),

      scheduled:
        upcoming(
          stop.id,
          20
        ),

      message:
        "Canlı araç verisi doğrulanabilir resmî API üzerinden sunulmuyor."
    });
  }
);

/* VERİ DURUMU */

app.get(
  "/api/data-status",
  (req, res) => {
    res.json({
      ok: db.ready,

      ready:
        db.ready,

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
   STATİK DOSYALAR
========================================================= */

app.use(
  express.static(
    process.cwd(),
    {
      index:
        "index.html",
      extensions:
        ["html"]
    }
  )
);

/* =========================================================
   FALLBACK
========================================================= */

app.use(
  (req, res, next) => {
    if (
      req.path.startsWith(
        "/api/"
      )
    ) {
      return next();
    }

    res.sendFile(
      `${process.cwd()}/index.html`
    );
  }
);

/* =========================================================
   HATA
========================================================= */

app.use(
  (err, req, res, next) => {
    console.error(
      "Sunucu hatası:",
      err
    );

    res
      .status(500)
      .json({
        ok: false,

        error:
          err?.message ||
          "Sunucu hatası."
      });
  }
);

/* =========================================================
   BAŞLAT
========================================================= */

const server =
  app.listen(
    PORT,
    HOST,
    () => {
      console.log("");
      console.log(
        "===================================="
      );

      console.log(
        "🚌 KONYA ULAŞIM PLUS 6.0"
      );

      console.log(
        `PORT: ${PORT}`
      );

      console.log(
        "GTFS kaynağı: RESMÎ KONYA AÇIK VERİ"
      );

      console.log(
        "CKAN API: KULLANILMIYOR"
      );

      console.log(
        "===================================="
      );

      loadGTFS();
    }
  );

/* =========================================================
   PERİYODİK YENİLEME
========================================================= */

const refresh =
  setInterval(
    () => {
      loadGTFS();
    },
    REFRESH_MS
  );

/* =========================================================
   KAPATMA
========================================================= */

function shutdown() {
  clearInterval(
    refresh
  );

  server.close(
    () => {
      process.exit(0);
    }
  );
}

process.on(
  "SIGTERM",
  shutdown
);

process.on(
  "SIGINT",
  shutdown
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
