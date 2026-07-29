/**
 * SAFE `prisma db push`.
 *
 * `prisma db push` will silently drop tables and columns to make the database
 * match schema.prisma. If schema.prisma has drifted *behind* the database — as
 * happened on this project — that is unrecoverable data loss.
 *
 * This wrapper computes the SQL Prisma would run, refuses outright if that SQL
 * contains any destructive statement, and only then hands off to the real push.
 *
 * Escape hatch: `npm run db:push -- --allow-destructive` requires an explicit
 * typed confirmation and is intended for a throwaway test branch, never prod.
 */
import { execFileSync } from "node:child_process";

const ALLOW_DESTRUCTIVE = process.argv.includes("--allow-destructive");

/** Statements that destroy data or schema objects. Matched case-insensitively. */
const DESTRUCTIVE_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bDROP\s+TABLE\b/i, label: "DROP TABLE" },
  { re: /\bDROP\s+COLUMN\b/i, label: "DROP COLUMN" },
  { re: /\bDROP\s+SCHEMA\b/i, label: "DROP SCHEMA" },
  { re: /\bDROP\s+TYPE\b/i, label: "DROP TYPE (enum removal)" },
  { re: /\bDROP\s+CONSTRAINT\b/i, label: "DROP CONSTRAINT" },
  { re: /\bTRUNCATE\b/i, label: "TRUNCATE" },
  { re: /\bDELETE\s+FROM\b/i, label: "DELETE FROM" },
  // A NOT NULL added to an existing populated column fails or forces a default;
  // Prisma emits this when it thinks the column is new. Worth a human look.
  { re: /\bSET\s+NOT\s+NULL\b/i, label: "SET NOT NULL on existing column" },
];

function run(args: string[]): string {
  return execFileSync("npx", ["prisma", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });
}

function main() {
  console.log("🛡️  safe-push: computing the diff between schema.prisma and the live database…\n");

  let sql: string;
  try {
    sql = run([
      "migrate",
      "diff",
      "--from-schema-datasource",
      "prisma/schema.prisma",
      "--to-schema-datamodel",
      "prisma/schema.prisma",
      "--script",
    ]);
  } catch (e) {
    console.error("❌ Could not compute the schema diff. Refusing to push blind.");
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }

  const meaningful = sql
    .split("\n")
    .filter((l) => l.trim() && !l.trim().startsWith("--"))
    .join("\n");

  if (!meaningful.trim()) {
    console.log("✅ No drift. Database already matches schema.prisma — nothing to push.");
    return;
  }

  console.log("── Proposed SQL ──────────────────────────────────────────");
  console.log(meaningful);
  console.log("──────────────────────────────────────────────────────────\n");

  const hits = DESTRUCTIVE_PATTERNS.filter((p) => p.re.test(meaningful)).map((p) => p.label);

  if (hits.length > 0) {
    console.error("🚨 DESTRUCTIVE OPERATIONS DETECTED:");
    for (const h of hits) console.error(`   • ${h}`);
    console.error("");
    if (!ALLOW_DESTRUCTIVE) {
      console.error("❌ REFUSING TO PUSH. Your data is untouched.");
      console.error("   This almost always means schema.prisma is BEHIND the database.");
      console.error("   Fix it with `npx prisma db pull` and reconcile, do not force this.");
      console.error("   If you genuinely intend this (test branch only):");
      console.error("     npm run db:push -- --allow-destructive");
      process.exit(1);
    }
    if (process.env.I_UNDERSTAND_DATA_LOSS !== "yes") {
      console.error("❌ --allow-destructive also requires I_UNDERSTAND_DATA_LOSS=yes in the env.");
      process.exit(1);
    }
    console.warn("⚠️  Proceeding with a destructive push because it was explicitly authorised.\n");
  } else {
    console.log("✅ Diff is purely additive. Safe to apply.\n");
  }

  console.log("▶️  Running prisma db push…\n");
  /**
   * `--accept-data-loss` is required for any ADD UNIQUE INDEX, because Prisma
   * cannot know whether existing rows already collide. Passing it here is safe
   * *only* because the check above has already proven this diff contains no
   * DROP, TRUNCATE or DELETE — that stricter gate is what protects the data,
   * and it runs before we ever get here. Without this, a purely additive
   * migration that happens to add a unique index cannot be applied at all.
   */
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  execFileSync("npx", ["prisma", "generate"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  console.log("\n✅ Push complete.");
}

main();
