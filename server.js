import express from "express";
import cors from "cors";
import AdmZip from "adm-zip";

const app = express();

const PORT = Number(process.env.PORT || 10000);
const HOST = "0.0.0.0";

const GTFS_QUERY = "Toplu Taşıma GTFS Verileri";
const CKAN_API =
  "https://acikveri.konya.bel.tr/api/3/action/package_search";

const DATA_REFRESH_MS = 6 * 60 * 60 * 1000;
const WALKING_METERS_PER_MINUTE = 80;
const MAX_RESULTS = 50;

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(process.cwd()));

const db = {
  loaded: false,
  loading: false,
  loadedAt: null,
  error: null,

  stops: new Map(),
  routes: new Map(),
  trips: new Map(),
  stopTimes: new Map(),
  tripsByStop: new Map(),
  routesByStop: new Map(),
  tripsByRoute: new Map(),

  services: new Map(),
  calendarDates: new Map(),

  stopTimeRows: [],
  tripStopSequences: new Map()
};

function normalizeText(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("tr-TR")
    .trim();
}

function csvParse(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (ch === '"') {
      if (quoted && text[i + 1] === '"') {
        field += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (ch === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && text[i + 1] === "\n") i++;

      row.push(field);
      field = "";

      if (row.some(v => String(v).trim() !== "")) {
        rows.push(row);
      }

      row = [];
    } else {
      field += ch;
    }
  }

  if (field.length || row.length) {
    row.push(field);
    if (row.some(v => String(v).trim() !== "")) {
      rows.push(row);
    }
  }

  if (!rows.length) return [];

  const headers = rows[0].map(v => String(v).trim());

  return rows.slice(1).map(values => {
    const obj = {};

    headers.forEach((header, index) => {
      obj[header] = String(values[index] ?? "").trim();
    });

    return obj;
  });
}

function parseGTFSFile(zip, fileName) {
  const entry = zip
    .getEntries()
    .find(
      e =>
        e.entryName.toLowerCase() === fileName.toLowerCase() ||
        e.entryName.toLowerCase().endsWith(`/${fileName.toLowerCase()}`)
    );

  if (!entry) return [];

  const text = entry.getData().toString("utf8");

  return csvParse(text);
}

async function downloadGTFS() {
  const url =
    `${CKAN_API}?q=${encodeURIComponent(GTFS_QUERY)}` +
    "&rows=20";

  const response = await fetch(url, {
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`CKAN HTTP ${response.status}`);
  }

  const data = await response.json();

  const results = data?.result?.results || [];

  const dataset =
    results.find(item =>
      normalizeText(item?.title).includes(
        normalizeText("Toplu Taşıma GTFS Verileri")
      )
    ) || results[0];

  if (!dataset) {
    throw new Error("GTFS veri seti bulunamadı.");
  }

  const resources = dataset.resources || [];

  const resource =
    resources.find(r =>
      String(r.format || "").toUpperCase().includes("ZIP")
    ) ||
    resources.find(r =>
      String(r.name || "").toLowerCase().endsWith(".zip")
    );

  if (!resource?.url) {
    throw new Error("GTFS ZIP kaynağı bulunamadı.");
  }

  const zipResponse = await fetch(resource.url);

  if (!zipResponse.ok) {
    throw new Error(`GTFS ZIP HTTP ${zipResponse.status}`);
  }

  const buffer = Buffer.from(await zipResponse.arrayBuffer());

  return {
    zip: new AdmZip(buffer),
    datasetTitle: dataset.title,
    resourceUrl: resource.url
  };
}

function clearDatabase() {
  db.stops.clear();
  db.routes.clear();
  db.trips.clear();
  db.stopTimes.clear();
  db.tripsByStop.clear();
  db.routesByStop.clear();
  db.tripsByRoute.clear();

  db.services.clear();
  db.calendarDates.clear();

  db.stopTimeRows = [];
  db.tripStopSequences.clear();
}

function addToMapArray(map, key, value) {
  if (!map.has(key)) {
    map.set(key, []);
  }

  map.get(key).push(value);
}

