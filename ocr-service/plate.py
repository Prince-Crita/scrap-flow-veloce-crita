"""
Scrap Flow · Veloce — plate text logic.

Deliberately free of cv2, numpy, torch and fastapi so it can be reasoned about
and unit-tested on its own (see test_plate.py). Everything here is pure: given
the same OCR candidates it always returns the same answer.

This is where most of the accuracy actually comes from. A raw OCR read of an
Indian plate is usually *nearly* right — the failures are overwhelmingly
character confusions (0/O, 1/I, 8/B, 5/S) and stray text picked up from the
bumper, not a wholly unreadable plate. Knowing the legal plate grammar lets us
repair those reads instead of discarding them and asking the operator to type
the number by hand.
"""

from __future__ import annotations

import re
from typing import Iterable, NamedTuple, Optional

# ── Plate grammars ───────────────────────────────────────────────────────────
# Indian registration formats, after separators are stripped.
#
#   standard  MH12AB1234   state(2A) rto(1-2D) series(0-3A) number(4D)
#   bharat    22BH1234AB   year(2D) "BH" number(4D) series(1-2A)
#
# Older/short plates (MH12A1234, DL3C1234) are covered by the standard pattern's
# optional series and 3-4 digit tail.
STANDARD_RE = re.compile(r"^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{3,4}$")
BHARAT_RE = re.compile(r"^[0-9]{2}BH[0-9]{4}[A-Z]{1,2}$")

# Text that legitimately appears on or near Indian plates but is never part of
# the registration. Without this the hologram/word "IND" wins on some frames.
NOISE_TOKENS = {"IND", "INDIA", "BHARAT", "GOVT", "TAXI", "TRANSPORT"}

# Valid state/UT codes. A read starting with a non-existent code is almost
# always a misread first character, which `positional_fix` can often repair.
STATE_CODES = {
    "AN", "AP", "AR", "AS", "BR", "CG", "CH", "DD", "DL", "DN", "GA", "GJ",
    "HP", "HR", "JH", "JK", "KA", "KL", "LA", "LD", "MH", "ML", "MN", "MP",
    "MZ", "NL", "OD", "OR", "PB", "PY", "RJ", "SK", "TN", "TR", "TS", "UK",
    "UP", "WB",
}

# Character confusions, split by the direction of the repair. Applied only at
# positions where the grammar already tells us which class is expected, so a
# legitimate "0" in a number block is never rewritten to "O".
TO_ALPHA = {"0": "O", "1": "I", "2": "Z", "4": "A", "5": "S", "6": "G", "8": "B"}
TO_DIGIT = {
    "O": "0", "D": "0", "Q": "0", "I": "1", "L": "1", "J": "1", "Z": "2",
    "A": "4", "S": "5", "G": "6", "B": "8", "T": "7",
}


class Candidate(NamedTuple):
    """One OCR read, plus where it came from — kept for explainability."""

    text: str
    confidence: float
    source: str = ""  # "front" | "back"
    variant: str = ""  # which preprocessing produced it


class Verdict(NamedTuple):
    plate: Optional[str]
    confidence: float
    source: Optional[str]
    variant: Optional[str]
    # True when front and back independently produced the same plate. This is
    # the strongest signal available and is surfaced so the UI can trust it.
    agreed: bool = False


def clean_plate(text: str) -> str:
    """Strip everything that cannot appear in a registration number."""
    return re.sub(r"[^A-Z0-9]", "", (text or "").upper())


def is_structural(text: str) -> bool:
    return bool(STANDARD_RE.match(text) or BHARAT_RE.match(text))


def _coerce(ch: str, want: str) -> str:
    if want == "A":
        return ch if ch.isalpha() else TO_ALPHA.get(ch, ch)
    return ch if ch.isdigit() else TO_DIGIT.get(ch, ch)


def positional_fix(text: str) -> str:
    """
    Repair character confusions using the plate grammar.

    Only positions whose class is unambiguous under a candidate layout are
    touched, and the repair is kept only if it produces a structurally valid
    plate. A read that is already valid is returned untouched, so this can
    never turn a correct plate into a wrong one.
    """
    s = clean_plate(text)
    if not s or is_structural(s):
        return s

    # Several layouts can each yield a valid plate — "MHI2AB1234" is a legal
    # AA-D-AAA-DDDD plate if you also rewrite the '2', and a legal
    # AA-DD-AA-DDDD plate if you only rewrite the 'I'. Taking the first match
    # would silently prefer whichever layout happened to be enumerated first,
    # so choose the repair that changes the fewest characters: the OCR was
    # nearly right, and the smallest correction is the likeliest truth.
    best_fixed: Optional[str] = None
    best_edits = 99
    for layout in _layouts_for(len(s)):
        fixed = "".join(_coerce(c, want) for c, want in zip(s, layout))
        if not is_structural(fixed):
            continue
        # A repaired standard plate must still name a real state.
        if STANDARD_RE.match(fixed) and fixed[:2] not in STATE_CODES:
            continue
        edits = sum(1 for a, b in zip(s, fixed) if a != b)
        if edits < best_edits:
            best_fixed, best_edits = fixed, edits
    return best_fixed if best_fixed is not None else s


def _layouts_for(n: int) -> Iterable[str]:
    """
    Every legal class layout ("A"=letter, "D"=digit) of length n.

    Enumerated rather than parsed because the ambiguity is the point: for a
    9-character read we genuinely do not know whether it is AA-D-AAA-DDDD or
    AA-DD-AA-DDDD until we try both against the grammar.
    """
    for rto in (1, 2):
        for series in (0, 1, 2, 3):
            for tail in (3, 4):
                if 2 + rto + series + tail == n:
                    yield "A" * 2 + "D" * rto + "A" * series + "D" * tail
    for series in (1, 2):
        if 2 + 2 + 4 + series == n:
            yield "D" * 2 + "AA" + "D" * 4 + "A" * series


