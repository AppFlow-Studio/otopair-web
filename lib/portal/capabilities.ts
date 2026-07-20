// Client-side mirror of convex/directorGate.ts CAPABILITIES — keep in sync.
// Server enforcement is authoritative; this only drives UI affordances
// (hiding/disabling write controls the session's role cannot use).

export type DirectorRole =
  | "super_admin"
  | "ops_admin"
  | "support"
  | "readonly"
  | "data_admin"
  | "shop_success";

export type Capability =
  | "users.write"
  | "money.write"
  | "shops.write"
  | "data.write"
  | "data.trigger"
  | "admin.manage"
  | "ai.write";

const ALL: Capability[] = [
  "users.write",
  "money.write",
  "shops.write",
  "data.write",
  "data.trigger",
  "admin.manage",
  "ai.write",
];

export const CAPABILITIES: Record<DirectorRole, readonly Capability[]> = {
  super_admin: ALL,
  ops_admin: ["users.write", "money.write", "shops.write", "ai.write"],
  support: ["users.write"],
  readonly: [],
  data_admin: ["data.write", "data.trigger", "ai.write"],
  shop_success: ["shops.write"],
};

export function can(role: string | undefined | null, capability: Capability): boolean {
  if (!role) return false;
  return (CAPABILITIES[role as DirectorRole] ?? []).includes(capability);
}