function parseTimeToSeconds(value) {
  if (!value) return null;

  const parts = String(value).split(":");

  if (parts.length !== 3) return null;

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

function secondsToClock(totalSeconds) {
  if (!Number.isFinite(totalSeconds)) return null;

  const seconds = ((Math.round(totalSeconds) % 86400) + 86400) % 86400;

  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);

  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function secondsSinceMidnightTurkey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Istanbul",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  const get = type =>
    Number(parts.find(p => p.type === type)?.value || 0);

  return get("hour") * 3600 + get("minute") * 60 + get("second");
}

function turkeyDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short"
  }).formatToParts(date);

  const value = type =>
    parts.find(p => p.type === type)?.value;

  const year = value("year");
  const month = value("month");
  const day = value("day");

  const weekdayShort = value("weekday");

  const weekdayMap = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6
  };

  return {
    date: `${year}${month}${day}`,
    year: Number(year),
    month: Number(month),
    day: Number(day),
    weekday: weekdayMap[weekdayShort] ?? 0
  };
}

function isServiceActive(serviceId, date = new Date()) {
  if (!serviceId) return true;

  const day = turkeyDateParts(date);
  const ymd = day.date;

  const exceptions = db.calendarDates.get(serviceId);

  if (exceptions?.has(ymd)) {
    const exceptionType = exceptions.get(ymd);

    if (exceptionType === "1") return true;
    if (exceptionType === "2") return false;
  }

  const service = db.services.get(serviceId);

  if (!service) return true;

  if (ymd < service.startDate || ymd > service.endDate) {
    return false;
  }

  const dayNames = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday"
  ];

  return service[dayNames[day.weekday]] === "1";
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;

  const a1 = Number(lat1);
  const o1 = Number(lon1);
  const a2 = Number(lat2);
  const o2 = Number(lon2);

  if (![a1, o1, a2, o2].every(Number.isFinite)) {
    return Infinity;
  }

  const dLat = ((a2 - a1) * Math.PI) / 180;
  const dLon = ((o2 - o1) * Math.PI) / 180;

  const latRad1 = (a1 * Math.PI) / 180;
  const latRad2 = (a2 * Math.PI) / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(latRad1) *
      Math.cos(latRad2) *
      Math.sin(dLon / 2) ** 2;

  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function walkingMinutes(meters) {
  if (!Number.isFinite(meters)) return null;

  return Math.max(
    1,
    Math.ceil(meters / WALKING_METERS_PER_MINUTE)
  );
}

function normalizeStop(stop) {
  return {
    id: stop.stop_id,
    name: stop.stop_name,
    lat: Number(stop.stop_lat),
    lon: Number(stop.stop_lon),
    code: stop.stop_code || null
  };
}

function routeInfo(routeId) {
  const route = db.routes.get(routeId);

  if (!route) return null;

  return {
    id: route.route_id,
    shortName: route.route_short_name || "",
    longName: route.route_long_name || "",
    color: route.route_color || null,
    type: route.route_type || null
  };
}

function buildTripSequence(tripId) {
  const rows = db.stopTimeRows.filter(
    row => row.trip_id === tripId
  );

  rows.sort(
    (a, b) =>
      Number(a.stop_sequence) -
      Number(b.stop_sequence)
  );

  return rows;
}

