import { randomUUID } from "node:crypto";
import { secureRng, type Rng } from "@old-maid/shared";
import { AuthService } from "../auth/authService.js";
import { AdminAuthService } from "../auth/adminAuth.js";
import type { Env } from "../config/env.js";
import { RoomManager } from "../rooms/roomManager.js";
import type { Timing } from "../rooms/roomTypes.js";
import { SocketRegistry } from "../socket/registry.js";
import { MemoryActiveStateStore, MemoryStore } from "../store/memory.js";
import { MongoStore } from "../store/mongo.js";
import type { ActiveStateStore, Store } from "../store/types.js";
import type { Logger } from "../util/logger.js";
import { realScheduler, type Scheduler } from "../util/scheduler.js";
import { SettingsService } from "./settingsService.js";

export interface Services {
  env: Env;
  log: Logger;
  store: Store;
  active: ActiveStateStore;
  settings: SettingsService;
  auth: AuthService;
  /** Phase 4. Separate identity/session boundary from the player `auth`. */
  adminAuth: AdminAuthService;
  registry: SocketRegistry;
  rooms: RoomManager;
  startedAt: number;
  instanceId: string;
}

export interface ServiceOptions {
  store?: Store;
  scheduler?: Scheduler;
  rng?: Rng;
  timing?: Partial<Timing>;
  codeGen?: () => string;
}

/** Composition root. Keeps rules in shared/, authority in rooms/, transport in socket/ + routes/. */
export async function createServices(env: Env, log: Logger, opts: ServiceOptions = {}): Promise<Services> {
  let store = opts.store;
  if (!store) {
    if (env.mongoUri) {
      const m = new MongoStore(env.mongoUri);
      await m.connect();
      store = m;
      log.info("MongoDB connected");
    } else {
      log.warn("MONGODB_URI not set – using the in-memory store (data is lost on restart)");
      store = new MemoryStore();
    }
  }
  const settings = new SettingsService(store, log);
  await settings.load();
  const adminAuth = new AdminAuthService(store, log);
  const active = new MemoryActiveStateStore();
  const registry = new SocketRegistry();
  const rooms = new RoomManager({
    store, active, settings, log, emitter: registry,
    scheduler: opts.scheduler ?? realScheduler,
    rng: opts.rng ?? secureRng,
    ...(opts.codeGen ? { codeGen: opts.codeGen } : {}),
    ...(opts.timing ? { timing: opts.timing } : {}),
  });
  return { env, log, store, active, settings, auth: new AuthService(store, env.jwtAccessSecret), adminAuth, registry, rooms, startedAt: Date.now(), instanceId: randomUUID() };
}
