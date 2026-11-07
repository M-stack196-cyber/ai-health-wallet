// LOCAL DEMO API ONLY. Same app as server.ts, plus the explicit opt-in the app requires for the offline summary routes
// (summaries are never enabled by normal startup). Refuses to run outside the generated local environment.
import { assertLocalStack } from "./guard.js";

assertLocalStack(process.env);
const { createApp } = await import("../app.js");
const { pool, closeDatabasePool } = await import("../database/pool.js");
const { sourceCatalogue } = await import("../summaries/catalogue.js");
if (process.env.SUMMARY_PROVIDER !== "synthetic-offline") throw new Error("Offline summary configuration required.");
const app = createApp({ summaries: { enabled: true, database: pool, catalogue: sourceCatalogue } });
const server = app.listen(Number(process.env.PORT || 5000), "127.0.0.1", () => console.log("Local demo API on http://127.0.0.1:" + (process.env.PORT || 5000)));
const stop = () => { server.closeAllConnections(); server.close(() => void closeDatabasePool().finally(() => process.exit(0))); };
process.once("SIGINT", stop); process.once("SIGTERM", stop);