function loadGTFSIntoMemory(zip) {
  clearDatabase();

  const stops = parseGTFSFile(zip, "stops.txt");
  const routes = parseGTFSFile(zip, "routes.txt");
  const trips = parseGTFSFile(zip, "trips.txt");
  const stopTimes = parseGTFSFile(zip, "stop_times.txt");
  const calendar = parseGTFSFile(zip, "calendar.txt");
  const calendarDates = parseGTFSFile(zip, "calendar_dates.txt");

  for (const stop of stops) {
    if (!stop.stop_id) continue;

    db.stops.set(stop.stop_id, {
      ...stop,
      lat: Number(stop.stop_lat),
      lon: Number(stop.stop_lon),
      searchName: normalizeText(stop.stop_name)
    });
  }

  for (const route of routes) {
    if (!route.route_id) continue;

    db.routes.set(route.route_id, route);
  }

  for (const trip of trips) {
    if (!trip.trip_id) continue;

    db.trips.set(trip.trip_id, trip);

    addToMapArray(
      db.tripsByRoute,
      trip.route_id,
      trip.trip_id
    );
  }

  for (const service of calendar) {
    if (!service.service_id) continue;

    db.services.set(service.service_id, {
      startDate: service.start_date,
      endDate: service.end_date,
      monday: service.monday,
      tuesday: service.tuesday,
      wednesday: service.wednesday,
      thursday: service.thursday,
      friday: service.friday,
      saturday: service.saturday,
      sunday: service.sunday
    });
  }

  for (const item of calendarDates) {
    if (!item.service_id || !item.date) continue;

    if (!db.calendarDates.has(item.service_id)) {
      db.calendarDates.set(item.service_id, new Map());
    }

    db.calendarDates
      .get(item.service_id)
      .set(item.date, item.exception_type);
  }

  for (const row of stopTimes) {
    const departureSeconds =
      parseTimeToSeconds(row.departure_time);

    const arrivalSeconds =
      parseTimeToSeconds(row.arrival_time);

    const normalized = {
      ...row,
      departureSeconds,
      arrivalSeconds,
      stopSequence: Number(row.stop_sequence)
    };

    db.stopTimeRows.push(normalized);

    addToMapArray(
      db.stopTimes,
      row.trip_id,
      normalized
    );

    addToMapArray(
      db.tripsByStop,
      row.stop_id,
      row.trip_id
    );

    const trip = db.trips.get(row.trip_id);

    if (trip) {
      addToMapArray(
        db.routesByStop,
        row.stop_id,
        trip.route_id
      );
    }
  }

  for (const [tripId] of db.trips) {
    const sequence = buildTripSequence(tripId);

    db.tripStopSequences.set(tripId, sequence);
  }

  for (const [key, values] of db.tripsByStop) {
    db.tripsByStop.set(
      key,
      [...new Set(values)]
    );
  }

  for (const [key, values] of db.routesByStop) {
    db.routesByStop.set(
      key,
      [...new Set(values)]
    );
  }

  for (const [key, values] of db.tripsByRoute) {
    db.tripsByRoute.set(
      key,
      [...new Set(values)]
    );
  }

  db.loaded = true;
  db.loadedAt = new Date();
  db.error = null;

  console.log(
    `GTFS hazır: ${db.stops.size} durak, ` +
    `${db.routes.size} hat, ` +
    `${db.trips.size} sefer`
  );
}

async function refreshGTFS() {
  if (db.loading) return;

  db.loading = true;

  try {
    console.log("Konya GTFS verisi güncelleniyor...");

    const result = await downloadGTFS();

    loadGTFSIntoMemory(result.zip);

    console.log(
      `GTFS güncellendi: ${result.datasetTitle}`
    );
  } catch (error) {
    console.error("GTFS güncelleme hatası:", error);

    db.error = error.message;

    // Daha önce yüklenmiş sağlıklı veri varsa onu koruyoruz.
    if (!db.loaded) {
      db.loaded = false;
    }
  } finally {
    db.loading = false;
  }
}

function requireData(res) {
  if (!db.loaded) {
    res.status(503).json({
      ok: false,
      error: "Ulaşım verisi henüz hazırlanıyor.",
      loading: db.loading,
      detail: db.error
    });

    return false;
  }

  return true;
}

function getStop(stopId) {
  return db.stops.get(String(stopId));
}

function getStopName(stopId) {
  return getStop(stopId)?.stop_name || String(stopId);
}

function findStops(query, limit = 30) {
  const q = normalizeText(query);

  if (!q) return [];

  return [...db.stops.values()]
    .filter(stop =>
      stop.searchName.includes(q)
    )
    .slice(0, limit)
    .map(normalizeStop);
}

