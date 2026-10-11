import { createHash, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";

export const PLAYER_AUDIENCE = "old-maid:player";
const ISSUER = "old-maid";

export interface PlayerClaims { userId: string }

export function signPlayerToken(secret: string, userId: string, ttlSec = 12 * 3600): string {
  return jwt.sign({}, secret, { subject: userId, audience: PLAYER_AUDIENCE, issuer: ISSUER, expiresIn: ttlSec, algorithm: "HS256" });
}

/** Returns null for any invalid/expired/wrong-audience token (e.g. an admin token). */
export function verifyPlayerToken(secret: string, token: string): PlayerClaims | null {
  try {
    const p = jwt.verify(token, secret, { audience: PLAYER_AUDIENCE, issuer: ISSUER, algorithms: ["HS256"] });
    if (typeof p === "string" || !p.sub) return null;
    return { userId: p.sub };
  } catch {
    return null;
  }
}

/** Long-lived bearer secret kept in the browser; only its hash is stored server-side. */
export function newSessionSecret(): { secret: string; hash: string } {
  const secret = randomBytes(24).toString("base64url");
  return { secret, hash: hashSession(secret) };
}
export const hashSession = (secret: string): string => createHash("sha256").update(secret).digest("hex");
