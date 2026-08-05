import type { Role } from "@prisma/client";

/**
 * The permission matrix, in one place. Middleware and API guards both derive
 * from this — a capability must never be decided in the UI alone, and must
 * never be defined twice.
 *
 * ADMIN inherits every OWNER capability by construction (see `can`), which is
 * the "Admin can edit ANY record" requirement. What ADMIN does *not* get
 * implicitly is a home yard: cross-tenant writes must always name a target
 * yard, either an /api/admin route parameter or an active "Enter Yard" session.
 */
export const CAPABILITIES = [
  // yard-operational (OWNER + MANAGER)
  "stock.view",
  "inward.create",
  "sort.complete",
  /// Loading sold material onto a vehicle. Manager work by design: the Owner
  /// sells, the Manager dispatches.
  "outward.dispatch",
  "sku.visibility",
  // owner-only within a yard
  "sell.view",
  "sale.create",
  "reports.view",
  "vendor.write",
  "material.write",
  /// Managing the segregation categories a mixed lot can be sorted into.
  /// Yard-operational: the Manager runs the segregation, so the Manager also
  /// maintains the categories it sorts into, with the same CRUD and the same
  /// validations as the Owner. Admin is unchanged (it inherits every capability).
  "sortType.write",
  // platform (ADMIN only)
  "yard.manage",
  "user.manage",
  "audit.view",
  "analytics.global",
  "record.editAny",
  "yard.impersonate",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const MANAGER_CAPS: readonly Capability[] = [
  "stock.view",
  "inward.create",
  "sort.complete",
  "outward.dispatch",
  "sortType.write",
];

const OWNER_CAPS: readonly Capability[] = [
  // Dispatch is deliberately NOT inherited: loading vehicles is the Manager's
  // job, and the Owner watches it from the Sell page's dispatch status. It also
  // keeps the Owner's bottom nav at the prototype's four tabs.
  ...MANAGER_CAPS.filter((c) => c !== "outward.dispatch"),
  "sku.visibility",
  "sell.view",
  "sale.create",
  "reports.view",
  "vendor.write",
  "material.write",
];

const ADMIN_ONLY_CAPS: readonly Capability[] = [
  "yard.manage",
  "user.manage",
  "audit.view",
  "analytics.global",
  "record.editAny",
  "yard.impersonate",
];

/** ADMIN = every OWNER capability + the platform ones. */
const ADMIN_CAPS: readonly Capability[] = [...OWNER_CAPS, "outward.dispatch", ...ADMIN_ONLY_CAPS];

const BY_ROLE: Record<Role, readonly Capability[]> = {
  MANAGER: MANAGER_CAPS,
  OWNER: OWNER_CAPS,
  ADMIN: ADMIN_CAPS,
};

export function can(role: Role, cap: Capability): boolean {
  return BY_ROLE[role].includes(cap);
}

export function capabilitiesFor(role: Role): readonly Capability[] {
  return BY_ROLE[role];
}

/**
 * Route-level guards, consumed by middleware (edge, no DB access).
 * Order matters: the first matching rule wins.
 */
export const ROUTE_RULES: { prefix: string; roles: readonly Role[]; methods?: readonly string[] }[] = [
  // Platform console — ADMIN only.
  { prefix: "/admin", roles: ["ADMIN"] },
  { prefix: "/api/admin", roles: ["ADMIN"] },

  // Selling is OWNER-only inside a yard; ADMIN reaches it via Enter Yard.
  { prefix: "/sell", roles: ["OWNER", "ADMIN"] },
  { prefix: "/api/sales", roles: ["OWNER", "ADMIN"] },
  { prefix: "/api/receivables", roles: ["OWNER", "ADMIN"] },
  { prefix: "/api/sell", roles: ["OWNER", "ADMIN"] },

  // Outward is open to every in-yard role: the Manager dispatches, and the
  // Owner (or an ADMIN who has entered the yard) must be able to watch and,
  // in a small yard, load a vehicle themselves.
  // Dispatch is Manager work; an ADMIN inside a yard can do it too. The Owner
  // sees dispatch state on the Sell page rather than loading vehicles.
  { prefix: "/outward", roles: ["MANAGER", "ADMIN"] },
  { prefix: "/api/outward", roles: ["MANAGER", "ADMIN"] },

  // Vendor + material writes are owner-only; GET stays open for chip lists.
  { prefix: "/api/vendors", roles: ["OWNER", "ADMIN"], methods: ["POST", "PATCH", "PUT", "DELETE"] },
  { prefix: "/api/materials", roles: ["OWNER", "ADMIN"], methods: ["POST", "PATCH", "PUT", "DELETE"] },
  { prefix: "/api/skus", roles: ["OWNER", "ADMIN"], methods: ["POST", "PATCH", "PUT", "DELETE"] },
  // Sort types: every in-yard role maintains the segregation tree. The Manager
  // is the one who actually sorts, so the Manager also curates the categories.
  { prefix: "/api/sort-types", roles: ["OWNER", "MANAGER", "ADMIN"], methods: ["POST", "PATCH", "PUT", "DELETE"] },
];

/** Returns the rule blocking this (path, method, role), or null if allowed. */
export function blockedBy(
  path: string,
  method: string,
  role: Role
): { prefix: string; roles: readonly Role[] } | null {
  for (const rule of ROUTE_RULES) {
    if (!path.startsWith(rule.prefix)) continue;
    if (rule.methods && !rule.methods.includes(method.toUpperCase())) continue;
    if (rule.roles.includes(role)) return null;
    return rule;
  }
  return null;
}

/** Where a role lands after login or on a blocked page navigation. */
export function homePathFor(role: Role): string {
  return role === "ADMIN" ? "/admin" : "/stock";
}