function getNearbyStops(lat, lon, radiusMeters = 1500) {
  const results = [];

  for (const stop of db.stops.values()) {
    const distance = haversineMeters(
      lat,
      lon,
      stop.stop_lat,
      stop.stop_lon
    );

    if (distance <= radiusMeters) {
      results.push({
        ...normalizeStop(stop),
        distanceMeters: Math.round(distance),
        walkingMinutes: walkingMinutes(distance),
        routes: (db.routesByStop.get(stop.stop_id) || [])
          .map(routeInfo)
          .filter(Boolean)
      });
    }
  }

  return results
    .sort((a, b) =>
      a.distanceMeters - b.distanceMeters
    )
    .slice(0, MAX_RESULTS);
}

function findStopByName(name) {
  const q = normalizeText(name);

  if (!q) return null;

  const exact = [...db.stops.values()].find(
    stop => stop.searchName === q
  );

  if (exact) return exact;

  return [...db.stops.values()].find(
    stop => stop.searchName.includes(q)
  ) || null;
}

function findStopTimesForTrip(tripId) {
  return db.tripStopSequences.get(tripId) || [];
}

function isTripActive(tripId, date = new Date()) {
  const trip = db.trips.get(tripId);

  if (!trip) return false;

  return isServiceActive(
    trip.service_id,
    date
  );
}

function findDirectJourneys(
  originStopId,
  destinationStopId,
  nowSeconds
) {
  const originTrips =
    db.tripsByStop.get(originStopId) || [];

  const results = [];

  for (const tripId of originTrips) {
    const trip = db.trips.get(tripId);

    if (!trip) continue;

    if (!isTripActive(tripId)) continue;

    const sequence =
      findStopTimesForTrip(tripId);

    const originIndex = sequence.findIndex(
      row => row.stop_id === originStopId
    );

    const destinationIndex = sequence.findIndex(
      row =>
        row.stop_id === destinationStopId &&
        Number(row.stop_sequence) >
          Number(
            sequence[originIndex]?.stop_sequence || -1
          )
    );

    if (
      originIndex < 0 ||
      destinationIndex < 0
    ) {
      continue;
    }

    const originRow = sequence[originIndex];
    const destinationRow =
      sequence[destinationIndex];

    const departure =
      originRow.departureSeconds;

    const arrival =
      destinationRow.arrivalSeconds;

    if (
      !Number.isFinite(departure) ||
      !Number.isFinite(arrival)
    ) {
      continue;
    }

    let waitSeconds =
      departure - nowSeconds;

    // GTFS'de 24:xx gibi ertesi güne taşan seferler olabilir.
    if (waitSeconds < 0) {
      continue;
    }

    results.push({
      type: "direct",
      transfers: 0,

      tripId,

      route: routeInfo(trip.route_id),

      originStop: normalizeStop(
        getStop(originStopId)
      ),

      destinationStop: normalizeStop(
        getStop(destinationStopId)
      ),

      departureSeconds: departure,
      arrivalSeconds: arrival,

      departureTime:
        secondsToClock(departure),

      arrivalTime:
        secondsToClock(arrival),

      waitMinutes:
        Math.ceil(waitSeconds / 60),

      rideMinutes:
        Math.max(
          0,
          Math.ceil(
            (arrival - departure) / 60
          )
        ),

      totalTransitMinutes:
        Math.ceil(waitSeconds / 60) +
        Math.max(
          0,
          Math.ceil(
            (arrival - departure) / 60
          )
        )
    });
  }

  return results;
}

