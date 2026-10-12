// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "@old-maid/shared";
import { ApiClient, NetworkError } from "../src/sync/api";
import { createOnlineController } from "../src/store/onlineStore";

/**
 * The production incident: a browser holding a build from a different release than the server
 * kept rendering opponent cards positionally and every draw failed with `Invalid draw request.`
 *
 * These tests pin the mitigation: the client detects the mismatch up front and refuses to
 * connect, so the user sees "reload to update" instead of an unexplained broken game.
 */

const fakeRepo = {
  getProfile: async () => ({ key: "me", localPlayerId: "p", displayName: "P", avatar: "a", updatedAt: 0 }),
  patchProfile: async () => undefined,
} as never;

function apiWithConfig(cfg: unknown): ApiClient {
  return new ApiClient({
    baseUrl: "https://x.test",
    repo: fakeRepo,
    fetchImpl: (async () => ({ ok: true, status: 200, json: async () => cfg, text: async () => "" }) as unknown as Response) as never,
  });
}

describe("protocol skew detection", () => {
  it("reports no skew when the server matches this build", async () => {
    const api = apiWithConfig({ protocolVersion: PROTOCOL_VERSION });
    expect(await api.serverProtocolVersion()).toBe(PROTOCOL_VERSION);
    expect(await api.isProtocolSkewed()).toBe(false);
  });

  it("reports skew when the server is on a different version", async () => {
    const api = apiWithConfig({ protocolVersion: PROTOCOL_VERSION + 1 });
    expect(await api.isProtocolSkewed()).toBe(true);
  });

  it("reports skew when the server is on an OLDER version", async () => {
    const api = apiWithConfig({ protocolVersion: PROTOCOL_VERSION - 1 });
    expect(await api.isProtocolSkewed()).toBe(true);
  });

  it("does not claim skew when the server predates the field", async () => {
    const api = apiWithConfig({ appName: "Old Maid" });
    expect(await api.serverProtocolVersion()).toBeNull();
    expect(await api.isProtocolSkewed()).toBe(false);
  });

  it("does not report skew for a network failure", async () => {
    const api = new ApiClient({
      baseUrl: "https://x.test", repo: fakeRepo,
      fetchImpl: (() => Promise.reject(new NetworkError("Failed to fetch"))) as never,
    });
    expect(await api.isProtocolSkewed()).toBe(false);
  });
});

describe("a skewed client does not connect", () => {
  it("does not open a socket and surfaces an actionable notice", async () => {
    const connect = vi.fn();
    const ctl = createOnlineController({
      url: "https://x.test",
      getToken: async () => "t",
      checkProtocol: async () => true,
      ioImpl: { io: () => ({ on: () => undefined, emit: () => undefined, connect, disconnect: () => undefined }) } as never,
    });
    ctl.connect();
    await vi.waitFor(() => expect(ctl.store.getState().protocolSkewed).toBe(true));
    expect(connect).not.toHaveBeenCalled();
    expect(ctl.store.getState().notices.some((n) => /out of date/i.test(n.message))).toBe(true);
  });

  it("connects normally when there is no skew", async () => {
    const ctl = createOnlineController({
      url: "https://x.test",
      getToken: async () => "t",
      checkProtocol: async () => false,
    });
    ctl.connect();
    await vi.waitFor(() => expect(ctl.store.getState().protocolSkewed).toBe(false));
    expect(ctl.store.getState().notices.some((n) => /out of date/i.test(n.message))).toBe(false);
  });

  it("refuses to draw while skewed, without contacting the server", async () => {
    const ctl = createOnlineController({
      url: "https://x.test",
      getToken: async () => "t",
      checkProtocol: async () => true,
    });
    ctl.connect();
    await vi.waitFor(() => expect(ctl.store.getState().protocolSkewed).toBe(true));
    const spy = vi.spyOn(ctl.client, "requestDraw").mockResolvedValue({ ok: true } as never);
    const msg = await ctl.draw("someone", "some-slot");
    expect(msg).toMatch(/reload/i);
    expect(spy).not.toHaveBeenCalled();
  });
});