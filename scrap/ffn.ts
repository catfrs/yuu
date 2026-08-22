import axios from "axios";
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const OUTPUT_FILE = path.resolve("data", "performances.json");

const BASE_URL = "https://ffn.extranat.fr/webffn";
const SEARCH_URL = `${BASE_URL}/nat_recherche.php?idact=nat`;
const AUTOCOMPLETE_URL = `${BASE_URL}/_recherche.php`;
export const MIN_QUERY_LENGTH = 4;
const POOL_LENGTHS = ["25", "50"] as const;

type PoolLength = (typeof POOL_LENGTHS)[number];

export interface PersonSuggestion {
  iuf: string;
  ind: string;
  sex: string;
  clb: string;
}

export interface Performance {
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

export interface SearchResults {
  person: PersonSuggestion;
  performances: Performance[];
}

export const client = axios.create({
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

export async function findPeople(query: string): Promise<PersonSuggestion[]> {
  if (query.length < MIN_QUERY_LENGTH) {
    throw new Error(`Query must be at least ${MIN_QUERY_LENGTH} characters`);
  }

  const { data } = await client.get<PersonSuggestion[]>(AUTOCOMPLETE_URL, {
    params: { go: "ind", idrch: query },
  });

  return Array.isArray(data) ? data : [];
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

export async function getAllPerformances(
  person: PersonSuggestion,
): Promise<SearchResults> {
  const performances: Performance[] = [];

  for (const pool of POOL_LENGTHS) {
    const poolPerformances = await getPerformancesForPool(person, pool);
    performances.push(...poolPerformances);
  }

  return { person, performances };
}

function normalizeSex(sex: unknown): string {
  if (typeof sex === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(sex)) {
    return sex;
  }
  const s = String(sex ?? "").toUpperCase();
  if (s === "F" || s.includes("FEM")) return "#ff66ab";
  return "#1e90ff";
}

export function normalizePerson(raw: PersonSuggestion): PersonSuggestion {
  return {
    iuf: String(raw.iuf),
    ind: String(raw.ind),
    sex: normalizeSex(raw.sex),
    clb: String(raw.clb ?? ""),
  };
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

export function upsertSwimmer(results: SearchResults): number {
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
  return existing.length;
}
