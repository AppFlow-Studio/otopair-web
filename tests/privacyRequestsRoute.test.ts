// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  fetchMutation: vi.fn(),
  supportEmail: vi.fn(),
}));
vi.mock("convex/nextjs", () => ({ fetchMutation: mocks.fetchMutation }));
vi.mock("@/email/send", () => ({ sendContactSupportEmail: mocks.supportEmail }));

import { POST } from "../app/api/privacy-requests/route";

// The route's in-memory rate limit is per IP, so each request gets its own.
let ip = 0;
function post(body: Record<string, unknown>, from = `10.1.0.${++ip}`) {
  return POST(
    new NextRequest("http://localhost/api/privacy-requests", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": from },
      body: JSON.stringify({ elapsedMs: 5_000, ...body }),
    }),
  );
}

beforeEach(() => {
  mocks.fetchMutation.mockReset().mockResolvedValue({ ok: true });
  mocks.supportEmail.mockReset().mockResolvedValue({ success: true });
});

describe("/api/privacy-requests", () => {
  it("saves a deletion request to Convex and tells support where it came from", async () => {
    const res = await post({ kind: "delete_account", email: " Jane.Doe@Example.com " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    expect(mocks.fetchMutation).toHaveBeenCalledTimes(1);
    expect(mocks.fetchMutation.mock.calls[0][1]).toEqual({ kind: "delete_account", email: "jane.doe@example.com" });
    const mail = mocks.supportEmail.mock.calls[0][0];
    expect(mail).toMatchObject({
      subject: "Account deletion request",
      customerEmail: "jane.doe@example.com",
      sentFrom: "Sent from otopair.com/delete-account.",
    });
    expect(mail.description).toMatch(/Verify the request/);
    expect(mail.description).toMatch(/Saved in Convex/);
  });

  it("passes a Global Privacy Control signal with an opt-out", async () => {
    await post({ kind: "opt_out_vehicle_history", email: "gpc@example.com", gpc: true });
    expect(mocks.fetchMutation.mock.calls[0][1]).toEqual({
      kind: "opt_out_vehicle_history",
      email: "gpc@example.com",
      gpc: true,
    });
    expect(mocks.supportEmail.mock.calls[0][0].description).toMatch(/Global Privacy Control/);
  });

  it("points at the email field when the address is bad, and stores nothing", async () => {
    const res = await post({ kind: "delete_account", email: "nope" });
    expect(res.status).toBe(400);
    expect((await res.json()).errors).toHaveProperty("email");
    expect(mocks.fetchMutation).not.toHaveBeenCalled();
    expect(mocks.supportEmail).not.toHaveBeenCalled();
  });

  it("refuses an unknown request type", async () => {
    const res = await post({ kind: "export_everything", email: "a@example.com" });
    expect(res.status).toBe(400);
    expect(mocks.fetchMutation).not.toHaveBeenCalled();
  });

  it("accepts bot submits silently and does nothing with them", async () => {
    for (const trap of [{ company: "Acme" }, { elapsedMs: 200 }]) {
      const res = await post({ kind: "delete_account", email: "bot@example.com", ...trap });
      expect(res.status).toBe(200);
    }
    expect(mocks.fetchMutation).not.toHaveBeenCalled();
    expect(mocks.supportEmail).not.toHaveBeenCalled();
  });

  it("still succeeds when Convex is down but support got the email, and says it's the only record", async () => {
    mocks.fetchMutation.mockRejectedValue(new Error("convex down"));
    const res = await post({ kind: "delete_account", email: "a@example.com" });
    expect(res.status).toBe(200);
    expect(mocks.supportEmail.mock.calls[0][0].description).toMatch(/NOT saved in Convex/);
  });

  it("tells the visitor when nothing was saved and nobody was emailed", async () => {
    mocks.fetchMutation.mockRejectedValue(new Error("convex down"));
    mocks.supportEmail.mockResolvedValue({ success: false, error: "resend down" });
    const res = await post({ kind: "opt_out_vehicle_history", email: "a@example.com" });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/support@otopair\.com/);
  });

  it("slows down a burst from one address", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await post({ kind: "delete_account", email: `r${i}@example.com` }, "10.9.9.9")).status);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
  });
});
