import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import { makeT } from "./helpers";

async function requests(t: ReturnType<typeof makeT>) {
  return t.run((ctx) => ctx.db.query("privacy_requests").collect());
}

describe("privacyRequests.submit — the /privacy-choices and /delete-account forms", () => {
  test("records an open request with the email normalized, and says nothing about accounts", async () => {
    const t = makeT();
    const result = await t.mutation(api.privacyRequests.submit, {
      kind: "delete_account",
      email: "  Jane.Doe@Example.com ",
    });
    expect(result).toEqual({ ok: true });

    const rows = await requests(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "delete_account",
      email: "jane.doe@example.com",
      source: "website",
      status: "open",
    });
    expect(rows[0].user_id).toBeUndefined();
    expect(rows[0].gpc).toBeUndefined();
  });

  test("links the account that uses the email, without returning it", async () => {
    const t = makeT();
    await t.mutation(api.preSignups.createStub, { email: "owner@example.com" });
    const [user] = await t.run((ctx) => ctx.db.query("users").collect());

    const result = await t.mutation(api.privacyRequests.submit, {
      kind: "opt_out_vehicle_history",
      email: "Owner@Example.com",
      gpc: true,
    });
    expect(result).toEqual({ ok: true });
    expect(await requests(t)).toMatchObject([{ user_id: user._id, gpc: true, kind: "opt_out_vehicle_history" }]);
  });

  test("a repeat submit refreshes the open request instead of queueing it twice", async () => {
    const t = makeT();
    await t.mutation(api.privacyRequests.submit, { kind: "delete_account", email: "bk@example.com" });
    const [first] = await requests(t);
    await new Promise((r) => setTimeout(r, 5));
    await t.mutation(api.privacyRequests.submit, { kind: "delete_account", email: "BK@example.com" });

    const rows = await requests(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].created_at).toBe(first.created_at);
    expect(rows[0].last_submitted_at).toBeGreaterThan(first.last_submitted_at);
  });

  test("an opt-out and a deletion for the same email are separate requests", async () => {
    const t = makeT();
    await t.mutation(api.privacyRequests.submit, { kind: "delete_account", email: "bk@example.com" });
    await t.mutation(api.privacyRequests.submit, { kind: "opt_out_vehicle_history", email: "bk@example.com" });
    expect((await requests(t)).map((r) => r.kind).sort()).toEqual(["delete_account", "opt_out_vehicle_history"]);
  });

  test("a closed request doesn't swallow a new one", async () => {
    const t = makeT();
    await t.mutation(api.privacyRequests.submit, { kind: "delete_account", email: "bk@example.com" });
    const [first] = await requests(t);
    await t.run((ctx) => ctx.db.patch(first._id, { status: "done" }));
    await t.mutation(api.privacyRequests.submit, { kind: "delete_account", email: "bk@example.com" });
    expect((await requests(t)).map((r) => r.status).sort()).toEqual(["done", "open"]);
  });

  test("refuses something that isn't an email", async () => {
    const t = makeT();
    await expect(t.mutation(api.privacyRequests.submit, { kind: "delete_account", email: "not-an-email" })).rejects.toThrow(
      /valid email/,
    );
    expect(await requests(t)).toHaveLength(0);
  });
});