function buildTransferJourneys(
  originStopId,
  destinationStopId,
  nowSeconds,
  maxTransfers = 3
) {
  const journeys = [];

  const queue = [
    {
      currentStopId: originStopId,
      legs: [],
      visitedStops: new Set([originStopId])
    }
  ];

  const MAX_STATES = 2500;

  while (
    queue.length &&
    journeys.length < MAX_RESULTS
  ) {
    const state = queue.shift();

    if (
      state.currentStopId === destinationStopId &&
      state.legs.length > 0
    ) {
      journeys.push(state.legs);
      continue;
    }

    if (state.legs.length >= maxTransfers + 1) {
      continue;
    }

    const routeIds =
      db.routesByStop.get(
        state.currentStopId
      ) || [];

    for (const routeId of routeIds) {
      const tripIds =
        db.tripsByRoute.get(routeId) || [];

      let bestTrips = [];

      for (const tripId of tripIds) {
        if (!isTripActive(tripId)) continue;

        const sequence =
          findStopTimesForTrip(tripId);

        const currentIndex =
          sequence.findIndex(
            row =>
              row.stop_id ===
              state.currentStopId
          );

        if (currentIndex < 0) continue;

        const currentRow =
          sequence[currentIndex];

        if (
          !Number.isFinite(
            currentRow.departureSeconds
          )
        ) {
          continue;
        }

        const minimumDeparture =
          state.legs.length === 0
            ? nowSeconds
            : state.legs[
                state.legs.length - 1
              ].arrivalSeconds;

        if (
          currentRow.departureSeconds <
          minimumDeparture
        ) {
          continue;
        }

        bestTrips.push({
          tripId,
          sequence,
          currentIndex,
          departure:
            currentRow.departureSeconds
        });
      }

      bestTrips.sort(
        (a, b) =>
          a.departure - b.departure
      );

      bestTrips = bestTrips.slice(0, 4);

      for (const tripInfo of bestTrips) {
        const {
          tripId,
          sequence,
          currentIndex,
          departure
        } = tripInfo;

        const trip = db.trips.get(tripId);

        for (
          let i = currentIndex + 1;
          i < sequence.length;
          i++
        ) {
          const targetRow = sequence[i];

          if (!targetRow.stop_id) continue;

          if (
            state.visitedStops.has(
              targetRow.stop_id
            )
          ) {
            continue;
          }

          if (
            !Number.isFinite(
              targetRow.arrivalSeconds
            )
          ) {
            continue;
          }

          const leg = {
            route: routeInfo(
              trip.route_id
            ),

            tripId,

            fromStop: normalizeStop(
              getStop(
                state.currentStopId
              )
            ),

            toStop: normalizeStop(
              getStop(
                targetRow.stop_id
              )
            ),

            departureSeconds: departure,
            arrivalSeconds:
              targetRow.arrivalSeconds,

            departureTime:
              secondsToClock(departure),

            arrivalTime:
              secondsToClock(
                targetRow.arrivalSeconds
              ),

            rideMinutes:
              Math.max(
                0,
                Math.ceil(
                  (
                    targetRow.arrivalSeconds -
                    departure
                  ) / 60
                )
              )
          };

          const newLegs = [
            ...state.legs,
            leg
          ];

          if (
            targetRow.stop_id ===
            destinationStopId
          ) {
            journeys.push(newLegs);
            break;
          }

          if (
            newLegs.length <
            maxTransfers + 1
          ) {
            const visitedStops =
              new Set(
                state.visitedStops
              );

            visitedStops.add(
              targetRow.stop_id
            );

            queue.push({
              currentStopId:
                targetRow.stop_id,
              legs: newLegs,
              visitedStops
            });
          }
        }
      }
    }

    if (queue.length > MAX_STATES) {
      queue.length = MAX_STATES;
    }
  }

  return journeys;
}

function flattenTransferJourney(
  legs,
  nowSeconds
) {
  if (!legs.length) return null;

  const first = legs[0];
  const last = legs[legs.length - 1];

  const waitMinutes = Math.max(
    0,
    Math.ceil(
      (first.departureSeconds -
        nowSeconds) /
        60
    )
  );

  const rideMinutes = legs.reduce(
    (sum, leg) =>
      sum + Number(leg.rideMinutes || 0),
    0
  );

  let transferWaitMinutes = 0;

  for (let i = 1; i < legs.length; i++) {
    transferWaitMinutes += Math.max(
      0,
      Math.ceil(
        (
          legs[i].departureSeconds -
          legs[i - 1].arrivalSeconds
        ) / 60
      )
    );
  }

  return {
    type: "transfer",
    transfers: Math.max(
      0,
      legs.length - 1
    ),

    departureTime:
      first.departureTime,

    arrivalTime:
      last.arrivalTime,

    waitMinutes,
    rideMinutes,
    transferWaitMinutes,

    totalTransitMinutes:
      waitMinutes +
      rideMinutes +
      transferWaitMinutes,

    legs
  };
}

