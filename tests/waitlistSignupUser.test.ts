// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  fetchMutation: vi.fn(),
  confirmation: vi.fn(),
  notification: vi.fn(),
}));
vi.mock("convex/nextjs", () => ({ fetchMutation: mocks.fetchMutation }));
vi.mock("@/email/send", () => ({
  sendWaitlistConfirmationEmail: mocks.confirmation,
  sendWaitlistNotificationEmail: mocks.notification,
}));

import { POST } from "../app/api/waitlist/route";

// The route's in-memory rate limit is per IP, so each request gets its own.
let ip = 0;
function post(body: Record<string, unknown>) {
  return POST(
    new NextRequest("http://localhost/api/waitlist", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.${++ip}` },
      body: JSON.stringify({ elapsedMs: 5_000, ...body }),
    })
  );
}

const HONDA = { vin: "1HGCM82633A004352", year: 2003, make: "HONDA", model: "Accord", trim: "EX" };

beforeEach(() => {
  mocks.fetchMutation.mockReset().mockResolvedValue({ ok: true });
  mocks.confirmation.mockReset().mockResolvedValue({ success: true });
  mocks.notification.mockReset().mockResolvedValue({ success: true });
});

describe("/api/waitlist saves every sign-up as a user", () => {
  it("stores the launch-list modal's name and email", async () => {
    const res = await post({ email: " Jane.Doe@Example.com ", name: "Jane van Dyke", list: "app" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, saved: true });
    expect(mocks.fetchMutation).toHaveBeenCalledTimes(1);
    expect(mocks.fetchMutation.mock.calls[0][1]).toEqual({
      email: "jane.doe@example.com",
      firstName: "Jane",
      lastName: "van Dyke",
    });
  });

  it("stores a borough waitlist sign-up that only gave an email", async () => {
    const res = await post({ email: "bk@example.com", borough: "Brooklyn" });
    expect(res.status).toBe(200);
    expect(mocks.fetchMutation.mock.calls[0][1]).toEqual({ email: "bk@example.com" });
  });

  it("stores the car Oto decoded, and nothing it wasn't sent", async () => {
    await post({ email: "driver@example.com", list: "app", vehicle: { ...HONDA, cylinders: 4, owner: "someone else" } });
    expect(mocks.fetchMutation.mock.calls[0][1]).toEqual({ email: "driver@example.com", ...HONDA, cylinders: 4 });
  });

  it("drops a malformed car instead of losing the person", async () => {
    await post({ email: "driver@example.com", vehicle: { vin: "not-a-vin", year: "2003" } });
    expect(mocks.fetchMutation.mock.calls[0][1]).toEqual({ email: "driver@example.com" });
  });

  it("retries with the contact details alone when saving with the car fails", async () => {
    mocks.fetchMutation.mockRejectedValueOnce(new Error("vehicle rejected")).mockResolvedValueOnce({ ok: true });
    const res = await post({ email: "driver@example.com", name: "Sam", vehicle: HONDA });
    expect(await res.json()).toMatchObject({ saved: true });
    expect(mocks.fetchMutation).toHaveBeenCalledTimes(2);
    expect(mocks.fetchMutation.mock.calls[1][1]).toEqual({ email: "driver@example.com", firstName: "Sam" });
  });

  it("still confirms when Convex is down but the emails went out, and says it wasn't saved", async () => {
    mocks.fetchMutation.mockRejectedValue(new Error("convex down"));
    const res = await post({ email: "driver@example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, saved: false });
  });

  it("fails when nothing was stored and no email went out", async () => {
    mocks.fetchMutation.mockRejectedValue(new Error("convex down"));
    mocks.confirmation.mockResolvedValue({ success: false });
    mocks.notification.mockResolvedValue({ success: false });
    const res = await post({ email: "driver@example.com" });
    expect(res.status).toBe(500);
  });

  it("stores nothing for a bot trap or a bad email", async () => {
    expect((await post({ email: "bot@example.com", company_website: "https://spam" })).status).toBe(200);
    expect((await post({ email: "bot@example.com", elapsedMs: 200 })).status).toBe(200);
    expect((await post({ email: "not-an-email" })).status).toBe(400);
    expect(mocks.fetchMutation).not.toHaveBeenCalled();
    expect(mocks.confirmation).not.toHaveBeenCalled();
  });
});
