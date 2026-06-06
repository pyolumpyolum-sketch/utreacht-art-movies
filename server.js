import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const PORT = Number(process.env.PORT || 3000);
const ROOT = process.cwd();
const CACHE_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 7000;
const PAGE_CONCURRENCY = 18;

const theaters = [
  {
    id: "springhaver",
    name: "Springhaver",
    host: "springhaver.nl",
    agenda: "https://springhaver.nl/agenda/",
    fallbackAgenda: "https://www.biosagenda.nl/films-bioscoop_springhaver-theater_262.html",
  },
  {
    id: "hartlooper",
    name: "Louis Hartlooper",
    host: "hartlooper.nl",
    agenda: "https://hartlooper.nl/agenda/",
    fallbackAgenda: "https://www.biosagenda.nl/films-bioscoop_louis-hartlooper-complex_581.html",
  },
  {
    id: "slachtstraat",
    name: "Slachtstraat",
    host: "slachtstraat.nl",
    agenda: "https://slachtstraat.nl/agenda/",
    fallbackAgenda: "https://www.biosagenda.nl/films-bioscoop_slachtstraat_1043.html",
  },
];

const cache = new Map();
const pendingLoads = new Map();

function sendJson(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(data));
}

function isValidIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00`));
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&rsquo;/g, "'")
    .replace(/&ndash;/g, "-")
    .replace(/&eacute;/g, "e");
}

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "UtrechtFilmTimes/1.0" },
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function discoverFilmLinks(html, theater) {
  const links = new Set();
  const hrefPattern = /href=["']([^"']*\/films\/[^"']+)["']/gi;
  let match;

  while ((match = hrefPattern.exec(html))) {
    try {
      const url = new URL(decodeHtml(match[1]), theater.agenda);
      if (url.hostname === theater.host && url.pathname.startsWith("/films/")) {
        url.hash = "";
        url.search = "";
        links.add(url.href);
      }
    } catch {
      // Ignore malformed links from source HTML.
    }
  }

  return [...links];
}

function collectGraphItems(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(collectGraphItems);
  if (Array.isArray(value["@graph"])) return value["@graph"];
  return [value];
}

function parseScreenings(html, theater, pageUrl) {
  const scripts = html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );
  const screenings = [];
  let movieUrl = pageUrl;

  for (const script of scripts) {
    try {
      const data = JSON.parse(script[1].trim());
      for (const item of collectGraphItems(data)) {
        if (item["@type"] === "Movie" && item.url) {
          movieUrl = item.url;
        }

        if (item["@type"] !== "ScreeningEvent" || !item.startDate || !item.name) {
          continue;
        }

        const date = item.startDate.slice(0, 10);
        const time = item.startDate.slice(11, 16);
        if (!isValidIsoDate(date) || !/^\d{2}:\d{2}$/.test(time)) {
          continue;
        }

        screenings.push({
          id: item.identifier || item.url || `${pageUrl}-${item.startDate}`,
          movie: decodeHtml(item.name),
          date,
          time,
          theater: theater.name,
          theaterId: theater.id,
          source: movieUrl,
          ticketUrl: item.url || movieUrl,
        });
      }
    } catch {
      // Some pages may contain unrelated JSON-LD. Skip anything we cannot parse.
    }
  }

  return screenings;
}

const dutchMonths = new Map([
  ["jan", "01"],
  ["feb", "02"],
  ["mrt", "03"],
  ["mar", "03"],
  ["apr", "04"],
  ["mei", "05"],
  ["jun", "06"],
  ["jul", "07"],
  ["aug", "08"],
  ["sep", "09"],
  ["okt", "10"],
  ["oct", "10"],
  ["nov", "11"],
  ["dec", "12"],
]);

function stripTags(value) {
  return decodeHtml(String(value || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function rowDateToIso(day, monthName) {
  const month = dutchMonths.get(monthName.toLowerCase());
  if (!month) return "";

  const year = new Date().getFullYear();
  return `${year}-${month}-${String(day).padStart(2, "0")}`;
}

function getBiosagendaBlocks(html) {
  const starts = [...html.matchAll(/<div class="filterByFilm"\b/gi)].map((match) => match.index);
  return starts.map((start, index) => html.slice(start, starts[index + 1] || html.length));
}

function parseBiosagendaEvents(html, theater) {
  const events = [];

  for (const block of getBiosagendaBlocks(html)) {
    const titleMatch = block.match(/<h3[^>]*itemprop=["']name["'][^>]*>([\s\S]*?)<\/h3>/i);
    const movie = stripTags(titleMatch?.[1] || "");
    if (!movie) continue;

    const rows = block.matchAll(/\b(?:ma|di|wo|do|vr|za|zo)\s+(\d{1,2})\s+([a-z]{3})\s*\|\s*([^<]+)/gi);
    for (const row of rows) {
      const date = rowDateToIso(row[1], row[2]);
      if (!date) continue;

      const times = row[3].match(/\d{2}:\d{2}/g) || [];
      for (const time of times) {
        events.push({
          id: `biosagenda-${theater.id}-${movie}-${date}-${time}`,
          movie,
          date,
          time,
          theater: theater.name,
          theaterId: theater.id,
          source: theater.fallbackAgenda,
          ticketUrl: theater.fallbackAgenda,
        });
      }
    }
  }

  return events;
}

async function mapConcurrent(items, limit, callback) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await callback(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function getTheaterEvents(theater) {
  const cached = cache.get(theater.id);
  if (cached && Date.now() - cached.createdAt < CACHE_MS) {
    return cached.events;
  }

  if (pendingLoads.has(theater.id)) {
    return pendingLoads.get(theater.id);
  }

  const load = loadTheaterEvents(theater);
  pendingLoads.set(theater.id, load);

  try {
    const events = await load;
    cache.set(theater.id, { createdAt: Date.now(), events });
    return events;
  } catch (error) {
    if (cached) return cached.events;
    throw error;
  } finally {
    pendingLoads.delete(theater.id);
  }
}

async function loadTheaterEvents(theater) {
  let agendaHtml;
  try {
    agendaHtml = await fetchText(theater.agenda);
  } catch (error) {
    if (!theater.fallbackAgenda) throw error;
    const fallbackHtml = await fetchText(theater.fallbackAgenda);
    return parseBiosagendaEvents(fallbackHtml, theater);
  }

  const links = discoverFilmLinks(agendaHtml, theater);

  const pages = await mapConcurrent(links, PAGE_CONCURRENCY, async (link) => {
    try {
      return parseScreenings(await fetchText(link), theater, link);
    } catch {
      return [];
    }
  });

  const seen = new Set();
  const events = pages
    .flat()
    .filter((event) => {
      const key = `${event.theaterId}-${event.id}-${event.date}-${event.time}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.movie.localeCompare(b.movie));

  if (events.length === 0 && theater.fallbackAgenda) {
    const fallbackHtml = await fetchText(theater.fallbackAgenda);
    return parseBiosagendaEvents(fallbackHtml, theater).sort(
      (a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.movie.localeCompare(b.movie),
    );
  }

  return events;
}

