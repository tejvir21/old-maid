import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Runs the backend test suite against a REAL MongoDB.
 *
 *   npx tsx scripts/withMongo.ts                      # all backend tests
 *   npx tsx scripts/withMongo.ts --reporter=basic tests/http.test.ts
 *
 * By default it starts an ephemeral, disposable mongod. That needs an optional package which is
 * intentionally NOT a committed dependency (it downloads a ~100 MB binary at install time and
 * would slow down CI and deploys):
 *
 *   npm install --no-save mongodb-memory-server
 *
 * Alternatively point it at an existing disposable database:
 *   MONGODB_TEST_URI=mongodb://127.0.0.1:27017/oldmaid_test npx tsx scripts/withMongo.ts
 */
async function startMongo(): Promise<{ uri: string; stop: () => Promise<void> }> {
  const external = process.env["MONGODB_TEST_URI"];
  if (external) return { uri: external, stop: async () => undefined };

  let MongoMemoryServer: typeof import("mongodb-memory-server").MongoMemoryServer;
  try {
    ({ MongoMemoryServer } = await import("mongodb-memory-server"));
  } catch {
    console.error(
      "\n  mongodb-memory-server is not installed.\n\n" +
      "  Install it (dev-only, not committed):\n" +
      "      npm install --no-save mongodb-memory-server\n\n" +
      "  Or point at an existing disposable database:\n" +
      "      MONGODB_TEST_URI=mongodb://127.0.0.1:27017/oldmaid_test npx tsx scripts/withMongo.ts\n",
    );
    process.exit(1);
  }
  const mongod = await MongoMemoryServer.create();
  return { uri: mongod.getUri("oldmaid_test"), stop: () => mongod.stop() };
}

const mongo = await startMongo();
console.log(`[withMongo] mongod ready (${mongo.uri.replace(/\/\/.*@/, "//***@")})\n`);

const args = process.argv.slice(2);
const vitestBin = fileURLToPath(import.meta.resolve("vitest/vitest.mjs"));
const child = spawn(process.execPath, [vitestBin, "run", ...args], {
  env: { ...process.env, MONGODB_TEST_URI: mongo.uri, NODE_ENV: "test" },
  stdio: "inherit",
  cwd: process.cwd(),
});

const code: number = await new Promise((res) => child.on("exit", (c) => res(c ?? 1)));
await mongo.stop();
console.log(`\n[withMongo] done (exit ${code})`);
process.exit(code);