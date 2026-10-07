import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = process.env.PORT || 10000;

const CKAN_API =
  "https://acikveri.konya.bel.tr/api/3/action";

const ATUS_URL =
  "https://atus.konya.bel.tr/";

const GTFS_SEARCH_TEXT =
  "Toplu Taşıma GTFS Verileri";

const DATA_REFRESH_MS =
  6 * 60 * 60 * 1000;

const MAX_NEARBY_METERS = 5000;

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

/* =========================================================
   STATE
========================================================= */

const db = {
  loaded: false,
  loading: false,
  lastUpdated: null,
  error: null,

  stops: new Map(),
  routes: new Map(),
  trips: new Map(),
  stopTimes: new Map(),

  tripsByRoute: new Map(),
  tripsByStop: new Map(),
  routesByStop: new Map(),

  services: new Map(),
  calendarDates: new Map()
};

/* =========================================================
   BASIC HELPERS
========================================================= */

function clean(value) {
  return String(value ?? "").trim();
}

function normalize(value) {
  return clean(value)
    .toLocaleLowerCase("tr-TR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/\s+/g, " ")
    .trim();
}

function number(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function haversine(lat1, lon1, lat2, lon2) {
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

function walkingMinutes(meters) {
  if (!Number.isFinite(meters)) return null;

  return Math.max(
    1,
    Math.ceil(meters / 80)
  );
}

function parseTime(value) {
  const m =
    /^(\d+):(\d{2}):(\d{2})$/.exec(
      clean(value)
    );

  if (!m) return null;

  return (
    Number(m[1]) * 3600 +
    Number(m[2]) * 60 +
    Number(m[3])
  );
}

function secondsToClock(seconds) {
  if (!Number.isFinite(seconds)) return null;

  const day =
    Math.floor(seconds / 86400);

  const s =
    ((seconds % 86400) + 86400) % 86400;

  const h =
    Math.floor(s / 3600);

  const m =
    Math.floor((s % 3600) / 60);

  return {
    text:
      `${String(h).padStart(2, "0")}:` +
      `${String(m).padStart(2, "0")}`,

    seconds,

    day
  };
}

function dateKey(date) {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("");
}

function weekdayKey(date) {
  const day = date.getUTCDay();

  return [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday"
  ][day];
}

/* =========================================================
   CSV PARSER
========================================================= */

function parseCSV(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (ch === '"') {
      if (
        quoted &&
        text[i + 1] === '"'
      ) {
        cell += '"';
        i++;
      } else {
        quoted = !quoted;
      }

      continue;
    }

    if (ch === "," && !quoted) {
      row.push(cell);
      cell = "";
      continue;
    }

    if (
      (ch === "\n" || ch === "\r") &&
      !quoted
    ) {
      if (
        ch === "\r" &&
        text[i + 1] === "\n"
      ) {
        i++;
      }

      row.push(cell);
      cell = "";

      if (
        row.some(v => clean(v) !== "")
      ) {
        rows.push(row);
      }

      row = [];
      continue;
    }

    cell += ch;
  }

  if (cell.length || row.length) {
    row.push(cell);

    if (
      row.some(v => clean(v) !== "")
    ) {
      rows.push(row);
    }
  }

  if (!rows.length) {
    return [];
  }

  const headers = rows[0].map(
    h => clean(h).replace(/^\uFEFF/, "")
  );

  return rows.slice(1).map(values => {

    const obj = {};

    headers.forEach((header, i) => {
      obj[header] =
        clean(values[i] ?? "");
    });

    return obj;
  });
}

/* =========================================================
   CKAN
========================================================= */

async function ckanSearch(query) {

  const url =
    `${CKAN_API}/package_search?q=` +
    encodeURIComponent(query);

  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `CKAN HTTP ${response.status}`
    );
  }

  const json =
    await response.json();

  if (!json.success) {
    throw new Error(
      "CKAN package_search başarısız."
    );
  }

  return json.result.results || [];
}

/* =========================================================
   DOWNLOAD RESOURCE
========================================================= */

async function downloadBuffer(url) {

  const response =
    await fetch(url, {
      redirect: "follow"
    });

  if (!response.ok) {
    throw new Error(
      `Veri indirilemedi: HTTP ${response.status}`
    );
  }

  return Buffer.from(
    await response.arrayBuffer()
  );
}