async function getShowtimes(date) {
  const sources = [];
  const warnings = [];
  const theaterResults = await Promise.all(
    theaters.map(async (theater) => {
      sources.push(theater.agenda);
      try {
        const events = await getTheaterEvents(theater);
        return events.filter((event) => event.date === date);
      } catch (error) {
        warnings.push(`${theater.name}: ${error.message}`);
        return [];
      }
    }),
  );

  const flatEvents = theaterResults.flat();
  const grouped = new Map();

  for (const event of flatEvents) {
    const key = `${event.movie}|${event.theater}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        movie: event.movie,
        theater: event.theater,
        theaterId: event.theaterId,
        source: event.source,
        times: [],
      });
    }
    grouped.get(key).times.push({ time: event.time, ticketUrl: event.ticketUrl });
  }

  const movies = [...grouped.values()]
    .map((movie) => ({
      ...movie,
      times: movie.times.sort((a, b) => a.time.localeCompare(b.time)),
    }))
    .sort((a, b) => a.times[0].time.localeCompare(b.times[0].time) || a.movie.localeCompare(b.movie));

  return {
    date,
    fetchedAt: new Date().toISOString(),
    theaters: theaters.map(({ id, name }) => ({ id, name })),
    sources,
    warnings,
    movies,
  };
}

async function handleApi(request, response, url) {
  if (url.pathname !== "/api/showtimes") {
    sendJson(response, 404, { error: "Unknown API route." });
    return;
  }

  const date = url.searchParams.get("date") || new Date().toISOString().slice(0, 10);
  if (!isValidIsoDate(date)) {
    sendJson(response, 400, { error: "Use a date in YYYY-MM-DD format." });
    return;
  }

  try {
    sendJson(response, 200, await getShowtimes(date));
  } catch (error) {
    sendJson(response, 502, {
      error: "Could not load the cinema schedules right now.",
      detail: error.message,
    });
  }
}

async function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const safePath = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const fullPath = join(ROOT, safePath);
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
  };

  try {
    const file = await readFile(fullPath);
    response.writeHead(200, {
      "Content-Type": types[extname(fullPath)] || "application/octet-stream",
    });
    response.end(file);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname.startsWith("/api/")) {
    await handleApi(request, response, url);
    return;
  }

  await serveStatic(response, url.pathname);
}).listen(PORT, () => {
  console.log(`Utrecht movie times running at http://localhost:${PORT}`);
  Promise.allSettled(theaters.map(getTheaterEvents)).then(() => {
    console.log("Movie schedules warmed.");
  });
});
