import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PersonSuggestion, Performance, SearchResults } from "./ffn";
import { OUTPUT_FILE } from "./ffn";

export const RECORDS_DIR = path.resolve("data");
const CLUB_RE = /villeurbanne\s+natation/i;
const MALE_RE = /\)\s*H\b/;
const AGE_MIN = 9;
const AGE_MAX_PLUS = 10;

type Rows = string[][];

function parseCsv(text: string): Rows {
  const rows: Rows = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else q = false;
      } else cell += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (c !== "\r") cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function serializeCsv(rows: Rows): string {
  return rows
    .map((r) =>
      r
        .map((c) =>
          /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c,
        )
        .join(","),
    )
    .join("\n") + "\n";
}

function deaccent(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normEvent(code: string): string {
  const n = deaccent(code).toLowerCase().replace(/[.\s]/g, "");
  return n.replace(/bra(?!sse)/g, "br").replace(/papillon/g, "pap").replace(/nage(s?)libre/g, "nl");
}

function parseRecordTime(raw: string): number | null {
  let t = raw.trim();
  if (!t || t === "/") return null;
  let m = t.match(/^(\d+)'(\d{1,2})"(\d{1,2})$/);
  if (!m) m = t.match(/^(\d+):(\d{2})[.,](\d{1,2})$/);
  if (m) return (+m[1]!) * 60 + (+m[2]!) + +(m[3]!.padEnd(2, "0")) / 100;
  m = t.match(/^(\d{1,2})"(\d{1,2})$/);
  if (!m) m = t.match(/^(\d{1,2})[.,](\d{1,2})$/);
  if (m) return +m[1]! + +(m[2]!.padEnd(2, "0")) / 100;
  return null;
}

function fmtRecordTime(sec: number): string {
  const cs = Math.round(sec * 100);
  const m = Math.floor(cs / 6000);
  const rest = cs % 6000;
  const s = Math.floor(rest / 100);
  const cc = String(rest % 100).padStart(2, "0");
  if (m > 0) return `${m}'${String(s).padStart(2, "0")}"${cc}`;
  return `${s}"${cc}`;
}

function perfSeconds(time: string): number | null {
  const t = time.trim().replace(/"/g, ".");
  let m = t.match(/^(\d+):(\d{2}):(\d{2})(?:[.,](\d{1,2}))?$/);
  if (m) return +m[1]! * 3600 + +m[2]! * 60 + +m[3]! + +(m[4] ?? "0").padEnd(2, "0") / 100;
  m = t.match(/^(\d+):(\d{2})(?:[.,](\d{1,2}))?$/);
  if (m) return +m[1]! * 60 + +m[2]! + +(m[3] ?? "0").padEnd(2, "0") / 100;
  return null;
}

function holderName(person: PersonSuggestion): string {
  const tc = (p: string) => p.toLowerCase().replace(/(^|[-' ])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase());
  const [surname, ...first] = String(person.ind).split(" (")[0]!.trim().split(/\s+/);
  return `${first.join(" ")} ${tc(surname!)}`.trim();
}

interface MergeOutcome {
  updated: number;
  text: string;
}

function mergeInto(poolFile: "25m" | "50m", pool: string, person: PersonSuggestion, perfs: Performance[], current: string | null): MergeOutcome {
  if (!existsSync(path.join(RECORDS_DIR, `club-records-${poolFile}.csv`))) {
    return { updated: 0, text: "" };
  }
  const text = current ?? readFileSync(path.join(RECORDS_DIR, `club-records-${poolFile}.csv`), "utf8");
  const rows = parseCsv(text);
  if (rows.length < 3) return { updated: 0, text };

  const rowIndexByEvent = new Map<string, number>();
  rows.forEach((r, i) => {
    if (i >= 2) rowIndexByEvent.set(normEvent(r[0] ?? ""), i);
  });

  let updated = 0;
  for (const p of perfs) {
    if (p.pool !== poolFile) continue;
    const ri = rowIndexByEvent.get(normEvent(p.eventCode));
    if (ri === undefined) continue;
    const age = parseInt((p.ageCategory || "").replace(/\D/g, ""), 10);
    if (!Number.isFinite(age)) continue;
    const col = Math.min(Math.max(age, AGE_MIN) - AGE_MIN, AGE_MAX_PLUS) + 1;
    const newSec = perfSeconds(p.time);
    if (newSec === null) continue;

    const lines = (rows[ri]![col] ?? "").split("\n").map((l) => l.trim());
    const oldSec = parseRecordTime(lines[0] ?? "/");
    if (oldSec === null || newSec >= oldSec) continue;

    const year = p.date.split("/")[2] ?? "";
    rows[ri]![col] = `${fmtRecordTime(newSec)}\n${holderName(person)}\n${year}`;
    updated++;
    console.log(`[records] ${poolFile} ${p.eventCode} ${age} ans : ${lines[0]} -> ${fmtRecordTime(newSec)} (${holderName(person)})`);
  }

  return { updated, text: updated ? serializeCsv(rows) : text };
}

export function eligibleForRecords(person: PersonSuggestion): boolean {
  return CLUB_RE.test(String(person.clb ?? "")) && MALE_RE.test(String(person.ind ?? ""));
}

export function updateClubRecordsFromResults(results: SearchResults): number {
  if (!eligibleForRecords(results.person)) return 0;
  let total = 0;
  for (const pool of ["25m", "50m"] as const) {
    const out = mergeInto(pool, pool, results.person, results.performances, null);
    if (out.updated) {
      writeFileSync(path.join(RECORDS_DIR, `club-records-${pool}.csv`), out.text);
    }
    total += out.updated;
  }
  return total;
}

export function updateClubRecordsFromAll(): number {
  if (!existsSync(OUTPUT_FILE)) return 0;
  const entries = JSON.parse(readFileSync(OUTPUT_FILE, "utf8")) as SearchResults[];
  return entries
    .filter((e) => eligibleForRecords(e.person))
    .reduce((sum, e) => sum + updateClubRecordsFromResults(e), 0);
}
