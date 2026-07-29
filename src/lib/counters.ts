/**
 * Sequence counters for lot and invoice numbers.
 *
 * Counters are namespaced per yard ("{yardId}:lot"), so every yard numbers its
 * own lots and invoices from its own sequence — Yard 1 and Yard 2 can both hold
 * lot A-115 without colliding. The per-yard composite uniques on
 * InwardLoad(yardId, lotNumber) and Sale(yardId, invoiceNumber) are the database
 * backstop if a caller ever forgets the namespace.
 */

/** Minimal shape we need; kept loose so it accepts an extended (scoped) tx client. */
type CounterTx = {
  counter: {
    upsert(args: {
      where: { name: string };
      create: { name: string; value: number };
      update: { value: { increment: number } };
    }): Promise<{ name: string; value: number }>;
  };
};

export type CounterName = "lot" | "invoice" | "dispatch";

/** The one place a counter key is constructed. Never build this string inline. */
export function counterKey(yardId: string, name: CounterName): string {
  if (!yardId) throw new Error("[counters] yardId is required — counters are per-yard");
  return `${yardId}:${name}`;
}

/**
 * Atomically increment a yard's named counter inside an existing transaction and
 * return the new value. The upsert is a single statement, so concurrent inward
 * loads or sales can never be handed the same number.
 */
export async function nextCounter(
  tx: CounterTx,
  yardId: string,
  name: CounterName
): Promise<number> {
  const row = await tx.counter.upsert({
    where: { name: counterKey(yardId, name) },
    create: { name: counterKey(yardId, name), value: 1 },
    update: { value: { increment: 1 } },
  });
  return row.value;
}

export function formatLot(n: number): string {
  return `A-${n}`;
}

export function formatInvoice(n: number): string {
  return `INV-${String(n).padStart(4, "0")}`;
}

/** Dispatch note number, e.g. D-0007. Namespaced per yard like the others. */
export function formatDispatch(n: number): string {
  return `D-${String(n).padStart(4, "0")}`;
}
