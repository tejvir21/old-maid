import { createServer } from "node:http";
import { loadEnv } from "./config/env.js";
import { createApp } from "./app.js";
import { createServices } from "./services/container.js";
import { attachSocketGateway } from "./socket/socket.js";
import { createLogger } from "./util/logger.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger(env.logLevel);
  log.info("starting", { env: env.nodeEnv, port: env.port });

  const services = await createServices(env, log);
  const app = createApp(services);
  const httpServer = createServer(app);
  const gateway = attachSocketGateway(httpServer, {
    rooms: services.rooms, registry: services.registry, store: services.store, log,
    jwtSecret: env.jwtAccessSecret, allowedOrigins: env.allowedOrigins,
  });

  const sweeper = setInterval(() => {
    try {
      const n = services.rooms.sweep();
      if (n) log.info("expired rooms swept", { count: n });
    } catch (e) {
      log.error("sweep failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }, 30_000);
  sweeper.unref();

  await new Promise<void>((resolve) => httpServer.listen(env.port, resolve));
  log.info("listening", { port: env.port });

  const shutdown = async (signal: string) => {
    log.info("shutting down", { signal });
    clearInterval(sweeper);
    await gateway.close().catch(() => undefined);
    httpServer.close();
    await services.store.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((e: unknown) => {
  // eslint-disable-next-line no-console
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
