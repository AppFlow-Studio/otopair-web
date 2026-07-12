/**
 * vehicleEnrichment/validation/sourceAuthority.ts — Source authority classifier
 *
 * User forums and crowd-answer sites are legitimate for discovery but must NOT be
 * trusted as the sole source for a numeric spec (fluid capacity, torque, interval).
 * A single forum post is how `coolant_capacity_qts = 16.9` (from silveradosierra.com)
 * entered on the 2023 GMC Sierra L84 — the model scored it 0.85 despite its own rubric
 * requiring 2+ corroborating pages for any forum value.
 *
 * runSanityChecks uses this to ESCALATE an out-of-band range flag to a hard drop when
 * the value's only source is low-authority. An out-of-band value from a reputable /
 * scraped OEM source is still only flagged (kept for review), never dropped.
 */

/**
 * Known community forums and crowd-answer domains. Distinct from sourceRegistry's
 * BLOCKED_DOMAINS (hard web_search blocklist) — these are allowed to be gathered but
 * are down-trusted for numeric specs. Extend as new low-authority sources surface.
 */
export const LOW_AUTHORITY_DOMAINS: readonly string[] = [
  // ── Truck / GM ──
  "silveradosierra.com", "gm-trucks.com", "duramaxforum.com", "cumminsforum.com",
  // ── Ford ──
  "f150forum.com", "ford-trucks.com", "f150gen14.com", "explorerforum.com",
  // ── Toyota / Honda / import ──
  "tacomaworld.com", "toyotanation.com", "tundras.com", "clublexus.com",
  "hondatech.com", "civicx.com", "driveaccord.net", "nasioc.com", "subaruoutback.org",
  // ── Euro ──
  "bimmerfest.com", "bimmerpost.com", "mbworld.org", "benzworld.org",
  "audizine.com", "vwvortex.com", "clubtouareg.com",
  // ── Jeep / Mopar ──
  "jeepforum.com", "jlwranglerforums.com", "cherokeeforum.com",
  // ── General crowd Q&A ──
  "reddit.com", "quora.com", "answers.com", "fixya.com", "justanswer.com",
  // ── Video platforms — numeric specs come from video descriptions/comments,
  //    not vettable documents. A YouTube "13.8 qt" beat two agreeing real
  //    sources on the 2019 Silverado L84 (stress fleet, 2026-07-11). ──
  "youtube.com", "youtu.be", "tiktok.com", "vimeo.com",
];

const LOW_AUTHORITY_SET = new Set(LOW_AUTHORITY_DOMAINS);

/** Extract a bare, lower-cased hostname (www-stripped) from a URL or raw domain. */
export function toHostname(urlOrDomain: string): string {
  let host = urlOrDomain.toLowerCase().trim();
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname;
    } catch {
      /* not a parseable URL — fall through with the raw string */
    }
  }
  return host.replace(/^www\./, "");
}

/**
 * True when the source is a user forum / crowd-answer site (explicit list OR a hostname
 * that looks like a forum, e.g. "forums.example.com" / "example.com/forum/...").
 * Training-data values (no URL) return false — they are governed by the confidence rubric.
 */
export function isLowAuthorityDomain(urlOrDomain: string | null | undefined): boolean {
  if (!urlOrDomain) return false;
  const host = toHostname(urlOrDomain);
  if (!host) return false;
  if (/(^|\.)forums?\./.test(host) || /forum/.test(host)) return true;
  if (LOW_AUTHORITY_SET.has(host)) return true;
  return LOW_AUTHORITY_DOMAINS.some((d) => host.endsWith(`.${d}`));
}

// ─── High-authority spec sources ─────────────────────────────────
//
// The INVERSE of the low-authority list: domains trustworthy enough that a
// SINGLE citation is sufficient to accept a numeric spec (capacity/torque).
// Used by the capacity resolver's accept gate — a value from one of these, or
// corroborated by 2+ independent non-forum domains, is trusted. Curate
// conservatively: a false entry here authorizes a single-source accept.

export const HIGH_AUTHORITY_SPEC_DOMAINS: readonly string[] = [
  // ── OEM / manufacturer technical + owner resources ──
  "gm.com", "my.gm.com", "gmc.com", "chevrolet.com", "cadillac.com", "buick.com",
  "gmupfitter.com", "gm-techlink.com", "gmauthority.com",
  "ford.com", "fordservicecontent.com", "owner.ford.com", "motorcraft.com",
  "toyota.com", "techinfo.toyota.com", "lexus.com",
  "honda.com", "techinfo.honda.com", "owners.honda.com", "acura.com",
  "mopar.com", "moparrepairconnect.com", "stellantis.com",
  "vw.com", "audi.com", "audiusa.com", "bmw.com", "bmwusa.com",
  "mbusa.com", "mercedes-benz.com", "nissanusa.com", "subaru.com",
  "hyundaiusa.com", "kia.com", "mazdausa.com", "volvocars.com",
  // ── Professional service data / spec databases ──
  "alldata.com", "alldatadiy.com", "mitchell1.com", "prodemand.com",
  "identifix.com", "chiltondiy.com", "chilton.com", "haynes.com",
  "motor.com", "repairpal.com", "carcarekiosk.com",
  // ── Fluid-capacity spec references ──
  "engineoilcapacity.com", "oilcapacity.net", "fluidcapacity.com",
  "capacity.report", "oilspecifications.org",
];

const HIGH_AUTHORITY_SET = new Set(HIGH_AUTHORITY_SPEC_DOMAINS);

/**
 * True when the source is a curated authoritative spec domain (OEM technical,
 * professional service data, or a fluid-capacity reference). A single such
 * citation is enough to accept a numeric spec.
 */
export function isHighAuthorityDomain(urlOrDomain: string | null | undefined): boolean {
  if (!urlOrDomain) return false;
  const host = toHostname(urlOrDomain);
  if (!host) return false;
  if (HIGH_AUTHORITY_SET.has(host)) return true;
  return HIGH_AUTHORITY_SPEC_DOMAINS.some((d) => host.endsWith(`.${d}`));
}