function routePassesStop(
  routeId,
  referenceStopId
) {
  const trips =
    db.tripsByRoute.get(routeId) || [];

  for (const tripId of trips) {
    const sequence =
      findStopTimesForTrip(tripId);

    if (
      sequence.some(
        row =>
          row.stop_id ===
          referenceStopId
      )
    ) {
      return true;
    }
  }

  return false;
}

function rankJourneys(journeys) {
  return journeys
    .sort((a, b) => {
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
    })
    .slice(0, 20);
}

/* -------------------------------------------------------
   HEALTH
------------------------------------------------------- */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "Konya Ulaşım Plus API",
    loaded: db.loaded,
    loading: db.loading,
    loadedAt: db.loadedAt,
    error: db.error,
    stats: {
      stops: db.stops.size,
      routes: db.routes.size,
      trips: db.trips.size,
      stopTimes: db.stopTimeRows.length
    },
    timezone: "Europe/Istanbul",
    source:
      "Konya Büyükşehir Belediyesi Açık Veri Platformu"
  });
});

/* -------------------------------------------------------
   STOPS
------------------------------------------------------- */

app.get("/api/stops", (req, res) => {
  if (!requireData(res)) return;

  const q = String(req.query.q || "");
  const limit = Math.min(
    Number(req.query.limit) || 100,
    500
  );

  let stops;

  if (q.trim()) {
    stops = findStops(q, limit);
  } else {
    stops = [...db.stops.values()]
      .slice(0, limit)
      .map(normalizeStop);
  }

  res.json({
    ok: true,
    count: stops.length,
    stops
  });
});

app.get("/api/stops/nearby", (req, res) => {
  if (!requireData(res)) return;

  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);

  const radius = Math.min(
    Math.max(
      Number(req.query.radius) || 1500,
      100
    ),
    5000
  );

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon)
  ) {
    return res.status(400).json({
      ok: false,
      error:
        "Geçerli lat ve lon gönderilmelidir."
    });
  }

  const stops = getNearbyStops(
    lat,
    lon,
    radius
  );

  res.json({
    ok: true,
    origin: {
      lat,
      lon
    },
    radiusMeters: radius,
    count: stops.length,
    stops
  });
});

app.get("/api/stops/:stopId", (req, res) => {
  if (!requireData(res)) return;

  const stop =
    getStop(req.params.stopId);

  if (!stop) {
    return res.status(404).json({
      ok: false,
      error: "Durak bulunamadı."
    });
  }

  const routes =
    (db.routesByStop.get(
      stop.stop_id
    ) || [])
      .map(routeInfo)
      .filter(Boolean);

  res.json({
    ok: true,
    stop: normalizeStop(stop),
    routes
  });
});

/* -------------------------------------------------------
   ROUTES
------------------------------------------------------- */

app.get("/api/routes", (req, res) => {
  if (!requireData(res)) return;

  const q = normalizeText(
    req.query.q || ""
  );

  let routes = [...db.routes.values()];

  if (q) {
    routes = routes.filter(route => {
      return (
        normalizeText(
          route.route_short_name
        ).includes(q) ||
        normalizeText(
          route.route_long_name
        ).includes(q)
      );
    });
  }

  res.json({
    ok: true,
    count: routes.length,
    routes: routes
      .slice(0, 500)
      .map(routeInfo)
  });
});