/* =========================================================
   GTFS RESOURCE FINDER
========================================================= */

async function findGtfsResource() {

  const datasets =
    await ckanSearch(
      GTFS_SEARCH_TEXT
    );

  if (!datasets.length) {
    throw new Error(
      "Konya GTFS veri seti bulunamadı."
    );
  }

  const dataset =
    datasets[0];

  const resources =
    dataset.resources || [];

  const zip =
    resources.find(resource => {

      const name =
        normalize(
          `${resource.name || ""} ${resource.format || ""}`
        );

      return (
        name.includes("zip") ||
        String(resource.url || "")
          .toLowerCase()
          .endsWith(".zip")
      );
    });

  if (!zip?.url) {
    throw new Error(
      "GTFS ZIP kaynağının URL'si bulunamadı."
    );
  }

  return {
    dataset,
    resource: zip
  };
}

/* =========================================================
   GTFS ZIP PARSER
========================================================= */

function readZipText(zip, filename) {

  const entry =
    zip.getEntry(filename);

  if (!entry) {
    return null;
  }

  return entry
    .getData()
    .toString("utf8");
}

function findZipFile(zip, name) {

  const wanted =
    normalize(name);

  const entry =
    zip.getEntries().find(
      e =>
        normalize(
          path.basename(e.entryName)
        ) === wanted
    );

  return entry || null;
}

function readGtfsFile(zip, name) {

  const entry =
    findZipFile(zip, name);

  if (!entry) return [];

  return parseCSV(
    entry.getData().toString("utf8")
  );
}

/* =========================================================
   INDEX HELPERS
========================================================= */

function addToSetMap(map, key, value) {

  if (!map.has(key)) {
    map.set(key, new Set());
  }

  map.get(key).add(value);
}

