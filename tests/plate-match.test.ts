/**
 * Plate-history correction (Levenshtein snap).
 *
 * Pure logic, so this needs no server and no database — but it is the one accuracy
 * stage that can silently make things WORSE (turning a correct new plate into a
 * wrong familiar one), so the conservatism rules are asserted individually rather
 * than trusted.
 *
 * Usage: `npx tsx tests/plate-match.test.ts`
 */
import {
  levenshtein,
  normalisePlate,
  snapToKnownPlate,
  SNAP_CONFIDENCE_CEILING,
} from "../src/backend/services/plate-match";

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

const FLEET = ["MH12AB1234", "KA05MK4321", "GJ01CD5678"];

console.log("Levenshtein:");
check("identical strings are distance 0", levenshtein("MH12AB1234", "MH12AB1234") === 0);
check("one substitution is distance 1", levenshtein("MH12AB1234", "MH12AB1284") === 1);
check("one deletion is distance 1", levenshtein("MH12AB1234", "MH12AB124") === 1);
check("one insertion is distance 1", levenshtein("MH12AB124", "MH12AB1234") === 1);
check("two substitutions are distance 2", levenshtein("MH12AB1234", "MH12AB1285") === 2);
check("the early exit reports above the cap, not a wrong number", levenshtein("AAAAAA", "ZZZZZZ", 1) > 1);
check("a big length gap exits immediately", levenshtein("MH12", "MH12AB1234", 1) > 1);
check("empty against non-empty is the length", levenshtein("", "AB", 5) === 2);

console.log("\nNormalisation:");
check("separators are stripped", normalisePlate("MH-12 AB 1234") === "MH12AB1234");
check("case is folded", normalisePlate("mh12ab1234") === "MH12AB1234");
check("null is empty", normalisePlate(null) === "");

console.log("\nSnapping corrects a hesitant read:");
const snap = snapToKnownPlate("MH12AB1284", 0.55, FLEET);
check("a one-edit neighbour is snapped", snap?.plate === "MH12AB1234", JSON.stringify(snap));
check("the snap is flagged", snap?.snapped === true);
check("the original read is preserved", snap?.original === "MH12AB1284");
check("confidence rises but never claims certainty", (snap?.confidence ?? 0) > 0.55 && (snap?.confidence ?? 1) <= 0.9, String(snap?.confidence));

const dirty = snapToKnownPlate("mh12-ab-1284", 0.5, ["MH 12 AB 1234"]);
check("both sides are normalised before comparing", dirty?.plate === "MH12AB1234", JSON.stringify(dirty));

console.log("\nSnapping refuses when the evidence is not clear:");
const confident = snapToKnownPlate("MH12AB1284", 0.95, FLEET);
check("a confident read is left alone", confident?.plate === "MH12AB1284" && confident?.snapped === false);
check(
  "the ceiling is what decides it",
  snapToKnownPlate("MH12AB1284", SNAP_CONFIDENCE_CEILING, FLEET)?.snapped === false
);

const exact = snapToKnownPlate("MH12AB1234", 0.4, FLEET);
check("an exact history hit is returned unchanged", exact?.plate === "MH12AB1234" && exact?.snapped === false);

// Two plates one edit away means the read is genuinely ambiguous. Guessing
// between them is worse than showing what was actually read.
const ambiguous = snapToKnownPlate("MH12AB1230", 0.4, ["MH12AB1234", "MH12AB1231"]);
check("an ambiguous read is NOT snapped", ambiguous?.plate === "MH12AB1230" && ambiguous?.snapped === false, JSON.stringify(ambiguous));

const far = snapToKnownPlate("TN09XY9999", 0.3, FLEET);
check("a genuinely new plate is never rewritten", far?.plate === "TN09XY9999" && far?.snapped === false);
check("distance 2 is too far to snap", snapToKnownPlate("MH12AB1285", 0.3, ["MH12AB1234"])?.snapped === false);

console.log("\nEdge cases:");
check("a null read produces no result", snapToKnownPlate(null, 0.4, FLEET) === null);
check("an empty read produces no result", snapToKnownPlate("", 0.4, FLEET) === null);
check("punctuation-only read produces no result", snapToKnownPlate("---", 0.4, FLEET) === null);
check("an empty fleet leaves the read alone", snapToKnownPlate("MH12AB1284", 0.4, [])?.snapped === false);
check("blank history entries are ignored", snapToKnownPlate("MH12AB1284", 0.4, ["", "  ", "MH12AB1234"])?.plate === "MH12AB1234");
check("history is never invented into a plate", snapToKnownPlate(undefined, 0.1, FLEET) === null);

console.log(`\n==== plate match: ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