class Fragment(NamedTuple):
    """One OCR text box, with enough geometry to put it back in reading order."""

    text: str
    confidence: float
    y: float
    x: float


# A two-line plate can only be assembled from a handful of boxes; beyond that the
# region is signage, not a plate, and every extra combination costs latency for
# candidates the scorer will reject anyway.
MAX_ASSEMBLY_FRAGMENTS = 5


def assemble(fragments: Iterable[Fragment]) -> list[tuple[str, float]]:
    """
    Rebuild plates that the OCR returned as SEPARATE text boxes.

    Indian truck plates are very often two-line — "MH12" above "AB1234" — and
    tractor/commercial plates sometimes three. PaddleOCR reports each line as its
    own box, so both halves individually fail the six-character minimum and the
    plate was being discarded entirely. That is not a recognition failure; it is an
    assembly failure, and at a scrap yard (where most inbound vehicles are trucks)
    it was the single most common reason a legible plate came back as null.

    Fragments are sorted into reading order (top-to-bottom, then left-to-right) and
    every run of 2..n consecutive fragments is concatenated. Confidence is the
    WEAKEST part's — a join is only as trustworthy as its worst half. Nothing is
    filtered here beyond an obvious length bound: `positional_fix` and `score`
    already decide what is plausible, and duplicating that judgement in two places
    is how the two drift apart.
    """
    frags = [f for f in fragments if clean_plate(f.text)][:MAX_ASSEMBLY_FRAGMENTS]
    if len(frags) < 2:
        return []
    # Row-major with a tolerance band: boxes on the same line rarely share an exact
    # y, so bucket by a fraction of the spread before ordering left-to-right.
    ys = [f.y for f in frags]
    band = max(1.0, (max(ys) - min(ys)) / 4.0)
    ordered = sorted(frags, key=lambda f: (round(f.y / band), f.x))

    out: list[tuple[str, float]] = []
    seen: set[str] = set()
    for size in range(2, len(ordered) + 1):
        for start in range(0, len(ordered) - size + 1):
            run = ordered[start : start + size]
            joined = "".join(clean_plate(f.text) for f in run)
            if not (6 <= len(joined) <= 11) or joined in seen:
                continue
            seen.add(joined)
            out.append((joined, min(f.confidence for f in run)))
    return out


def score(text: str, confidence: float) -> float:
    """
    Rank a candidate. OCR confidence alone is a poor guide — a crisp read of the
    word "IND" beats a slightly blurred read of the real plate — so structure
    and plausibility carry real weight.
    """
    s = clean_plate(text)
    if not s or s in NOISE_TOKENS:
        return 0.0
    if len(s) < 6 or len(s) > 11:
        return 0.0
    # Every registration mixes letters and digits. An all-letters or all-digits
    # read is a sign, a slogan or a phone number — not a plate — so it is
    # rejected outright rather than merely penalised. A soft penalty let a
    # confident nine-character misread beat nothing at all and be presented to
    # the operator as if it were a real number.
    if not any(c.isdigit() for c in s) or not any(c.isalpha() for c in s):
        return 0.0

    v = max(0.0, min(1.0, confidence))
    bonus = 0.0
    if is_structural(s):
        bonus += 0.30
    if STANDARD_RE.match(s):
        # A plate that names a real state is far more trustworthy than one that
        # merely has the right shape; weight the difference rather than only
        # rewarding the good case, or a crisp misread of a nonexistent state
        # outranks a blurred read of a real one.
        bonus += 0.15 if s[:2] in STATE_CODES else -0.25
    if 9 <= len(s) <= 10:
        bonus += 0.05
    return max(0.0, v + bonus)


def best(candidates: Iterable[Candidate]) -> Verdict:
    """Pick the strongest candidate, repairing each read before ranking it."""
    winner: Optional[Candidate] = None
    winner_score = 0.0
    for c in candidates:
        fixed = positional_fix(c.text)
        s = score(fixed, c.confidence)
        if s > winner_score:
            winner, winner_score = Candidate(fixed, c.confidence, c.source, c.variant), s
    if winner is None:
        return Verdict(None, 0.0, None, None, False)
    # Report a confidence that reflects the structural evidence, capped so a
    # repaired read never claims certainty.
    reported = min(0.99, winner_score) if is_structural(winner.text) else min(0.75, winner.confidence)
    return Verdict(winner.text, round(reported, 3), winner.source or None, winner.variant or None, False)


def fuse(front: Iterable[Candidate], back: Iterable[Candidate]) -> Verdict:
    """
    Combine both views of the vehicle.

    Front and back plates carry the same registration, so agreement between two
    independent reads is far stronger evidence than either read alone — that is
    the "combined confidence" pass, and it is what rescues frames where neither
    image on its own clears the bar.
    """
    front = list(front)
    back = list(back)
    fv = best(front)
    bv = best(back)

    if fv.plate and bv.plate and fv.plate == bv.plate:
        return Verdict(
            fv.plate,
            round(min(0.99, max(fv.confidence, bv.confidence) + 0.15), 3),
            "both",
            fv.variant,
            True,
        )

    # No agreement: fall back to whichever view scored better across the pooled
    # candidates, so a strong single read still wins.
    pooled = best(front + back)
    if pooled.plate:
        return pooled
    return fv if fv.confidence >= bv.confidence else bv