app.get(
  "/api/routes/:routeId",
  (req, res) => {
    if (!requireData(res)) return;

    const route =
      routeInfo(req.params.routeId);

    if (!route) {
      return res.status(404).json({
        ok: false,
        error: "Hat bulunamadı."
      });
    }

    const tripIds =
      db.tripsByRoute.get(
        req.params.routeId
      ) || [];

    const stopMap = new Map();

    for (const tripId of tripIds) {
      const sequence =
        findStopTimesForTrip(tripId);

      for (const row of sequence) {
        const stop =
          getStop(row.stop_id);

        if (stop) {
          stopMap.set(
            stop.stop_id,
            normalizeStop(stop)
          );
        }
      }
    }

    res.json({
      ok: true,
      route,
      stops: [...stopMap.values()]
    });
  }
);

/* -------------------------------------------------------
   JOURNEY
------------------------------------------------------- */

app.post(
  "/api/journey/calculate",
  (req, res) => {
    if (!requireData(res)) return;

    const body = req.body || {};

    const origin =
      body.origin || {};

    const destination =
      body.destination || {};

    let originStopId =
      origin.stopId || null;

    let destinationStopId =
      destination.stopId || null;

    if (
      !originStopId &&
      Number.isFinite(Number(origin.lat)) &&
      Number.isFinite(Number(origin.lon))
    ) {
      const nearby =
        getNearbyStops(
          Number(origin.lat),
          Number(origin.lon),
          2500
        );

      originStopId =
        nearby[0]?.id || null;
    }

    if (!destinationStopId) {
      const destinationStop =
        findStopByName(
          destination.name
        );

      destinationStopId =
        destinationStop?.stop_id ||
        null;
    }

    if (!originStopId) {
      return res.status(400).json({
        ok: false,
        error:
          "Başlangıç durağı bulunamadı."
      });
    }

    if (!destinationStopId) {
      return res.status(400).json({
        ok: false,
        error:
          "Varış durağı bulunamadı."
      });
    }

    if (
      originStopId ===
      destinationStopId
    ) {
      return res.json({
        ok: true,
        journeys: [],
        message:
          "Başlangıç ve varış durağı aynı."
      });
    }

    const originStop =
      getStop(originStopId);

    const destinationStop =
      getStop(destinationStopId);

    if (
      !originStop ||
      !destinationStop
    ) {
      return res.status(404).json({
        ok: false,
        error:
          "Başlangıç veya varış durağı bulunamadı."
      });
    }

    const nowSeconds =
      secondsSinceMidnightTurkey();

    const walkingMeters =
      Number(origin.walkingMeters) || 0;

    const walking =
      walkingMinutes(walkingMeters) || 0;

    const direct =
      findDirectJourneys(
        originStopId,
        destinationStopId,
        nowSeconds
      );

    const transferRaw =
      buildTransferJourneys(
        originStopId,
        destinationStopId,
        nowSeconds,
        3
      );

    const transfer =
      transferRaw
        .map(journey =>
          flattenTransferJourney(
            journey,
            nowSeconds
          )
        )
        .filter(Boolean);

    const all = [
      ...direct.map(item => ({
        ...item,
        walkingMinutes: walking,
        totalDurationMinutes:
          walking +
          item.totalTransitMinutes
      })),

      ...transfer.map(item => ({
        ...item,
        walkingMinutes: walking,
        totalDurationMinutes:
          walking +
          item.totalTransitMinutes
      }))
    ];

    const importantStops =
      Array.isArray(
        body.importantStops
      )
        ? body.importantStops
        : [];

    const referenceName =
      body?.routeDirection
        ?.referenceStop ||
      "Numune Hastanesi";

    const referenceStop =
      findStopByName(referenceName);

    const directionAnalysis = all.map(
      journey => {
        let passesReference =
          false;

        if (
          referenceStop &&
          journey.route?.id
        ) {
          passesReference =
            routePassesStop(
              journey.route.id,
              referenceStop.stop_id
            );
        }

        return {
          ...journey,
          directionValidation: {
            referenceStop:
              referenceStop
                ? normalizeStop(
                    referenceStop
                  )
                : null,
            passesReference
          }
        };
      }
    );

    const ranked =
      rankJourneys(
        directionAnalysis
      );

    res.json({
      ok: true,

      source:
        "Konya Büyükşehir Belediyesi Açık Veri Platformu / GTFS",

      generatedAt:
        new Date().toISOString(),

      timezone:
        "Europe/Istanbul",

      currentTime:
        secondsToClock(nowSeconds),

      origin: {
        stop: normalizeStop(
          originStop
        ),
        walkingMeters,
        walkingMinutes: walking
      },

      destination: {
        stop: normalizeStop(
          destinationStop
        )
      },

      importantStops,

      routeDirection: {
        referenceStop:
          referenceStop
            ? normalizeStop(
                referenceStop
              )
            : null,
        outboundChecked:
          Boolean(
            body?.routeDirection
              ?.checkOutbound
          ),
        inboundChecked:
          Boolean(
            body?.routeDirection
              ?.checkInbound
          )
      },

      count: ranked.length,

      journeys: ranked
    });
  }
);

