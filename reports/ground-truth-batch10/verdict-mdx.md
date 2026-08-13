# MDX verdict (batch 10)

Strong run: ~30 PASS incl every GT trap (plug DILZKR7B11G, DPSF-not-DPF-II, EPS no-fluid, 5.7qt oil). Diff fluid DPSF + 2.7qt + 30k/18mo IS stored (better than collect suggested); transfer case HGO-1 0.45qt EXACT (sanity flag false alarm); water pump 19200-RDV-J01 / trans filter 25430-PLR-003 / timing belt 14400-R9P-A01 all verified correct.

**REFUTED candidate defect: cabin filter 80292-SDA-407 is the OEM consolidated SUPERSESSION of TZ5-A41 (acurapartswarehouse sells SDA-407 as primary for 2014 MDX). Persisting past part_pattern_suspect was CORRECT. Do not ship a "fix".**

DEFECTS:
P1. Engine oil part 08798-9032 = Honda 5W-20 synthetic BLEND on an 0W-20 engine. conf 0.75, 1 source, no source_domains, NO flag fired — round-7 fluid gates don't cover oil-part-vs-engine-viscosity. Correct: 08798-9163 (0W-20 FS). ROUND-8 GATE CANDIDATE.
P2-a. ATF interval 60k (vdb_schedule, 1 source) vs MM code 3 band 20k-40k — 1.5-3x late on DW-1 6AT.
P2-b. DPSF 08200-9007A no part_fitment → Differential Service parts-unquotable despite correct fluid/capacity/interval.
P3: no price rows air filter + plug ($40/ea plug unchecked); 4 default_fallback rows status "scheduled" (SYSTEMIC 3/3 configs so far); part_fitments has NO suspect/data_quality marker (part_pattern_suspect only in run_errors — downstream can't see); 14400-R9P-A01 mislabeled "Timing Kit" (belt only → under-scoped quote); Honda make_id on Acura config parts (benign cross-make dedup).

Interval PASSes: oil 7.5k, rotation 7.5k/12mo, filters 30k/30mo, coolant 105k/120mo, plugs+timing 105k/84mo, brake fluid 36mo, diff 30k/18mo.