function addToArrayMap(map, key, value) {

  if (!map.has(key)) {
    map.set(key, []);
  }

  map.get(key).push(value);
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

  try {

    console.log(
      "Konya GTFS verisi aranıyor..."
    );

    const {
      dataset,
      resource
    } = await findGtfsResource();

    console.log(
      "GTFS:",
      resource.name || resource.url
    );

    const buffer =
      await downloadBuffer(
        resource.url
      );

    const zip =
      new AdmZip(buffer);

    const stops =
      readGtfsFile(zip, "stops.txt");

    const routes =
      readGtfsFile(zip, "routes.txt");

    const trips =
      readGtfsFile(zip, "trips.txt");

    const stopTimes =
      readGtfsFile(
        zip,
        "stop_times.txt"
      );

    const calendar =
      readGtfsFile(
        zip,
        "calendar.txt"
      );

    const calendarDates =
      readGtfsFile(
        zip,
        "calendar_dates.txt"
      );

    if (!stops.length) {
      throw new Error(
        "GTFS içinde stops.txt bulunamadı."
      );
    }

    if (!routes.length) {
      throw new Error(
        "GTFS içinde routes.txt bulunamadı."
      );
    }

    if (!trips.length) {
      throw new Error(
        "GTFS içinde trips.txt bulunamadı."
      );
    }

    if (!stopTimes.length) {
      throw new Error(
        "GTFS içinde stop_times.txt bulunamadı."
      );
    }

    /* -----------------------------------------
       TEMP DATABASE
    ----------------------------------------- */

    const next = {
      stops: new Map(),
      routes: new Map(),
      trips: new Map(),
      stopTimes: new Map(),

      tripsByRoute: new Map(),
      tripsByStop: new Map(),
      routesByStop: new Map(),

      services: new Map(),
      calendarDates: new Map()
    };

    /* -----------------------------------------
       STOPS
    ----------------------------------------- */

    for (const row of stops) {

      const id =
        row.stop_id;

      if (!id) continue;

      const lat =
        number(row.stop_lat);

      const lon =
        number(row.stop_lon);

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
            row.stop_name ||
            id,

          code:
            row.stop_code ||
            null,

          lat,
          lon,

          parentStation:
            row.parent_station ||
            null
        }
      );
    }

    /* -----------------------------------------
       ROUTES
    ----------------------------------------- */

    for (const row of routes) {

      const id =
        row.route_id;

      if (!id) continue;

      next.routes.set(
        id,
        {
          id,

          shortName:
            row.route_short_name ||
            id,

          longName:
            row.route_long_name ||
            "",

          type:
            row.route_type ||
            null
        }
      );
    }

    /* -----------------------------------------
       TRIPS
    ----------------------------------------- */

    for (const row of trips) {

      const id =
        row.trip_id;

      if (!id) continue;

      const routeId =
        row.route_id;

      const serviceId =
        row.service_id;

      next.trips.set(
        id,
        {
          id,

          routeId,

          serviceId,

          headsign:
            row.trip_headsign ||
            "",

          directionId:
            row.direction_id ||
            null,

          shapeId:
            row.shape_id ||
            null
        }
      );

      addToArrayMap(
        next.tripsByRoute,
        routeId,
        id
      );
    }

    /* -----------------------------------------
       CALENDAR
    ----------------------------------------- */

    for (const row of calendar) {

      if (!row.service_id) continue;

      next.services.set(
        row.service_id,
        {
          serviceId:
            row.service_id,

          startDate:
            row.start_date,

          endDate:
            row.end_date,

          monday: row.monday === "1",
          tuesday: row.tuesday === "1",
          wednesday: row.wednesday === "1",
          thursday: row.thursday === "1",
          friday: row.friday === "1",
          saturday: row.saturday === "1",
          sunday: row.sunday === "1"
        }
      );
    }

    /* -----------------------------------------
       CALENDAR DATES
    ----------------------------------------- */

    for (const row of calendarDates) {

      if (!row.service_id) continue;

      const key =
        `${row.service_id}:${row.date}`;

      next.calendarDates.set(
        key,
        Number(row.exception_type)
      );
    }

    /* -----------------------------------------
       STOP TIMES
    ----------------------------------------- */

    for (const row of stopTimes) {

      const tripId =
        row.trip_id;

      const stopId =
        row.stop_id;

      if (!tripId || !stopId) {
        continue;
      }

      const departure =
        parseTime(
          row.departure_time
        );

      const arrival =
        parseTime(
          row.arrival_time
        );

      if (
        departure == null ||
        arrival == null
      ) {
        continue;
      }

      const item = {
        tripId,

        stopId,

        stopSequence:
          number(
            row.stop_sequence,
            0
          ),

        arrival,
        departure,

        pickupType:
          row.pickup_type || "0",

        dropOffType:
          row.drop_off_type || "0"
      };

      addToArrayMap(
        next.stopTimes,
        tripId,
        item
      );

      addToArrayMap(
        next.tripsByStop,
        stopId,
        tripId
      );

      const trip =
        next.trips.get(tripId);

      if (trip) {

        addToSetMap(
          next.routesByStop,
          stopId,
          trip.routeId
        );
      }
    }

    /* -----------------------------------------
       SORT STOP TIMES
    ----------------------------------------- */

    for (
      const [tripId, items]
      of next.stopTimes
    ) {

      items.sort(
        (a, b) =>
          a.stopSequence -
          b.stopSequence
      );

      next.stopTimes.set(
        tripId,
        items
      );
    }

    /* -----------------------------------------
       COMMIT
    ----------------------------------------- */

    db.stops = next.stops;
    db.routes = next.routes;
    db.trips = next.trips;
    db.stopTimes = next.stopTimes;

    db.tripsByRoute =
      next.tripsByRoute;

    db.tripsByStop =
      next.tripsByStop;

    db.routesByStop =
      next.routesByStop;

    db.services =
      next.services;

    db.calendarDates =
      next.calendarDates;

    db.loaded = true;
    db.lastUpdated = new Date();

    console.log(
      `GTFS hazır: ` +
      `${db.stops.size} durak, ` +
      `${db.routes.size} hat, ` +
      `${db.trips.size} sefer`
    );

    console.log(
      "Veri seti:",
      dataset.title || GTFS_SEARCH_TEXT
    );

  } catch (error) {

    db.error =
      error?.message ||
      String(error);

    console.error(
      "GTFS yükleme hatası:",
      db.error
    );

  } finally {

    db.loading = false;
  }
}

/* =========================================================
   SERVICE ACTIVE CHECK
========================================================= */

function isServiceActive(
  serviceId,
  date = new Date()
) {

  const keyDate =
    dateKey(date);

  const exception =
    db.calendarDates.get(
      `${serviceId}:${keyDate}`
    );

  if (exception === 1) {
    return true;
  }

  if (exception === 2) {
    return false;
  }

  const service =
    db.services.get(serviceId);

  if (!service) {
    return true;
  }

  if (
    keyDate < service.startDate ||
    keyDate > service.endDate
  ) {
    return false;
  }

  return Boolean(
    service[
      weekdayKey(date)
    ]
  );
}

