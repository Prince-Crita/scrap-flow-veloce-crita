/**
 * What a brand-new yard is born with.
 *
 * A yard with no materials cannot receive an inward load, so creating one and
 * provisioning it are a single step. This lives here rather than inside the
 * admin route so an operational script (prisma/prepare-demo.ts) provisions a
 * yard exactly the way the console does — one definition, no drift between the
 * yard a client is handed and the yard an admin creates in the UI.
 */

export type StarterMaterial = {
  code: string;
  name: string;
  skus: { code: string; name: string; icon: string; threshold: number; mixed: boolean; order: number }[];
};

/** The starter material tree for a brand-new yard. Mirrors prisma/seed.ts. */
export const STARTER_MATERIALS: StarterMaterial[] = [
  {
    code: "MS",
    name: "MS Scrap",
    skus: [
      { code: "MSB", name: "MS Bazar", icon: "🔩", threshold: 2000, mixed: false, order: 1 },
      { code: "MSC", name: "MS Commercial", icon: "🏗️", threshold: 2000, mixed: false, order: 2 },
      { code: "MSS", name: "MS Super", icon: "⭐", threshold: 2000, mixed: false, order: 3 },
      { code: "MIXMS", name: "Mixed MS", icon: "🧺", threshold: 99999, mixed: true, order: 7 },
    ],
  },
  {
    code: "PET",
    name: "PET Plastic",
    skus: [
      { code: "PETW", name: "PET White", icon: "🥛", threshold: 1500, mixed: false, order: 4 },
      { code: "PETG", name: "PET Green", icon: "🧪", threshold: 1500, mixed: false, order: 5 },
      { code: "MIXPET", name: "PET Mixed", icon: "🧴", threshold: 99999, mixed: true, order: 8 },
    ],
  },
  {
    code: "ALU",
    name: "Aluminum",
    skus: [
      { code: "ALUC", name: "Alu Castings", icon: "⚙️", threshold: 800, mixed: false, order: 6 },
      { code: "MIXALU", name: "Aluminum Mixed", icon: "🪨", threshold: 99999, mixed: true, order: 9 },
    ],
  },
];

/**
 * Minimal surface of a Prisma transaction client this needs.
 *
 * Typed structurally so both the app's client and a plain `PrismaClient` in a
 * script satisfy it without either importing the other's generated types.
 */
type ProvisionTx = {
  material: { create: (args: { data: { yardId: string; name: string; code: string } }) => Promise<{ id: string }> };
  sku: {
    create: (args: {
      data: {
        yardId: string;
        materialId: string;
        name: string;
        code: string;
        icon: string;
        saleThresholdKg: number;
        isMixedBucket: boolean;
        sortOrder: number;
      };
    }) => Promise<{ id: string }>;
  };
  inventory: { create: (args: { data: { yardId: string; skuId: string; quantityKg: number } }) => Promise<unknown> };
  counter: { create: (args: { data: { name: string; value: number } }) => Promise<unknown> };
};

/**
 * Create the material tree, zeroed inventory and lot/invoice counters.
 *
 * Must run inside the same transaction as the yard row: either the yard exists
 * complete and usable, or not at all.
 */
export async function provisionYard(tx: ProvisionTx, yardId: string): Promise<void> {
  for (const m of STARTER_MATERIALS) {
    const material = await tx.material.create({ data: { yardId, name: m.name, code: m.code } });
    for (const s of m.skus) {
      const sku = await tx.sku.create({
        data: {
          yardId,
          materialId: material.id,
          name: s.name,
          code: s.code,
          icon: s.icon,
          saleThresholdKg: s.threshold,
          isMixedBucket: s.mixed,
          sortOrder: s.order,
        },
      });
      await tx.inventory.create({ data: { yardId, skuId: sku.id, quantityKg: 0 } });
    }
  }
  // Continue the familiar numbering convention in each new yard.
  await tx.counter.create({ data: { name: `${yardId}:lot`, value: 0 } });
  await tx.counter.create({ data: { name: `${yardId}:invoice`, value: 0 } });
}
