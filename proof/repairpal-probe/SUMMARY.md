# RepairPal live-probe harness + what it proved

## The harness (works, reusable)
`.agent/tmp/rp-*.mjs` — headed real Chrome (channel:chrome) + persistent profile that clears **Cloudflare Turnstile**, then drives the full RepairPal estimator flow:

`repair-services?zipCode={zip}&baseVehicleId={car}&serviceId={svc}` → *(service options e.g. Front/Rear)* → **engine pick** → **lead gate** (name+email) → `estimate-results?estimateId=…` → read **total + Labor% + Parts%**.

- Parameterized by **car × service × zip × engine**.
- Full service **catalog extracted: 177 services** with IDs (`.agent/tmp/rp-services.json`) — Oil 107, Spark 128, Brake Pads 30, Alignment 169, Battery 590, Air Filter 14, …
- baseVehicleId resolved per car via the estimator form (2018 Porsche 911 = 76774).
- So **yes — every service on every car is reachable.** Option-bearing services (brakes/rotors/alignment) need one extra "choose details" click, handled by a small state-machine.

## What it found — 2018 Porsche 911 Turbo S, 3.8L, zip 10001
| Service | RepairPal total | Labor% | Parts% | labor$ (mid) | hours ÷ $130 | hours ÷ $220 (Porsche rate) | our pipeline |
|---|---|---|---|---|---|---|---|
| Oil Change | $614–650 | **13%** | 87% | ~$82 | 0.63h | 0.37h | 0.5h |
| Spark Plugs | $1,232–1,935 | **96%** | 4% | ~$1,520 | **11.7h** | 6.9h | 3.0h |
| Brake Pads (front) | $2,385–2,565 | **16%** | 84% | ~$396 | 3.05h | 1.8h | 1.2h |
| Battery | $789–880 | **24%** | 76% | ~$200 | 1.54h | 0.9h | 1.2h |

(Earlier: zip 10001 and 10301 give identical oil-change numbers — same metro labor band.)

## The verdict
1. **Our 0.5h oil-change wasn't a parse bug** — it's RepairPal's real (low) number for a parts-dominated service at that zip.
2. **RepairPal gives DOLLARS, not HOURS.** The labor share swings **13% → 96%** by service, and the dollars carry a **brand + location** rate baked in. Converting with a fixed `÷ $130` produces nonsense (spark plugs → 11.7h) and disagrees with our pipeline on every line.
3. **There is no fixed rate that reconciles them.** At $130 vs a Porsche-specialist $220, the "recovered hours" move by ~2×. The true flat-rate hours don't change with zip or brand — but RepairPal's dollars do.

## Recommendation
- **RepairPal is a good DOLLAR source, a poor HOURS source.** If we want labor *hours*, use a flat-rate-hours authority that publishes hours directly (MOTOR / Mitchell1 / ALLDATA), not RepairPal dollars ÷ an assumed rate.
- **OR** quote in dollars: pin one zip, take RepairPal's total + labor/parts split as the estimate directly, and stop pretending we recovered "hours."
- Either way, the current `recoverHours = labor$ ÷ $130` should be retired — it's the root of the "data feels wrong" symptom.

## Status
- Proven live: Oil, Spark, Battery, Brake Pads on the 911.
- Remaining (minor): per-service option handling for Wheel Alignment / Air Filter; extend to the other 3 cars (just their baseVehicleIds).
