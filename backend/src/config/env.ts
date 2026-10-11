import { z } from "zod";

const DEV_SECRET = "dev-only-insecure-secret-change-me-0123456789";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(10000),
  CLIENT_URL: z.string().url().optional(),
  ALLOWED_ORIGINS: z.string().optional(),
  MONGODB_URI: z.string().min(1).optional(),
  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters").optional(),
  JWT_REFRESH_SECRET: z.string().min(32).optional(),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),
});

export interface Env {
  nodeEnv: "development" | "test" | "production";
  isProduction: boolean;
  port: number;
  allowedOrigins: string[];
  mongoUri: string | null;
  jwtAccessSecret: string;
  jwtRefreshSecret: string;
  logLevel: "debug" | "info" | "warn" | "error" | "silent";
}

export class EnvError extends Error {}

/** Validates the environment once at start-up. Throws EnvError with a readable list of problems. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new EnvError(
      "Invalid environment: " + parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === "production";
  const origins = [
    ...(e.CLIENT_URL ? [e.CLIENT_URL] : []),
    ...(e.ALLOWED_ORIGINS ? e.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean) : []),
  ].map((o) => o.replace(/\/$/, ""));

  const problems: string[] = [];
  if (origins.includes("*")) problems.push("ALLOWED_ORIGINS must not contain '*'");
  if (isProduction) {
    if (origins.length === 0) problems.push("CLIENT_URL or ALLOWED_ORIGINS is required in production");
    if (!e.JWT_ACCESS_SECRET) problems.push("JWT_ACCESS_SECRET is required in production");
    if (!e.MONGODB_URI) problems.push("MONGODB_URI is required in production");
  }
  if (problems.length) throw new EnvError("Invalid environment: " + problems.join("; "));

  return {
    nodeEnv: e.NODE_ENV,
    isProduction,
    port: e.PORT,
    allowedOrigins: origins.length ? origins : ["http://localhost:5173", "http://127.0.0.1:5173"],
    mongoUri: e.MONGODB_URI ?? null,
    jwtAccessSecret: e.JWT_ACCESS_SECRET ?? DEV_SECRET,
    jwtRefreshSecret: e.JWT_REFRESH_SECRET ?? e.JWT_ACCESS_SECRET ?? DEV_SECRET + "-refresh",
    logLevel: e.LOG_LEVEL,
  };
}
