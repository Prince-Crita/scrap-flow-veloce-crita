/**
 * Logical JSON backup of every public table. READ-ONLY — never writes to the DB.
 *
 * Uses raw SQL against information_schema rather than the Prisma Client models,
 * so it captures the database as it actually is even when schema.prisma has
 * drifted away from it. That property is the whole point: this is the tool you
 * run *before* touching a schema you are not yet sure you can describe.
 *
 * Usage: npm run db:backup [-- <outDir>]
 */
import { PrismaClient } from "@prisma/client";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const prisma = new PrismaClient();

const outDir =
  process.argv[2] ||
  process.env.BACKUP_DIR ||
  join(process.cwd(), "backups", new Date().toISOString().replace(/[:.]/g, "-"));

/** JSON.stringify cannot serialise BigInt (count(*)) or Date reliably. */
function replacer(_k: string, v: unknown) {
  if (typeof v === "bigint") return v.toString();
  return v;
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  console.log(`💾 Backing up → ${outDir}`);

  const tables = await prisma.$queryRawUnsafe<{ table_name: string }[]>(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE' order by 1`
  );

  const manifest: Record<string, number> = {};
  const dump: Record<string, unknown[]> = {};

  for (const { table_name } of tables) {
    const rows = await prisma.$queryRawUnsafe<unknown[]>(`select * from "${table_name}"`);
    dump[table_name] = rows;
    manifest[table_name] = rows.length;
    console.log(`  ${table_name}: ${rows.length}`);
  }

  // DDL fingerprint so a restore can be verified against the shape it came from.
  const ddl = {
    columns: await prisma.$queryRawUnsafe(
      `select table_name, column_name, data_type, is_nullable, column_default
       from information_schema.columns where table_schema='public'
       order by table_name, ordinal_position`
    ),
    indexes: await prisma.$queryRawUnsafe(
      `select tablename, indexname, indexdef from pg_indexes
       where schemaname='public' order by tablename, indexname`
    ),
    constraints: await prisma.$queryRawUnsafe(
      `select conname, conrelid::regclass::text as tbl, contype,
              pg_get_constraintdef(oid) as def
       from pg_constraint where connamespace='public'::regnamespace order by tbl, conname`
    ),
    enums: await prisma.$queryRawUnsafe(
      `select t.typname as enum_name, e.enumlabel as value
       from pg_type t join pg_enum e on e.enumtypid = t.oid
       join pg_namespace n on n.oid = t.typnamespace
       where n.nspname='public' order by t.typname, e.enumsortorder`
    ),
  };

  writeFileSync(join(outDir, "data.json"), JSON.stringify(dump, replacer, 1), "utf8");
  writeFileSync(join(outDir, "ddl.json"), JSON.stringify(ddl, replacer, 1), "utf8");
  writeFileSync(
    join(outDir, "manifest.json"),
    JSON.stringify({ takenAt: new Date().toISOString(), rowCounts: manifest }, replacer, 1),
    "utf8"
  );

  const total = Object.values(manifest).reduce((a, b) => a + b, 0);
  console.log(`✅ Backup complete — ${tables.length} tables, ${total} rows.`);
  console.log(`   ${join(outDir, "data.json")}`);
}

main()
  .catch((e) => {
    console.error("❌ Backup FAILED — do not proceed with schema changes.");
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
