import { defineConfig, type Plugin } from "vite";
import type { IncomingMessage } from "node:http";
import { findPeople, getAllPerformances, normalizePerson, upsertSwimmer } from "./scrap/ffn";
import { eligibleForRecords, updateClubRecordsFromResults, updateClubRecordsFromAll } from "./scrap/records";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function swimmerApiPlugin(): Plugin {
  return {
    name: "swimmer-api",
    configureServer(server) {
      server.middlewares.use("/api/swimmers", async (req, res, next) => {
        try {
          if (req.method === "POST" && req.url === "/search") {
            const body = JSON.parse((await readBody(req)) || "{}");
            const people = await findPeople(String(body.query ?? "").trim());
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ people }));
            return;
          }
          if (req.method === "POST" && req.url === "/add") {
            const body = JSON.parse((await readBody(req)) || "{}");
            const person = normalizePerson(body);
            if (!person.iuf || !person.ind) {
              throw new Error("Missing iuf or ind");
            }
            const results = await getAllPerformances(person);
            const total = upsertSwimmer(results);
            let recordsUpdated = 0;
            if (eligibleForRecords(person)) {
              recordsUpdated = updateClubRecordsFromResults(results);
            }
            console.log(
              `[swimmer-api] ${person.ind}: ${results.performances.length} performances saved (${total} swimmer(s) in file), ${recordsUpdated} club record(s) improved`,
            );
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, entry: results, total, recordsUpdated }));
            return;
          }
          if (req.method === "POST" && req.url === "/records/backfill") {
            const updated = await Promise.resolve(updateClubRecordsFromAll());
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, updated }));
            return;
          }
        } catch (err) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
          );
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [swimmerApiPlugin()],
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        profile: "profile.html",
        blank: "blank.html",
      },
    },
  },
});
