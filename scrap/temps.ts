import {
  findPeople,
  getAllPerformances,
  upsertSwimmer,
} from "./ffn";

function parseArgs(
  argv: string[],
): { query: string; pickIndex: number | undefined } {
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

async function main(): Promise<void> {
  try {
    const { query, pickIndex } = parseArgs(process.argv.slice(2));
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
      throw new Error(`Invalid index ${index}. Found ${people.length} match(es).`);
    }

    const results = await getAllPerformances(people[index]!);
    upsertSwimmer(results);
    console.error(`Saved ${results.performances.length} performances.\n`);
    console.log(JSON.stringify(results, null, 2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Scraping failed:", message);
    process.exitCode = 1;
  }
}

main();
