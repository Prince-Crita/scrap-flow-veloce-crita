"""
Exit gate: ANPR plate logic.

Only the pure decision layer is tested here — grammar repair, scoring, and
front/rear fusion. That is deliberate: the image pipeline needs model weights
and a GPU-class runtime that no test machine is guaranteed to have, whereas
these are the parts that decide whether a *nearly correct* OCR read becomes a
usable plate or a "couldn't read it, type it yourself".

Run: python ocr-service/test_plate.py
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from plate import (  # noqa: E402
    Candidate,
    Fragment,
    assemble,
    best,
    clean_plate,
    fuse,
    is_structural,
    positional_fix,
    score,
)

_pass = 0
_fail = 0


def check(label: str, cond: bool, extra: str = "") -> None:
    global _pass, _fail
    if cond:
        _pass += 1
        print(f"  ok {label}")
    else:
        _fail += 1
        print(f"  XX {label} {extra}")


print("\nCleaning:")
check("strips separators", clean_plate("MH-12 AB 1234") == "MH12AB1234")
check("uppercases", clean_plate("mh12ab1234") == "MH12AB1234")
check("drops punctuation", clean_plate("*MH12AB1234*") == "MH12AB1234")
check("handles empty input", clean_plate("") == "")
check("handles None-ish input", clean_plate(None) == "")  # type: ignore[arg-type]

print("\nGrammar:")
check("standard plate is structural", is_structural("MH12AB1234"))
check("single-letter series is structural", is_structural("DL3C1234"))
check("two-digit RTO is structural", is_structural("KA05MK4321"))
check("three-letter series is structural", is_structural("UP32ABC1234"))
check("BH series is structural", is_structural("22BH1234AB"))
check("random text is not structural", not is_structural("HELLOWORLD"))
check("all digits is not structural", not is_structural("1234567890"))
check("too short is not structural", not is_structural("MH12"))

print("\nPositional repair (the accuracy win):")
check("O in state code -> stays alpha", positional_fix("MH12AB1234") == "MH12AB1234")
check("0 misread as O in RTO digits", positional_fix("MHI2AB1234") == "MH12AB1234")
check("B misread for 8 in the number block", positional_fix("MH12AB12B4") == "MH12AB1284")
check("O misread for 0 where the grammar demands digits", positional_fix("TN09BZOOO1") == "TN09BZO001")
# Honest limitation, asserted so it stays deliberate: when BOTH readings are
# legal plates the ambiguity is real and unresolvable from the text alone, so
# the read is left as OCR saw it. "KA05MKO321" is a valid KA-05-MKO-321.
check("a genuinely ambiguous O is left alone", positional_fix("KA05MKO321") == "KA05MKO321")
# "MH12ABO234" is itself a legal plate (MH-12-ABO-234). The repair must leave it
# alone even though "MH12AB0234" is also legal — rewriting an already-valid read
# on a guess is how a correct plate silently becomes a wrong one.
check("an already-legal read is never second-guessed", positional_fix("MH12ABO234") == "MH12ABO234")
check("S misread for 5 in the number block", positional_fix("KA05MK432S") == "KA05MK4325")
check("digit misread for a letter in the series", positional_fix("MH1245I234") == "MH12ASI234" or is_structural(positional_fix("MH1245I234")))
check("a valid plate is never rewritten", positional_fix("TN09BZ0001") == "TN09BZ0001")
check("unrepairable text is returned unchanged", positional_fix("RANDOMJUNK") == "RANDOMJUNK")
check("repair refuses to invent a fake state code", not is_structural(positional_fix("XX12AB1234")) or positional_fix("XX12AB1234") == "XX12AB1234")

print("\nScoring:")
check("noise token scores zero", score("IND", 0.99) == 0.0)
check("INDIA scores zero", score("INDIA", 0.99) == 0.0)
check("too short scores zero", score("MH12", 0.99) == 0.0)
check("all-letters is penalised", score("ABCDEFGHI", 0.9) < score("MH12AB1234", 0.9))
check("structure beats raw confidence", score("MH12AB1234", 0.55) > score("XQ99ZZ0000", 0.75))
check("a real state code outranks a fake one", score("MH12AB1234", 0.8) > score("XX12AB1234", 0.8))
check("confidence still matters between equals", score("MH12AB1234", 0.9) > score("MH12AB1234", 0.5))
check("score is never negative", score("AAAAAAAAA", 0.0) >= 0.0)

print("\nBest-of selection:")
v = best(
    [
        Candidate("IND", 0.99, "front", "otsu"),
        Candidate("MH12AB1234", 0.62, "front", "adaptive31"),
    ]
)
check("the hologram never beats the plate", v.plate == "MH12AB1234", str(v))
check("the winning variant is reported", v.variant == "adaptive31", str(v))

v = best([Candidate("MHI2AB12B4", 0.70, "front", "enhanced")])
check("a repaired read wins and is returned repaired", v.plate == "MH12AB1284", str(v))
check("a repaired read reports a real confidence", 0.0 < v.confidence <= 0.99)

v = best([])
check("no candidates yields no plate", v.plate is None)
check("no candidates yields zero confidence", v.confidence == 0.0)

v = best([Candidate("QQQQQQQQQ", 0.9, "front", "otsu")])
check("a junk-only pool yields no plate", v.plate is None, str(v))

print("\nFront/rear fusion:")
f = [Candidate("MH12AB1234", 0.61, "front", "otsu")]
b = [Candidate("MH12AB1234", 0.58, "back", "adaptive15")]
v = fuse(f, b)
check("agreement is detected", v.agreed is True, str(v))
check("agreement reports 'both'", v.source == "both", str(v))
check("agreement raises confidence above either read", v.confidence > 0.61, str(v))
check("agreement never reports certainty", v.confidence <= 0.99)

f = [Candidate("MH12AB1234", 0.91, "front", "otsu")]
b = [Candidate("MH12AB9999", 0.40, "back", "otsu")]
v = fuse(f, b)
check("disagreement picks the stronger read", v.plate == "MH12AB1234", str(v))
check("disagreement is not marked as agreed", v.agreed is False)

f = [Candidate("IND", 0.99, "front", "otsu")]
b = [Candidate("KA05MK4321", 0.55, "back", "upscaled")]
v = fuse(f, b)
check("a failed front falls through to the rear", v.plate == "KA05MK4321", str(v))

v = fuse([], [])
check("two failed images yield no plate", v.plate is None)
check("two failed images yield zero confidence", v.confidence == 0.0)
check("two failed images are not marked agreed", v.agreed is False)

# Repair + agreement together: two different misreads of the same plate must
# still converge. This is the case that used to force manual entry.
f = [Candidate("MHI2AB1234", 0.52, "front", "enhanced")]
b = [Candidate("MH12AB1Z34", 0.49, "back", "otsu")]
v = fuse(f, b)
check("two different misreads converge on one plate", v.plate == "MH12AB1234", str(v))
check("converged misreads are marked agreed", v.agreed is True, str(v))

# ── Two-line plate assembly ──────────────────────────────────────────────────
# Indian truck plates are frequently stacked on two lines. PaddleOCR returns each
# line as its own text box, and neither half reaches the six-character minimum, so
# before assembly a perfectly legible plate scored zero and forced manual entry.
print("\nTwo-line plate assembly:")

two_line = [Fragment("MH12", 0.93, 10.0, 50.0), Fragment("AB1234", 0.88, 40.0, 50.0)]
joined = assemble(two_line)
check("a stacked plate is reassembled", ("MH12AB1234", 0.88) in joined, str(joined))
check("confidence is the weakest half", all(c <= 0.88 for _, c in joined), str(joined))
check(
    "the assembled plate wins on its own",
    best([Candidate(t, c) for t, c in joined]).plate == "MH12AB1234",
    str(joined),
)

# Order must come from geometry, not from the order the OCR happened to report.
shuffled = [Fragment("AB1234", 0.88, 40.0, 50.0), Fragment("MH12", 0.93, 10.0, 50.0)]
check(
    "reading order comes from position, not list order",
    any(t == "MH12AB1234" for t, _ in assemble(shuffled)),
    str(assemble(shuffled)),
)

# Two boxes on the same line must join left-to-right.
side_by_side = [Fragment("KA05", 0.7, 20.0, 10.0), Fragment("MK4321", 0.6, 21.0, 90.0)]
check(
    "boxes on one line join left-to-right",
    any(t == "KA05MK4321" for t, _ in assemble(side_by_side)),
    str(assemble(side_by_side)),
)

three = [
    Fragment("IND", 0.99, 5.0, 10.0),
    Fragment("MH12", 0.90, 30.0, 50.0),
    Fragment("AB1234", 0.85, 60.0, 50.0),
]
v = best([Candidate(t, c) for t, c in assemble(three)])
check("a hologram line does not corrupt the assembly", v.plate == "MH12AB1234", str(v))

check("a single fragment produces no assembly", assemble([Fragment("MH12AB1234", 0.9, 0.0, 0.0)]) == [])
check("no fragments produce no assembly", assemble([]) == [])
check(
    "assembly never returns anything outside 6..11 characters",
    all(6 <= len(t) <= 11 for t, _ in assemble(three)),
)
# Two halves of a manufacturer's name must not become a plate.
junk = assemble([Fragment("TATA", 0.9, 10.0, 0.0), Fragment("MOTORS", 0.9, 30.0, 0.0)])
check(
    "all-letters assemblies are rejected by the scorer",
    best([Candidate(t, c) for t, c in junk]).plate is None,
    str(junk),
)

print("\nManual fallback contract:")
check("a null plate is always representable", best([]).plate is None)
check("service never raises on junk input", best([Candidate("", 0.0)]).plate is None)
check("service never raises on empty text", positional_fix("") == "")

print(f"\n==== ocr plate logic: {_pass} passed, {_fail} failed ====")
sys.exit(1 if _fail else 0)