/* =========================================================
   STOP SERIALIZATION
========================================================= */

function publicStop(stop) {

  if (!stop) return null;

  return {
    id: stop.id,
    name: stop.name,
    code: stop.code,
    lat: stop.lat,
    lon: stop.lon
  };
}

/* =========================================================
   NEARBY STOPS
========================================================= */

function nearbyStops(
  lat,
  lon,
  radius = 1500
) {

  const result = [];

  for (const stop of db.stops.values()) {

    const distance =
      haversine(
        lat,
        lon,
        stop.lat,
        stop.lon
      );

    if (distance <= radius) {

      result.push({
        ...publicStop(stop),

        distanceMeters:
          Math.round(distance),

        walkingMinutes:
          walkingMinutes(distance)
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
   FIND STOP BY NAME
========================================================= */

function findStopsByName(name) {

  const q =
    normalize(name);

  if (!q) return [];

  const exact = [];
  const partial = [];

  for (const stop of db.stops.values()) {

    const n =
      normalize(stop.name);

    if (n === q) {
      exact.push(stop);
    } else if (n.includes(q)) {
      partial.push(stop);
    }
  }

  return [
    ...exact,
    ...partial
  ];
}

/* =========================================================
   ROUTE / TRIP SEQUENCE
========================================================= */

function getTripSequence(tripId) {

  return (
    db.stopTimes.get(tripId) ||
    []
  );
}

function routeContainsStop(
  tripId,
  stopId
) {

  return getTripSequence(
    tripId
  ).some(
    item =>
      item.stopId === stopId
  );
}

/* =========================================================
   DIRECT JOURNEY
========================================================= */

function findDirectJourneys({
  originStopIds,
  destinationStopIds,
  now
}) {

  const destinationSet =
    new Set(destinationStopIds);

  const results = [];

  for (
    const originStopId
    of originStopIds
  ) {

    const tripIds =
      db.tripsByStop.get(
        originStopId
      ) || [];

    for (
      const tripId
      of tripIds
    ) {

      const trip =
        db.trips.get(tripId);

      if (!trip) continue;

      if (
        !isServiceActive(
          trip.serviceId
        )
      ) {
        continue;
      }

      const sequence =
        getTripSequence(tripId);

      const origin =
        sequence.find(
          x =>
            x.stopId ===
            originStopId
        );

      if (!origin) continue;

      if (
        origin.departure < now
      ) {
        continue;
      }

      const destination =
        sequence.find(
          x =>
            destinationSet.has(
              x.stopId
            ) &&
            x.stopSequence >
              origin.stopSequence
        );

      if (!destination) {
        continue;
      }

      const route =
        db.routes.get(
          trip.routeId
        );

      if (!route) continue;

      results.push({

        type: "direct",

        tripId,

        routeId:
          route.id,

        line:
          route.shortName,

        routeName:
          route.longName,

        direction:
          trip.headsign ||
          "Yön bilgisi yok",

        fromStop:
          publicStop(
            db.stops.get(
              origin.stopId
            )
          ),

        toStop:
          publicStop(
            db.stops.get(
              destination.stopId
            )
          ),

        departureSeconds:
          origin.departure,

        arrivalSeconds:
          destination.arrival,

        waitingMinutes:
          Math.max(
            0,
            Math.ceil(
              (origin.departure - now) /
              60
            )
          ),

        busMinutes:
          Math.max(
            0,
            Math.ceil(
              (
                destination.arrival -
                origin.departure
              ) / 60
            )
          ),

        transfers: 0
      });
    }
  }

  return results;
}

/* =========================================================
   TRANSFER SEARCH
========================================================= */

function buildTransferJourneys({
  originStopIds,
  destinationStopIds,
  now,
  maxTransfers = 2
}) {

  const destinations =
    new Set(destinationStopIds);

  const journeys = [];

  /*
    Basit ama gerçek GTFS tabanlı
    round-based arama.

    0 transfer:
    doğrudan

    1 transfer:
    ilk otobüs -> ortak durak -> ikinci otobüs

    2 transfer:
    ilk -> ortak -> ikinci ortak -> üçüncü
  */

  const direct =
    findDirectJourneys({
      originStopIds,
      destinationStopIds,
      now
    });

  journeys.push(...direct);

  if (maxTransfers < 1) {
    return journeys;
  }

  const firstLegs = [];

  for (
    const originStopId
    of originStopIds
  ) {

    const tripIds =
      db.tripsByStop.get(
        originStopId
      ) || [];

    for (
      const tripId
      of tripIds.slice(0, 300)
    ) {

      const trip =
        db.trips.get(tripId);

      if (!trip) continue;

      if (
        !isServiceActive(
          trip.serviceId
        )
      ) {
        continue;
      }

      const seq =
        getTripSequence(tripId);

      const origin =
        seq.find(
          x =>
            x.stopId ===
            originStopId &&
            x.departure >= now
        );

      if (!origin) continue;

      const route =
        db.routes.get(
          trip.routeId
        );

      if (!route) continue;

      for (
        const transferStop
        of seq
          .filter(
            x =>
              x.stopSequence >
              origin.stopSequence
          )
          .slice(0, 40)
      ) {

        if (
          destinationSetHas(
            destinations,
            transferStop.stopId
          )
        ) {
          continue;
        }

        firstLegs.push({
          trip,
          route,
          origin,
          transferStop,
          sequence: seq
        });
      }
    }
  }

  /*
    1 transfer
  */

  for (
    const first
    of firstLegs
  ) {

    const secondTripIds =
      db.tripsByStop.get(
        first.transferStop.stopId
      ) || [];

    for (
      const secondTripId
      of secondTripIds.slice(0, 100)
    ) {

      const secondTrip =
        db.trips.get(
          secondTripId
        );

      if (!secondTrip) continue;

      if (
        secondTrip.routeId ===
        first.trip.routeId
      ) {
        continue;
      }

      if (
        !isServiceActive(
          secondTrip.serviceId
        )
      ) {
        continue;
      }

      const secondSeq =
        getTripSequence(
          secondTripId
        );

      const boarding =
        secondSeq.find(
          x =>
            x.stopId ===
              first.transferStop.stopId &&
            x.departure >=
              first.transferStop.arrival + 60
        );

      if (!boarding) continue;

      const destination =
        secondSeq.find(
          x =>
            destinations.has(
              x.stopId
            ) &&
            x.stopSequence >
              boarding.stopSequence
        );

      if (!destination) continue;

      const secondRoute =
        db.routes.get(
          secondTrip.routeId
        );

      if (!secondRoute) continue;

      journeys.push({

        type: "transfer",

        transfers: 1,

        legs: [
          {
            tripId:
              first.trip.id,

            line:
              first.route.shortName,

            direction:
              first.trip.headsign,

            fromStop:
              publicStop(
                db.stops.get(
                  first.origin.stopId
                )
              ),

            toStop:
              publicStop(
                db.stops.get(
                  first.transferStop.stopId
                )
              ),

            departureSeconds:
              first.origin.departure,

            arrivalSeconds:
              first.transferStop.arrival
          },

          {
            tripId:
              secondTrip.id,

            line:
              secondRoute.shortName,

            direction:
              secondTrip.headsign,

            fromStop:
              publicStop(
                db.stops.get(
                  boarding.stopId
                )
              ),

            toStop:
              publicStop(
                db.stops.get(
                  destination.stopId
                )
              ),

            departureSeconds:
              boarding.departure,

            arrivalSeconds:
              destination.arrival
          }
        ],

        departureSeconds:
          first.origin.departure,

        arrivalSeconds:
          destination.arrival,

        waitingMinutes:
          Math.ceil(
            (
              first.origin.departure -
              now
            ) / 60
          ),

        busMinutes:
          Math.ceil(
            (
              destination.arrival -
              first.origin.departure
            ) / 60
          )
      });
    }
  }

  return journeys;
}

function destinationSetHas(
  set,
  value
) {
  return set.has(value);
}

/* =========================================================
   JOURNEY FORMAT
========================================================= */

function formatJourney(
  journey,
  originLocation
) {

  const firstStop =
    journey.fromStop ||
    journey.legs?.[0]?.fromStop;

  const finalStop =
    journey.toStop ||
    journey.legs?.at(-1)?.toStop;

  let walkingToStop = null;
  let walkingFromStop = null;

  if (
    originLocation &&
    firstStop
  ) {

    walkingToStop =
      haversine(
        originLocation.lat,
        originLocation.lon,
        firstStop.lat,
        firstStop.lon
      );
  }

  /*
    Hedef koordinatı varsa hesaplanabilir.
    Şimdilik isim hedefinde sadece son durağa
    kadar gerçek GTFS süresi gösterilir.
  */

  if (
    journey.destinationLocation &&
    finalStop
  ) {

    walkingFromStop =
      haversine(
        finalStop.lat,
        finalStop.lon,
        journey.destinationLocation.lat,
        journey.destinationLocation.lon
      );
  }

  const rideMinutes =
    Math.max(
      0,
      Math.ceil(
        (
          journey.arrivalSeconds -
          journey.departureSeconds
        ) / 60
      )
    );

  const wait =
    Math.max(
      0,
      journey.waitingMinutes || 0
    );

  const walkIn =
    walkingMinutes(
      walkingToStop
    ) || 0;

  const walkOut =
    walkingMinutes(
      walkingFromStop
    ) || 0;

  const total =
    wait +
    rideMinutes +
    walkIn +
    walkOut;

  return {
    ...journey,

    departureTime:
      secondsToClock(
        journey.departureSeconds
      )?.text,

    arrivalTime:
      secondsToClock(
        journey.arrivalSeconds
      )?.text,

    walkingToStopMeters:
      walkingToStop != null
        ? Math.round(walkingToStop)
        : null,

    walkingToStopMinutes:
      walkingToStop != null
        ? walkIn
        : null,

    walkingFromStopMeters:
      walkingFromStop != null
        ? Math.round(walkingFromStop)
        : null,

    walkingFromStopMinutes:
      walkingFromStop != null
        ? walkOut
        : null,

    rideMinutes,

    totalDuration:
      total
  };
}

/* =========================================================
   ROUTE DIRECTION VALIDATION
========================================================= */

function validateDirection(
  tripId,
  fromStopId,
  toStopId
) {

  const sequence =
    getTripSequence(tripId);

  const from =
    sequence.find(
      x =>
        x.stopId === fromStopId
    );

  const to =
    sequence.find(
      x =>
        x.stopId === toStopId
    );

  if (!from || !to) {
    return false;
  }

  return (
    to.stopSequence >
    from.stopSequence
  );
}

/* =========================================================
   API: HEALTH
========================================================= */

app.get(
  "/api/health",
  async (req, res) => {

    res.json({
      ok: true,

      service:
        "Konya Ulaşım Plus",

      loaded:
        db.loaded,

      loading:
        db.loading,

      lastUpdated:
        db.lastUpdated,

      dataError:
        db.error,

      counts: {
        stops:
          db.stops.size,

        routes:
          db.routes.size,

        trips:
          db.trips.size,

        stopTimes:
          db.stopTimes.size
      },

      fakeTimes: false,
      fakeVehicles: false,

      source:
        "Konya Açık Veri / GTFS"
    });
  }
);

/* =========================================================
   API: STOPS
========================================================= */

app.get(
  "/api/stops",
  async (req, res) => {

    if (!db.loaded) {
      await loadGtfs();
    }

    const q =
      normalize(req.query.q);

    let stops =
      [...db.stops.values()];

    if (q) {

      stops =
        stops.filter(
          stop =>
            normalize(
              stop.name
            ).includes(q)
        );
    }

    stops =
      stops
        .slice(0, 3000)
        .map(publicStop);

    res.json({
      ok: true,
      count: stops.length,
      stops
    });
  }
);

/* =========================================================
   API: NEARBY
========================================================= */

app.get(
  "/api/stops/nearby",
  async (req, res) => {

    if (!db.loaded) {
      await loadGtfs();
    }

    const lat =
      number(req.query.lat);

    const lon =
      number(req.query.lon);

    const radius =
      Math.min(
        MAX_NEARBY_METERS,
        Math.max(
          100,
          number(
            req.query.radius,
            1500
          )
        )
      );

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon)
    ) {

      return res.status(400).json({
        ok: false,
        error:
          "lat ve lon zorunludur."
      });
    }

    const stops =
      nearbyStops(
        lat,
        lon,
        radius
      );

    res.json({
      ok: true,
      radius,
      count: stops.length,
      stops
    });
  }
);

/* =========================================================
   API: STOP DETAIL
========================================================= */

app.get(
  "/api/stops/:stopId",
  async (req, res) => {

    if (!db.loaded) {
      await loadGtfs();
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
        ...(
          db.routesByStop.get(
            stop.id
          ) || []
        )
      ];

    const routes =
      routeIds
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

      stop:
        publicStop(stop),

      routes
    });
  }
);

/* =========================================================
   API: ROUTES
========================================================= */

app.get(
  "/api/routes",
  async (req, res) => {

    if (!db.loaded) {
      await loadGtfs();
    }

    const q =
      normalize(req.query.q);

    let routes =
      [...db.routes.values()];

    if (q) {

      routes =
        routes.filter(
          route =>
            normalize(
              route.shortName
            ).includes(q) ||
            normalize(
              route.longName
            ).includes(q)
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

/* =========================================================
   API: ROUTE DETAIL
========================================================= */

app.get(
  "/api/routes/:routeId",
  async (req, res) => {

    if (!db.loaded) {
      await loadGtfs();
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

    const tripIds =
      db.tripsByRoute.get(
        route.id
      ) || [];

    const tripList =
      tripIds
        .slice(0, 100)
        .map(
          id =>
            db.trips.get(id)
        )
        .filter(Boolean);

    const stopIds =
      new Set();

    for (
      const trip of tripList
    ) {

      for (
        const item
        of getTripSequence(trip.id)
      ) {

        stopIds.add(
          item.stopId
        );
      }
    }

    const stops =
      [...stopIds]
        .map(
          id =>
            db.stops.get(id)
        )
        .filter(Boolean)
        .map(publicStop);

    res.json({
      ok: true,

      route,

      trips:
        tripList.map(trip => ({
          id: trip.id,
          headsign:
            trip.headsign,
          directionId:
            trip.directionId
        })),

      stops
    });
  }
);

/* =========================================================
   API: JOURNEY CALCULATE
========================================================= */

app.post(
  "/api/journey/calculate",
  async (req, res) => {

    if (!db.loaded) {
      await loadGtfs();
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
      number(origin.lon);

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon)
    ) {

      return res.status(400).json({
        ok: false,
        error:
          "Başlangıç konumu eksik."
      });
    }

    const destinationName =
      clean(
        destination.name ||
        "Kaşgarlı Mahmut"
      );

    /* -----------------------------------------
       ORIGIN STOPS
    ----------------------------------------- */

    const nearby =
      nearbyStops(
        lat,
        lon,
        3000
      );

    const originStops =
      nearby.slice(0, 12);

    const originStopIds =
      originStops.map(
        stop => stop.id
      );

    /* -----------------------------------------
       DESTINATION STOPS
    ----------------------------------------- */

    let destinationStops =
      findStopsByName(
        destinationName
      );

    /*
      Eğer isim doğrudan bulunamazsa,
      arama sonucu olmayan bir hedefi
      uydurmuyoruz.
    */

    if (!destinationStops.length) {

      return res.json({
        ok: true,

        dataPolicy: {
          fakeTimes: false,
          fakeVehicles: false
        },

        origin: {
          lat,
          lon
        },

        destination: {
          name:
            destinationName,

          matched: false
        },

        routes: [],

        message:
          "Hedef adı GTFS duraklarında bulunamadı."
      });
    }

    const destinationStopIds =
      destinationStops
        .map(stop => stop.id);

    /* -----------------------------------------
       SEARCH
    ----------------------------------------- */

    const now =
      Math.floor(
        (
          Date.now() -
          new Date().setHours(
            0, 0, 0, 0
          )
        ) / 1000
      );

    let journeys =
      buildTransferJourneys({
        originStopIds,
        destinationStopIds,
        now,
        maxTransfers: 2
      });

    /* -----------------------------------------
       FILTER / FORMAT
    ----------------------------------------- */

    journeys =
      journeys.map(journey => {

        journey.destinationLocation =
          destinationStops[0]
            ? {
                lat:
                  destinationStops[0].lat,

                lon:
                  destinationStops[0].lon
              }
            : null;

        return formatJourney(
          journey,
          { lat, lon }
        );
      });

    /*
      En hızlı:
      totalDuration

      Eşitse:
      az yürüyüş

      Sonra:
      az aktarma
    */

    journeys.sort(
      (a, b) => {

        const time =
          a.totalDuration -
          b.totalDuration;

        if (time !== 0) {
          return time;
        }

        const walkA =
          (
            a.walkingToStopMinutes ||
            0
          ) +
          (
            a.walkingFromStopMinutes ||
            0
          );

        const walkB =
          (
            b.walkingToStopMinutes ||
            0
          ) +
          (
            b.walkingFromStopMinutes ||
            0
          );

        if (walkA !== walkB) {
          return walkA - walkB;
        }

        return (
          (a.transfers || 0) -
          (b.transfers || 0)
        );
      }
    );

    /*
      Aynı hattı / aynı seferi
      tekrar tekrar göstermemek için
      basit tekilleştirme.
    */

    const seen =
      new Set();

    journeys =
      journeys.filter(
        journey => {

          const key =
            `${journey.line || ""}|` +
            `${journey.departureTime || ""}|` +
            `${journey.toStop?.id || ""}|` +
            `${journey.transfers || 0}`;

          if (seen.has(key)) {
            return false;
          }

          seen.add(key);

          return true;
        }
      );

    res.json({

      ok: true,

      dataPolicy: {
        fakeTimes: false,
        fakeVehicles: false,
        directionChecked: true,
        scheduledData: true
      },

      origin: {
        lat,
        lon
      },

      destination: {
        name:
          destinationName,

        matched: true,

        candidateStops:
          destinationStops
            .slice(0, 20)
            .map(publicStop)
      },

      nearestOriginStops:
        originStops,

      routes:
        journeys.slice(0, 20),

      count:
        journeys.length
    });
  }
);

/* =========================================================
   LIVE ATUS
========================================================= */

app.get(
  "/api/live/:stopId",
  async (req, res) => {

    /*
      Sahte canlı veri göstermiyoruz.

      ATUS canlı veri endpoint'i resmi tarafta
      değişebildiği için doğrulanmış API olmadan
      tahmini otobüs üretmek yerine boş dönüyoruz.
    */

    const stop =
      db.stops.get(
        req.params.stopId
      );

    res.json({

      ok: true,

      stop:
        publicStop(stop),

      liveAvailable: false,

      vehicles: [],

      arrivals: [],

      message:
        "Bu sürümde doğrulanmış ATUS canlı araç verisi mevcut değil.",

      source:
        ATUS_URL
    });
  }
);

/* =========================================================
   APP INFO
========================================================= */

app.get(
  "/api/app-info",
  async (req, res) => {

    res.json({

      name:
        "Konya Ulaşım Plus",

      version:
        "3.0.0",

      city:
        "Konya",

      features: [
        "GPS konumu",
        "Yakındaki duraklar",
        "GTFS durakları",
        "GTFS hatları",
        "Sefer saatleri",
        "Doğrudan güzergâh",
        "Aktarmalı güzergâh",
        "Yön kontrolü",
        "Yürüyüş süresi"
      ],

      dataPolicy: {
        fakeTimes: false,
        fakeVehicles: false
      },

      dataSource:
        "Konya Açık Veri"
    });
  }
);

/* =========================================================
   FALLBACK
========================================================= */

app.use(
  (req, res, next) => {

    if (
      req.method !== "GET" ||
      req.path.startsWith("/api/")
    ) {
      return next();
    }

    res.sendFile(
      path.join(
        __dirname,
        "index.html"
      )
    );
  }
);

/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (error, req, res, next) => {

    console.error(error);

    res.status(500).json({

      ok: false,

      error:
        "Sunucu tarafında beklenmeyen hata oluştu.",

      detail:
        process.env.NODE_ENV === "production"
          ? undefined
          : error.message
    });
  }
);

/* =========================================================
   START
========================================================= */

async function start() {

  console.log(
    "Konya Ulaşım Plus başlatılıyor..."
  );

  /*
    Sunucuyu önce açıyoruz.
    GTFS yüklenirken Render health check
    beklemesin.
  */

  app.listen(
    PORT,
    "0.0.0.0",
    () => {

      console.log(
        `Server ${PORT} portunda çalışıyor.`
      );

      loadGtfs()
        .catch(error => {

          console.error(
            "İlk GTFS yüklemesi başarısız:",
            error
          );
        });
    }
  );

  /*
    Periyodik veri yenileme.
  */

  setInterval(
    () => {
      loadGtfs().catch(
        error =>
          console.error(
            "GTFS yenileme hatası:",
            error
          )
      );
    },
    DATA_REFRESH_MS
  );
}

start();
