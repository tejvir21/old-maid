import bcrypt from "bcryptjs";
import { z } from "zod";
import { playerNameSchema } from "@old-maid/shared";
import type { Store, UserRecord } from "../store/types.js";
import { AppError } from "../util/errors.js";
import { hashSession, newSessionSecret, signPlayerToken } from "./tokens.js";

export const registerSchema = z.object({
  username: playerNameSchema,
  email: z.string().trim().toLowerCase().email().max(120),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
});
export const loginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(128) });

export interface AuthResult {
  token: string;
  sessionId: string;
  user: PublicUser;
}
export interface PublicUser { id: string; username: string; status: UserRecord["status"]; avatar?: string; isGuest: boolean }

export const toPublicUser = (u: UserRecord): PublicUser => ({
  id: u.id, username: u.username, status: u.status, isGuest: u.status === "guest", ...(u.avatar ? { avatar: u.avatar } : {}),
});

// A dummy hash so login timing does not reveal whether an email exists.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 10);

export class AuthService {
  constructor(private readonly store: Store, private readonly jwtSecret: string) {}

  private async issue(user: UserRecord): Promise<AuthResult> {
    const { secret, hash } = newSessionSecret();
    await this.store.sessions.create(user.id, hash);
    return { token: signPlayerToken(this.jwtSecret, user.id), sessionId: secret, user: toPublicUser(user) };
  }

  async createGuest(): Promise<AuthResult> {
    return this.issue(await this.store.users.createGuest());
  }

  /** Exchanges the stored session secret for a fresh access token. */
  async refresh(sessionId: string): Promise<AuthResult | null> {
    const hash = hashSession(sessionId);
    const s = await this.store.sessions.resolve(hash);
    if (!s) return null;
    const user = await this.store.users.findById(s.userId);
    if (!user || user.status === "banned" || user.status === "suspended") return null;
    await this.store.sessions.touch(hash);
    return { token: signPlayerToken(this.jwtSecret, user.id), sessionId, user: toPublicUser(user) };
  }

  async register(input: z.infer<typeof registerSchema>, guestUserId?: string): Promise<AuthResult> {
    if (await this.store.users.findByEmail(input.email)) throw new AppError("CONFLICT", "That email is already registered.", 409);
    if (await this.store.users.findByUsername(input.username)) throw new AppError("CONFLICT", "That username is taken.", 409);
    const passwordHash = await bcrypt.hash(input.password, 12);
    let user: UserRecord | null = null;
    if (guestUserId) user = await this.store.users.upgradeToAccount(guestUserId, { username: input.username, email: input.email, passwordHash });
    if (!user) user = await this.store.users.createAccount({ username: input.username, email: input.email, passwordHash });
    return this.issue(user);
  }

  async login(input: z.infer<typeof loginSchema>): Promise<AuthResult> {
    const user = await this.store.users.findByEmail(input.email);
    const ok = await bcrypt.compare(input.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !ok || user.status === "banned" || user.status === "suspended") {
      throw new AppError("UNAUTHORIZED", "Invalid email or password.", 401);
    }
    await this.store.users.touchLogin(user.id);
    return this.issue(user);
  }

  async logoutEverywhere(userId: string): Promise<void> {
    await this.store.sessions.revokeAllForUser(userId);
  }
}
