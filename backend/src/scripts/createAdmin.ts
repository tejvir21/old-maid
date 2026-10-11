/**
 * Secure one-time bootstrap for the FIRST SUPER_ADMIN.
 *
 *   npm run create-admin -w backend -- --email you@example.com --username root --role SUPER_ADMIN
 *
 * A password is read from the ADMIN_BOOTSTRAP_PASSWORD environment variable (never from argv,
 * which would leak into the shell history and the process list). No default credentials exist
 * anywhere in this repository. The command refuses to run once any admin already exists.
 */
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { ADMIN_ROLES, adminPasswordSchema, type AdminRole } from "@old-maid/shared";
import { loadEnv } from "../config/env.js";
import { silentLogger } from "../util/logger.js";
import { MongoStore } from "../store/mongo.js";
import type { Store } from "../store/types.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const email = arg("email")?.trim().toLowerCase();
  const username = arg("username")?.trim() ?? "root";
  const role = (arg("role") ?? "SUPER_ADMIN") as AdminRole;

  if (!email) throw new Error("Usage: npm run create-admin -w backend -- --email <email> [--username <name>] [--role SUPER_ADMIN]");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("--email is not a valid address");
  if (!ADMIN_ROLES.includes(role)) throw new Error(`--role must be one of ${ADMIN_ROLES.join(", ")}`);
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  if (!password) {
    throw new Error(
      "Set ADMIN_BOOTSTRAP_PASSWORD in the environment (12+ chars, upper + lower + digit).\n" +
      "It is deliberately not accepted as a command-line argument so it cannot leak into shell history.",
    );
  }
  adminPasswordSchema.parse(password); // throws with a readable message

  const env = loadEnv();
  if (!env.mongoUri) {
    console.error("MONGODB_URI is not set. Admins are persisted in MongoDB; refusing to create an admin in the in-memory store.");
    process.exit(1);
  }

  const store: Store = await (async () => {
    const m = new MongoStore(env.mongoUri as string);
    await m.connect();
    return m;
  })();

  try {
    const existing = await store.admin.admins.list();
    if (existing.length > 0) {
      console.error(`Refusing to bootstrap: ${existing.length} admin account(s) already exist. Use the admin panel (ADMINS_WRITE) to add more.`);
      process.exit(1);
    }
    const rec = await store.admin.admins.create({
      email, username, role, permissions: [],
      passwordHash: await bcrypt.hash(password, 12),
      status: "active", createdBy: "bootstrap",
    });
    console.log(`Created ${role} admin "${rec.username}" <${rec.email}> (id ${rec.id}).`);
    console.log("Store the password in a secret manager now; it is not recoverable.");
  } finally {
    await store.close();
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});