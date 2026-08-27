/**
 * Unit conversion — the one place a non-kilogram number is allowed to exist.
 *
 * These are pure-function tests: no database, no server. The property that
 * matters is that `toKilograms` is the ONLY way a unit becomes a stored value,
 * and that it always yields whole kilograms.
 *
 * Usage: `npx tsx tests/units.test.ts`.
 */
import { UNITS, toKilograms, fromKilograms, type UnitCode } from "../src/shared/units";

let pass = 0,
  fail = 0;
const check = (l: string, c: boolean, x = "") => {
  if (c) {
    pass++;
    console.log(`  ✓ ${l}`);
  } else {
    fail++;
    console.log(`  ✗ ${l} ${x}`);
  }
};

console.log("The unit table:");
check("exposes exactly KG, TON and TONNE", UNITS.map((u) => u.code).join(",") === "KG,TON,TONNE");
check("KG is first, so it is the natural default", UNITS[0].code === "KG");
check("KG is the identity conversion", UNITS[0].toKg === 1);
check("every unit has a positive factor", UNITS.every((u) => u.toKg > 0));
check("every unit has a label", UNITS.every((u) => !!u.label));
check("factors are strictly increasing, so the list reads smallest-first", UNITS.every((u, i) => i === 0 || UNITS[i - 1].toKg < u.toKg));
// A short ton is 907.18 kg and a metric tonne is 1000 — conflating them would
// silently misreport every imported load by ~10%.
check("TON is the US short ton, not the metric tonne", UNITS[1].toKg === 907.18474);
check("TONNE is the metric tonne", UNITS[2].toKg === 1000);
// Compared through the conversion rather than the literals, so the check is a
// real runtime assertion and not one TypeScript folds away at compile time.
check("TON and TONNE are not the same factor", toKilograms(1, "TON") !== toKilograms(1, "TONNE"));

console.log("\ntoKilograms:");
check("kilograms pass through untouched", toKilograms(1234, "KG") === 1234);
check("zero stays zero in every unit", UNITS.every((u) => toKilograms(0, u.code) === 0));
check("one tonne is 1000 kg", toKilograms(1, "TONNE") === 1000);
check("one ton is 907 kg", toKilograms(1, "TON") === 907);
check("half a tonne is 500 kg", toKilograms(0.5, "TONNE") === 500);
check("2.5 tonnes is 2500 kg", toKilograms(2.5, "TONNE") === 2500);
check("a fractional ton rounds to whole kg", toKilograms(0.5, "TON") === 454, String(toKilograms(0.5, "TON")));
// Regression: the factor used to be a pre-rounded 907, which lost 0.18 kg per
// ton. One ton was unaffected, so the drift only appeared on large loads —
// exactly the ones where it matters.
check("12 tons is 10886 kg, not 10884", toKilograms(12, "TON") === 10886, String(toKilograms(12, "TON")));
check("100 tons is 90718 kg", toKilograms(100, "TON") === 90718, String(toKilograms(100, "TON")));
check("rounding happens once, on the product", toKilograms(3, "TON") === 2722, String(toKilograms(3, "TON")));

console.log("\nThe result is always whole kilograms:");
// Stock is an integer column. A fractional result would be silently truncated by
// the database, so rounding has to happen here where it is visible.
const samples = [0, 0.001, 0.333, 1, 1.5, 7.777, 12.345, 999.99, 20000];
check(
  "every unit and sample yields an integer",
  samples.every((v) => UNITS.every((u) => Number.isInteger(toKilograms(v, u.code)))),
  "found a fractional result"
);
check(
  "no conversion returns NaN",
  samples.every((v) => UNITS.every((u) => !Number.isNaN(toKilograms(v, u.code))))
);
check("a negative reading keeps its sign rather than silently clamping", toKilograms(-1, "TONNE") === -1000);

console.log("\nUnknown units fail safe:");
// An unknown code must never be treated as a large multiplier — that would
// inflate stock. Falling back to KG under-counts at worst, and the value is
// still exactly what the operator typed.
check("an unknown code falls back to KG", toKilograms(500, "BOGUS" as UnitCode) === 500);
check("an empty code falls back to KG", toKilograms(500, "" as UnitCode) === 500);

console.log("\nfromKilograms, for pre-filling a keypad:");
check("kilograms pass through", fromKilograms(1234, "KG") === 1234);
check("1000 kg reads as one tonne", fromKilograms(1000, "TONNE") === 1);
check("500 kg reads as half a tonne, not one", fromKilograms(500, "TONNE") === 0.5);
check("it is not rounded", Math.abs(fromKilograms(907.18474, "TON") - 1) < 1e-9 && fromKilograms(1, "TONNE") === 0.001);
check("an unknown code falls back to KG", fromKilograms(500, "BOGUS" as UnitCode) === 500);

console.log("\nRound-tripping:");
/**
 * A round trip is exact for KG and TONNE, and accurate to within half a
 * kilogram for TON.
 *
 * It cannot be exact for TON, and asserting that it was is what hid the
 * precision bug: one short ton is 907.18474 kg, stock is stored as INTEGER
 * kilograms, so 1 TON → 907 kg → 0.99979 TON. The old factor made the round
 * trip exact by pre-rounding the constant to 907 — which is exactly the error
 * that lost 2 kg on a 12-ton load. Half a kilogram is the real guarantee
 * integer storage can offer, so that is what is asserted.
 */
for (const u of UNITS) {
  for (const whole of [1, 2, 7, 15]) {
    const kilos = toKilograms(whole, u.code);
    const back = fromKilograms(kilos, u.code);
    check(
      `${whole} ${u.code} survives a round trip (within half a kg)`,
      Math.abs(back - whole) <= 0.5 / u.toKg,
      `${back}`
    );
    if (u.code !== "TON") {
      check(`${whole} ${u.code} round-trips exactly`, back === whole, `${back}`);
    }
  }
}

console.log("\nThe display step used by Sort:");
// Sort steps in the selected unit. Each step must be at least one kilogram, or
// a tap would appear to do nothing.
const sortSteps: Record<UnitCode, number[]> = {
  KG: [50, 10],
  TON: [0.5, 0.1],
  TONNE: [0.5, 0.1],
};
for (const [code, steps] of Object.entries(sortSteps) as [UnitCode, number[]][]) {
  for (const s of steps) {
    check(`a ${s} ${code} step is at least 1 kg`, toKilograms(s, code) >= 1, `${toKilograms(s, code)} kg`);
  }
}
check("a tonne step is a round 500 kg", toKilograms(0.5, "TONNE") === 500);
check("a tonne wastage step is a round 100 kg", toKilograms(0.1, "TONNE") === 100);

console.log(`\n==== units: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
