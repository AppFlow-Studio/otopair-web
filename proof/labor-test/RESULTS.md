# New labor-system results — 4 VINs

All four VINs enriched fresh on flippant-mink and produced RepairPal-gated labor. Hours are `book_hours`; `grade` = passed the quote gate (✓) or held back as low-confidence (—).

---

## 1 · 2018 Porsche 911 Turbo S
VIN `WP0AD2A99JS156240` · engine MA1.76 (3.8 flat-6 TT) · **resolved via exact "911" nameplate** · graded 5/6

| Service | Hours | Conf | Source | RepairPal | Grade |
|---|---|---|---|---|---|
| Oil change | 0.5 | 0.9 | aggregated | ✓ | ✓ |
| Spark plugs | 3.0 | 0.8 | aggregated | ✓ | ✓ |
| Brake pads | 1.2 | 0.8 | aggregated | ✓ | ✓ |
| Wheel alignment | 2.3 | 0.8 | aggregated | ✓ | ✓ |
| Battery | 1.2 | 0.8 | aggregated | ✓ | ✓ |
| Rotor replacement | 2.0 | 0.4 | aggregated | — | — |
| Filter replacement | 0.5 | 0.4 | aggregated | — | — |
| Coolant flush | 1.5 | 0.4 | aggregated | — | — |
| Transmission service | 1.5 | 0.4 | aggregated | — | — |
| Differential service | 1.0 | 0.45 | training_data | — | — |
| Power steering flush | 0.75 | 0.45 | training_data | — | — |
| Brake fluid flush | 1.0 | 0.4 | aggregated | — | — |

RepairPal observations (weight 0.8, exact ← 911): oil 0.47 · spark 3.01 · brake 1.16 · alignment 2.32 · battery 1.16.

---

## 2 · 2020 Volvo XC90 T6 Momentum
VIN `YV4A22PKXL1620464` · engine B4204TS (2.0 super+turbo I4) · **resolved via exact "xc90", spark via XC40 engine-sibling** · graded 5/6

| Service | Hours | Conf | Source | RepairPal | Grade |
|---|---|---|---|---|---|
| Oil change | 0.6 | 0.9 | aggregated | ✓ | ✓ |
| Spark plugs | 1.0 | 0.8 | aggregated | ✓ | ✓ |
| Brake pads | 1.3 | 0.9 | aggregated | ✓ | ✓ |
| Wheel alignment | 1.4 | 0.8 | aggregated | ✓ | ✓ |
| Battery | 0.9 | 0.8 | aggregated | ✓ | ✓ |
| Rotor replacement | 2.0 | 0.4 | aggregated | — | — |
| Filter replacement | 0.3 | 0.4 | aggregated | — | — |
| Coolant flush | 1.0 | 0.4 | aggregated | — | — |
| Transmission service | 1.5 | 0.4 | aggregated | — | — |
| Differential service | 1.0 | 0.45 | training_data | — | — |
| Power steering flush | 0.75 | 0.45 | training_data | — | — |
| Brake fluid flush | 0.8 | 0.4 | aggregated | — | — |

RepairPal observations (weight 0.8): oil 0.58 · brake 1.27 · alignment 1.39 · battery 0.93 · timing_belt 4.17 — exact ← xc90; spark 1.04 — engine_family:B4204 ← xc40.

---

## 3 · 2020 Honda Civic Sport
VIN `2HGFC2F89LH556366` · engine K20C2 (2.0 I4) · **resolved via exact "civic" nameplate** · graded 5/6

| Service | Hours | Conf | Source | RepairPal | Grade |
|---|---|---|---|---|---|
| Oil change | 0.6 | 0.9 | aggregated | ✓ | ✓ |
| Spark plugs | 1.3 | 0.8 | aggregated | ✓ | ✓ |
| Brake pads | 1.0 | 0.9 | aggregated | ✓ | ✓ |
| Wheel alignment | 1.3 | 0.8 | aggregated | ✓ | ✓ |
| Battery | 0.6 | 0.9 | aggregated | ✓ | ✓ |
| Rotor replacement | 1.5 | 0.4 | aggregated | — | — |
| Filter replacement | 0.2 | 0.4 | aggregated | — | — |
| Coolant flush | 1.0 | 0.4 | aggregated | — | — |
| Transmission service | 0.8 | 0.4 | aggregated | — | — |
| Power steering flush | 0.75 | 0.45 | training_data | — | — |
| Brake fluid flush | 0.8 | 0.4 | aggregated | — | — |

RepairPal observations (weight 0.8, exact ← civic): oil 0.58 · spark 1.27 · brake 1.04 · alignment 1.27 · battery 0.58.

---

## 4 · 2018 Mercedes-AMG C63 S
VIN `55SWF8HB1JU241919` · chassis W205 · engine M177 (4.0 V8 biturbo) · **only oil + spark resolved (engine-family sibling `M177 ← e43-amg`); rest gated out** · graded 2/6

| Service | Hours | Conf | Source | RepairPal | Grade |
|---|---|---|---|---|---|
| Oil change | 0.6 | 0.9 | aggregated | ✓ | ✓ |
| Spark plugs | 4.6 | 0.8 | aggregated | ✓ | ✓ |
| Brake pads | 1.5 | 0.4 | aggregated | — | — |
| Rotor replacement | 2.0 | 0.4 | aggregated | — | — |
| Battery | 0.5 | 0.4 | aggregated | — | — |
| Wheel alignment | 1.0 | 0.4 | aggregated | — | — |
| Filter replacement | 0.3 | 0.4 | aggregated | — | — |
| Coolant flush | 1.0 | 0.4 | aggregated | — | — |
| Transmission service | 2.0 | 0.4 | aggregated | — | — |
| Differential service | 1.0 | 0.45 | training_data | — | — |
| Power steering flush | 0.75 | 0.45 | training_data | — | — |
| Brake fluid flush | 0.8 | 0.4 | aggregated | — | — |

RepairPal observations (weight 0.8): oil 0.58 · spark 4.63 — engine_family:M177 ← e43-amg.
⚠️ The e43-amg sibling is a V6 (M276), not M177 — the spark figure was sourced from the wrong engine. See `SUMMARY.md` for the root cause.

---

## Roll-up

| Car | Engine | Resolution | Graded | Spark plugs |
|---|---|---|---|---|
| Porsche 911 Turbo S | MA1.76 flat-6 TT | exact 911 | 5/6 | 3.0h |
| Volvo XC90 T6 | B4204 I4 | exact xc90 (+XC40 spark) | 5/6 | 1.0h |
| Honda Civic Sport | K20C2 I4 | exact civic | 5/6 | 1.3h |
| Mercedes-AMG C63 S | M177 V8 | sibling e43-amg (wrong) | 2/6 | 4.6h |

Sanity: graded spark-plug hours scale with engine size — 4-cyl ~1.0–1.3h < flat-6 TT 3.0h < V8 4.6h.
