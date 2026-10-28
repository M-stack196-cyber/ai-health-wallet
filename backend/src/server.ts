import { DatabaseConfigurationError } from "./config/env.js";
import { AuthenticationConfigurationError } from "./config/auth.js";
import { DocumentConfigurationError } from "./config/documents.js";

async function start(): Promise<void> {
  // Dynamic imports let us report configuration failures safely at startup.
  const { default: app } = await import("./app.js");
  const { closeDatabasePool } = await import("./database/pool.js");
  const PORT = Number(process.env.PORT || 5000);
  const server = app.listen(PORT, () => {
    console.log(
      `AI Health Wallet backend running on http://localhost:${PORT}`
    );
  });

  let stopping = false;
  const shutdown = (exitCode = 0): void => {
    if (stopping) return;
    stopping = true;

    const deadline = setTimeout(() => {
      console.error("Backend shutdown timed out.");
      server.closeAllConnections();
      process.exit(1);
    }, 10000);
    deadline.unref();

    server.close(async () => {
      try {
        await closeDatabasePool();
        clearTimeout(deadline);
        process.exitCode = exitCode;
      } catch {
        console.error("Database pool shutdown failed.");
        process.exit(1);
      }
    });
  };

  server.on("error", () => {
    console.error("Backend HTTP server failed to start or encountered an error.");
    shutdown(1);
  });
  process.once("SIGINT", () => shutdown());
  process.once("SIGTERM", () => shutdown());
}

start().catch((error: unknown) => {
  console.error(
    (error instanceof DatabaseConfigurationError || error instanceof AuthenticationConfigurationError || error instanceof DocumentConfigurationError)
      ? "Invalid backend configuration: " + error.message
      : "Backend startup failed. Check the local configuration."
  );
  process.exitCode = 1;
});
