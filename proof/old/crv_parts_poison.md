# OLD CR-V parts poison — ardent-crab, config w5709tw8…
# part_prices read by_part; names via oem_parts get_doc.

## Oil Drain Plug Gasket — OEM 94109-14000 (part ph7b0tvr…)
| price | type | source_domain | source_url |
|---|---|---|---|
| $3.405 | online_discount | hondapartsnow.com | …filter~oil~15400-plm-a02 |
| $3.395 | online_discount | acurapartswarehouse.com | …filter~oil~…15400-rta-003 |
| **$17.50** | online_discount | racinghistorycompany.com | **…oil-filter-91-05-NSX** ← wrong car, wrong part |
| $3.785 | online_discount | hondapartsonline.net | …oil-filter-15400plma02 |

Poison: a $17.50 price scraped from an **Acura NSX oil-filter** page attached to a
**Honda CR-V drain-plug gasket**. Real gasket ≈ $3.40. NEW poison-exclusion median ≈ $0.52
(the NSX row is excluded).

## Front Brake Pads — OEM 45022-T0A-A01 (part ph7cc8q2…)
| price | type | source_domain | source_url |
|---|---|---|---|
| $25.495 | online_discount | shop.advanceautoparts.com | …brake-pads-and-shoes (generic search page) |
| $29.745 | online_discount | hondapartsconnection.com | …pad-set-front-45022t0aa01 (correct: front) |
| **$20.40** | online_discount | hondacarpartsdirect.com | **…brake-pads-rear-43022t0ga01** ← REAR pad price on the FRONT part |

Poison: a **rear** brake-pad price mixed into the **front** brake-pad row, plus a generic
search-page price. NEW pipeline is position-aware (front/rear separated) and re-parses each
source URL.
