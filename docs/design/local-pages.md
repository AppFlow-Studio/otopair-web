# Local pages: composition matrix (2026-09-05)

The app-up-close pass applied to the local engine: coverage, the four
borough pages, the Staten Island hub and its ten service pages, the shop
directory and the shop profile. Method: `~/.claude/skills/app-up-close/`
(the Otopair case study is `docs/design/app-up-close-playbook.md`).

Standing rules on these pages: no stand-in shop names (every shop name is
live data from `lib/public-shops.ts` or the page shows the app's own
loading / empty state); no prices, ranges or the fee rate; the only numbers
are the $20 hold and 24 hours; no eyebrows; no icon-card grids.

## New screens (from otopair-1 source values)

| Screen | Source | File |
| --- | --- | --- |
| Select Services (full and low snap), pins, browse card | `app/(booking-flow)/select-services.tsx`, GlassSheet, HeroCard*, CategoryListRow, QuickBookRow, MapBrowseShopCard, RatingMarkerPill | `components/flagship/product/screens/browse.tsx` |
| Category list, ServiceMultiSelectRow, StickyContinueBar | `app/(booking-flow)/category/[tab].tsx`, `constants/serviceTaxonomy.ts` | same |
| Oto's in-chat wizard, stage 1 | `components/ai-chat/BookServiceComponent.tsx` | same |
| Service info sheet (the ⓘ on a row) | `components/booking-flow/ServiceInfoSheet.tsx`, copy from `constants/serviceCopy.ts` (mirrored to `lib/service-copy.ts`) | same |
| Shop detail (map hero, ShopHeroCard, tabs, reviews, mechanics, portfolio) | `app/booking/shop/[id]`, ShopHeroCard, RatingSummaryCard, ReviewCard, ShopMechanicsSection | `components/flagship/product/screens/shop.tsx` |

Web-scale objects: `components/flagship/product/local.tsx` (BoroughRail,
DirectoryCard, VerifiedPull). Compositions: `components/flagship/local-sections.tsx`.
Static maps: `lib/static-map.ts` (Mapbox Static Images, light-v11, no
logo; `project` places real shops as pins on the phone map).

## Matrix

| Page | Section | Claim | Device | Object pulled out | Motion | Plate |
| --- | --- | --- | --- | --- | --- | --- |
| /coverage | hero | Staten Island now, four next | live map | | live | shell |
| /coverage | 1 | Which borough is next | none | borough rail, real shop count | first segment draws, stops stagger | pale |
| /coverage | 2 | Shops first, drivers second | browser (rates page, "Your shop") | three steps | reveal | paper |
| /coverage | 3 | FAQ | | | | |
| /staten-island | hero | Car repair on SI, locked price | phone: Select Services (full), CLOSEST SHOP = a real shop or the loading state, real pins | | reveal | shell |
| /staten-island | 1 | Which shops can I book | none: directory cards (live) or empty prose | | stagger | |
| /staten-island | 2 | Where they are | live map in a Bezel | | live | |
| /staten-island | 3 | Which services | phone: category list, looping the four tabs | the ten local links | loop 3.6 s | sky |
| /staten-island | 4 | Neighborhoods | none (typographic) | | | |
| /staten-island | 5 | details + FAQ | | | | |
| /staten-island/[svc] | hero | Service in Staten Island | phone: category list, this service selected | | reveal | shell |
| /staten-island/[svc] | 1 | Which shops offer it | none: directory cards (live) or empty prose | | stagger | |
| /staten-island/[svc] | 2 | How do I book it | phone: chat + wizard stage 1, service pre-checked | the seven booking steps | reveal | pale |
| /staten-island/[svc] | 3 | cost, cars, FAQ | | | | |
| /brooklyn etc. | hero | Coming to the borough | waitlist form | | | shell |
| /brooklyn etc. | 1 | What opens on day one | phone: the Oto conversation (no shop names) | driver / shop columns | reveal | sky |
| /brooklyn etc. | 2 | Where it sits on the ladder | none: borough rail, this borough marked | | draw | pale |
| /brooklyn etc. | 3 | FAQ | | | | |
| /shops | hero | Shops you can book | phone: Select Services (low snap) over the island, real pins, the first shop's browse card | | reveal | shell |
| /shops | 1 | N verified shops | none: directory cards (live), grouped past six | | stagger | |
| /shops | 2 | What verified means | browser (rates page) | the four checks | reveal | paper |
| /shops | 3 | booking + FAQ | | | | |
| /shops/[slug] | hero | The shop | phone: the shop's own app page, real data, the tab that has content | | reveal | shell |
| /shops/[slug] | body | services, hours, mechanics, photos, reviews, directions, FAQ | none (document; app anatomies at reading size) | | | |
| /services | hero | 22 services, four categories | none | | | shell |
| /services | 1 | the catalog | pinned phone, 5 steps: Select Services, then the four category lists | the crawlable rows under each step | pinned crossfade | sky |
| /services | 2 | details + FAQ | | | | |
| /services/[slug] | hero | The service | phone: the app's info sheet for the service over its category list (lib/service-copy.ts, the Service Guide verbatim) | | reveal | shell |
| /services/[slug] | 1 | includes, when, cars, price, shops (live cards), FAQ | none | | | |

Rule checks: no two consecutive rows share a device; the six openers are
map / full sheet / category list / form / low sheet with browse card /
shop page; every page has one row with motion beyond reveal (the rail
draw, the tab loop, the live map).

## Empty states are designed states

The shared dev deployment has no verified shop, so every "live data"
object also renders its honest empty state: the CLOSEST SHOP card's own
"Finding nearby shops..." copy, no pins, no browse card, the empty-state
prose in place of the directory. The populated states were verified on a
fixture lab route (deleted before commit) and are captured in the proof
board.
