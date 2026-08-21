import axios from "axios";
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const OUTPUT_FILE = path.resolve("data", "performances.json");

const BASE_URL = "https://ffn.extranat.fr/webffn";
const SEARCH_URL = `${BASE_URL}/nat_recherche.php?idact=nat`;
const AUTOCOMPLETE_URL = `${BASE_URL}/_recherche.php`;
const MIN_QUERY_LENGTH = 4;
const POOL_LENGTHS = ["25", "50"] as const;

type PoolLength = (typeof POOL_LENGTHS)[number];

interface PersonSuggestion {
  iuf: number;
  ind: string;
  sex: string;
  clb: string;
}

interface Performance {
  pool: `${PoolLength}m`;
  event: string;
  eventCode: string;
  time: string;
  ageCategory: string;
  points: string;
  location: string;
  date: string;
  level: string;
  club: string;
}

interface SearchResults {
  person: PersonSuggestion;
  performances: Performance[];
}

const client = axios.create({
  headers: {
    "User-Agent": "Mozilla/5.0 (compatible; yuu-scraper/1.0)",
    Accept: "text/html, application/json",
  },
  timeout: 15000,
});

function normalizeCell(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function parsePerformances($: CheerioAPI, pool: PoolLength): Performance[] {
  const performances: Performance[] = [];
  let currentEvent = "";

  $("table tr").each((_, tr) => {
    const cells = $(tr)
      .find("td, th")
      .map((__, cell) => normalizeCell($(cell).text()))
      .get();

    if (cells.length === 1) {
      currentEvent = cells[0]!;
      return;
    }

    if (cells.length !== 10) {
      return;
    }

    performances.push({
      pool: `${pool}m`,
      event: currentEvent,
      eventCode: cells[0]!,
      time: cells[1]!,
      ageCategory: cells[2]!,
      points: cells[3]!,
      location: cells[4]!,
      date: cells[5]!,
      level: cells[6]!,
      club: cells[8]!,
    });
  });

  return performances;
}

async function findPeople(query: string): Promise<PersonSuggestion[]> {
  if (query.length < MIN_QUERY_LENGTH) {
    throw new Error(`Query must be at least ${MIN_QUERY_LENGTH} characters`);
  }

  const { data } = await client.get<PersonSuggestion[]>(AUTOCOMPLETE_URL, {
    params: { go: "ind", idrch: query },
  });

  return data;
}

async function getPerformancesForPool(
  person: PersonSuggestion,
  pool: PoolLength,
): Promise<Performance[]> {
  const payload = new URLSearchParams({
    idrch: person.ind,
    idrch_id: String(person.iuf),
    idact: "nat",
    idiuf: String(person.iuf),
    idbas: pool,
    idopt: "prf",
    idepr: "",
  });

  const { data: html } = await client.post<string>(SEARCH_URL, payload, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  return parsePerformances(cheerio.load(html), pool);
}

async function getAllPerformances(
  person: PersonSuggestion,
): Promise<SearchResults> {
  const performances: Performance[] = [];

  for (const pool of POOL_LENGTHS) {
    const poolPerformances = await getPerformancesForPool(person, pool);
    performances.push(...poolPerformances);
  }

  return { person, performances };
}

async function searchSwimmer(
  query: string,
  pickIndex: number | undefined,
): Promise<SearchResults> {
  const people = await findPeople(query);

  if (people.length === 0) {
    throw new Error(`No swimmer found for "${query}"`);
  }

  if (people.length > 1 && pickIndex === undefined) {
    console.error(`Found ${people.length} matches for "${query}":`);
    people.forEach((person, index) => {
      console.error(`  [${index}] ${person.ind}`);
    });
    throw new Error(
      "Several swimmers match. Re-run with the index of the right one.\n" +
        `Example: npm run scrap -- ${query} 1`,
    );
  }

  const index = pickIndex ?? 0;

  if (index < 0 || index >= people.length) {
    throw new Error(
      `Invalid index ${index}. Found ${people.length} match(es).`,
    );
  }

  return getAllPerformances(people[index]!);
}

function parseArgs(argv: string[]): {
  query: string;
  pickIndex: number | undefined;
} {
  const args = [...argv];

  let pickIndex: number | undefined;
  const lastArg = args.at(-1);
  if (lastArg !== undefined && /^\d+$/.test(lastArg)) {
    pickIndex = Number(lastArg);
    args.pop();
  }

  const query = args.join(" ").trim();
  if (!query) {
    throw new Error(
      "Usage: npm run scrap -- <name query (min 4 chars)> [index]\n" +
        'Example: npm run scrap -- "marchand leon"\n' +
        "Example: npm run scrap -- marchand 2",
    );
  }

  return { query, pickIndex };
}

function loadExisting(): SearchResults[] {
  if (!existsSync(OUTPUT_FILE)) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(OUTPUT_FILE, "utf8"));
    return Array.isArray(parsed) ? (parsed as SearchResults[]) : [];
  } catch {
    console.error(`Warning: could not parse ${OUTPUT_FILE}, starting fresh.`);
    return [];
  }
}

function saveResults(results: SearchResults): void {
  const existing = loadExisting();
  const index = existing.findIndex(
    (entry) => entry.person.iuf === results.person.iuf,
  );

  if (index >= 0) {
    existing[index] = results;
  } else {
    existing.push(results);
  }

  mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  writeFileSync(OUTPUT_FILE, `${JSON.stringify(existing, null, 2)}\n`);
  console.error(`Saved to ${OUTPUT_FILE}`);
}

async function main(): Promise<void> {
  try {
    const { query, pickIndex } = parseArgs(process.argv.slice(2));
    const results = await searchSwimmer(query, pickIndex);
    saveResults(results);
    console.error(`Found ${results.performances.length} performances.\n`);
    console.log(JSON.stringify(results, null, 2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Scraping failed:", message);
    process.exitCode = 1;
  }
}

main();