/* -------------------------------------------------------
   LIVE ATUS
------------------------------------------------------- */

app.get(
  "/api/live/:stopId",
  async (req, res) => {
    if (!requireData(res)) return;

    const stop =
      getStop(req.params.stopId);

    if (!stop) {
      return res.status(404).json({
        ok: false,
        error: "Durak bulunamadı."
      });
    }

    /*
      ÖNEMLİ:
      Burada doğrulanmış ATUS canlı API endpoint'i
      olmadığı için sahte GPS/araç üretmiyoruz.

      ATUS'un resmi "Otobüsüm Nerede" sayfası
      canlı bilgilerin yaklaşık her dakika yenilendiğini
      belirtiyor.

      API adresi doğrulandığında yalnızca bu bölüm
      gerçek zamanlı araç verisiyle değiştirilecek.
    */

    res.json({
      ok: true,

      stop: normalizeStop(stop),

      liveAvailable: false,

      vehicles: [],

      arrivals: [],

      updatedAt: new Date().toISOString(),

      message:
        "Doğrulanmış ATUS canlı araç API'si bulunmadan sahte canlı konum gösterilmiyor.",

      officialSource:
        "https://atus.konya.bel.tr/atus/otobusum-nerede"
    });
  }
);

/* -------------------------------------------------------
   APP INFO
------------------------------------------------------- */

app.get("/api/app-info", (req, res) => {
  res.json({
    ok: true,

    name: "Konya Ulaşım Plus",

    version: "4.0.0",

    city: "Konya",

    timezone: "Europe/Istanbul",

    features: [
      "Gerçek Konya GTFS verisi",
      "Durak arama",
      "Yakındaki duraklar",
      "Yürüme mesafesi",
      "Yürüme süresi",
      "Gerçek tarifeli seferler",
      "Sefer bekleme süresi",
      "Tahmini varış saati",
      "Hat ve güzergah bilgisi",
      "Direkt rota",
      "Aktarmalı rota",
      "3 aktarmaya kadar rota analizi",
      "Rota yönü kontrolü",
      "Numune Hastanesi referans kontrolü",
      "Sıralı rota önerileri"
    ],

    dataSource:
      "Konya Büyükşehir Belediyesi Açık Veri Platformu"
  });
});

/* -------------------------------------------------------
   404
------------------------------------------------------- */

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({
      ok: false,
      error: "API endpoint bulunamadı."
    });
  }

  res.sendFile(
    `${process.cwd()}/index.html`
  );
});

/* -------------------------------------------------------
   ERROR HANDLER
------------------------------------------------------- */

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

    res.status(500).json({
      ok: false,
      error:
        "Sunucu tarafında beklenmeyen bir hata oluştu."
    });
  }
);

/* -------------------------------------------------------
   START
------------------------------------------------------- */

app.listen(
  PORT,
  HOST,
  async () => {
    console.log(
      `Konya Ulaşım Plus çalışıyor: ${HOST}:${PORT}`
    );

    console.log(
      "GTFS ilk yükleme başlıyor..."
    );

    await refreshGTFS();

    setInterval(
      refreshGTFS,
      DATA_REFRESH_MS
    );
  }
);
