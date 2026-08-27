/**
 * Display names for the role enum.
 *
 * The database, the session token, the capability matrix and every API contract
 * keep the `MANAGER` identifier — renaming the enum would touch authorization,
 * migrations and every permission test for a wording change. Only what a person
 * reads is translated, and it is translated in exactly one place so the console
 * and the yard app can never disagree about what the role is called.
 */
export const ROLE_LABEL: Record<string, string> = {
  OWNER: "Owner",
  MANAGER: "Supervisor",
  ADMIN: "Platform Admin",
};

/** Falls back to the raw value, so an unknown role still renders something. */
export const roleLabel = (role: string) => ROLE_LABEL[role] ?? role;
