// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import nextConfig from "@/next.config";
import {
  LEGAL_FACTS,
  SITE_POLICY_PAGES,
  bannedWordsIn,
  legalTokens,
  pendingTokens,
  sitePolicyMetadata,
  type SitePolicyKind,
} from "@/lib/legal";
import { SITE_POLICY_FILE, assertPublishable, blockText, readLegalDocument, readSitePolicyPage } from "@/lib/legal-content";
import { fillTokens, parseLegalMarkdown, splitSitePolicyPages, type LegalBlock } from "@/lib/legal-markdown";
import { PUBLIC_ROUTES } from "@/lib/site";

const read = (file: string) => readFileSync(join(process.cwd(), "content", "legal", file), "utf8");
const DOCS = [
  { kind: "privacy" as const, file: "privacy-policy.md", title: "OTOPAIR PRIVACY POLICY", sections: 15 },
  { kind: "portal-terms" as const, file: "shop-portal-terms.md", title: "OTOPAIR SHOP PORTAL TERMS OF USE", sections: 18 },
];
const KINDS = Object.keys(SITE_POLICY_PAGES) as SitePolicyKind[];
const PRODUCTION = { NODE_ENV: "production" };
const texts = (blocks: LegalBlock[]) => blocks.map((b) => (b.type === "p" || b.type === "note" ? b.text : b.type));

describe("counsel's legal documents", () => {
  for (const d of DOCS) {
    it(`${d.file} parses into its ${d.sections} numbered sections, in order`, () => {
      const doc = parseLegalMarkdown(read(d.file));
      expect(doc.title).toBe(d.title);
      expect(doc.effectiveLine).toMatch(/^Effective Date:/);
      expect(doc.sections.map((s) => Number(s.number))).toEqual(
        Array.from({ length: d.sections }, (_, i) => i + 1)
      );
      for (const s of doc.sections) {
        expect(s.title).not.toContain("**");
        expect(s.blocks.length).toBeGreaterThan(0);
      }
    });

    it(`${d.file} has no bracketed draft placeholders left — only {{TOKENS}}`, () => {
      expect(read(d.file)).not.toMatch(/\[[A-Z][A-Za-z .,@/-]{1,40}\]/);
    });

    it(`every token ${d.file} uses is one lib/legal.ts knows`, () => {
      const tokens = legalTokens(d.kind);
      const used = [...read(d.file).matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]);
      for (const t of used) expect(Object.keys(tokens)).toContain(t);
    });
  }

  it("keeps each list whole, with the section it belongs to", () => {
    const privacy = parseLegalMarkdown(read("privacy-policy.md"));
    const lists = (doc: typeof privacy, n: string) =>
      doc.sections.find((s) => s.number === n)!.blocks.flatMap((b) => (b.type === "ul" ? [b.items] : []));
    // Counsel's items are blank-line separated; they are still one list each.
    expect(lists(privacy, "1").map((l) => l.length)).toEqual([6]);
    expect(lists(privacy, "1")[0][0]).toMatch(/^\*\*Account information:\*\*/);
    expect(lists(privacy, "2").map((l) => l.length)).toEqual([8]);
    expect(privacy.sections.find((s) => s.number === "9")!.title).toBe("Shop Portal Users");
    const terms = parseLegalMarkdown(read("shop-portal-terms.md"));
    expect([lists(terms, "5"), lists(terms, "6"), lists(terms, "8")].map((l) => l.map((x) => x.length))).toEqual([[6], [5], [7]]);
  });

  it("carries v6.1's additions over v5", () => {
    const { doc } = readLegalDocument("privacy");
    const section = (n: string) => doc.sections.find((s) => s.number === n)!;
    expect(texts(section("4").blocks)).toContain(
      "**With other users of your vehicle.** Where more than one Otopair account is associated with the same vehicle, each of those users can see that vehicle’s service history, inspection findings, and health score. Add a vehicle only if you are its owner or are authorized to manage it."
    );
    expect(blockText(section("10").blocks)).toContain("and conversations with Oto are retained for up to 24 months.");
  });

  it("fills in the facts v6.1 and v1.1 state, effective 2026-09-15", () => {
    const privacy = readLegalDocument("privacy").doc;
    expect(privacy.effectiveLine).toBe("Effective Date: September 15, 2026");
    expect(blockText(privacy.intro)).toContain("issued by Otopair Inc., a Delaware corporation (“Otopair,”");
    expect(texts(privacy.sections.at(-1)!.blocks)).toEqual([
      "Otopair Inc.",
      "Attn: Privacy",
      "200 Vesey Street, 24th Floor, New York, NY 10281",
      "Email: support@otopair.com",
    ]);
    expect(blockText(privacy.sections.flatMap((s) => s.blocks))).not.toMatch(/privacy@|legal@/);

    const terms = readLegalDocument("portal-terms").doc;
    expect(terms.effectiveLine).toBe("Effective Date: September 15, 2026");
    expect(texts(terms.sections.at(-1)!.blocks)).toEqual([
      "Otopair Inc.",
      "Attn: Legal",
      "200 Vesey Street, 24th Floor, New York, NY 10281",
      "Email: support@otopair.com",
    ]);
    expect(blockText(terms.sections.find((s) => s.number === "11")!.blocks)).toContain(
      "available at otopair.com/privacy, in the section titled Shop Portal Users"
    );
  });

  it("fills known tokens and marks the ones still pending", () => {
    const facts = { ...LEGAL_FACTS, entityName: "Example Co.", mailingAddress: null };
    const tokens = legalTokens("privacy", facts);
    expect(fillTokens("{{ENTITY_NAME}} — {{MAILING_ADDRESS}}", tokens)).toBe("Example Co. — ⟦MAILING_ADDRESS⟧");
    expect(pendingTokens("{{ENTITY_NAME}} {{MAILING_ADDRESS}} {{SITE_DOMAIN}}", tokens)).toEqual(["MAILING_ADDRESS"]);
  });
});

describe("the production guard", () => {
  it("still blocks /privacy: the privacy-choices and delete-account pages don't exist yet", () => {
    expect(readLegalDocument("privacy").pending).toEqual(["PRIVACY_CHOICES_URL", "DELETE_ACCOUNT_URL"]);
    expect(() => readLegalDocument("privacy", { env: PRODUCTION })).toThrow(/PRIVACY_CHOICES_URL, DELETE_ACCOUNT_URL/);
    expect(() => readLegalDocument("privacy", { env: { VERCEL_ENV: "production" } })).toThrow();
    // Previews and dev render the draft, marked.
    expect(() => readLegalDocument("privacy", { env: { VERCEL_ENV: "preview", NODE_ENV: "production" } })).not.toThrow();
  });

  it("lets /privacy through once both paths are set, reading exactly as counsel wrote it", () => {
    const facts = { ...LEGAL_FACTS, privacyChoicesPath: "/privacy-choices", deleteAccountPath: "/delete-account" };
    const { doc, pending } = readLegalDocument("privacy", { facts, env: PRODUCTION });
    expect(pending).toEqual([]);
    const choices = blockText(doc.sections.find((s) => s.number === "6")!.blocks);
    expect(choices).toContain("through the “Your Privacy Choices” link at otopair.com/privacy-choices. We do not require");
    expect(choices).toContain("at otopair.com/delete-account, or by emailing support@otopair.com. When you delete");
  });

  it("has nothing left to block on /shop-portal-terms or the site policy pages", () => {
    expect(readLegalDocument("portal-terms", { env: PRODUCTION }).pending).toEqual([]);
    for (const kind of KINDS) expect(readSitePolicyPage(kind, { env: PRODUCTION }).pending).toEqual([]);
  });

  it("names the file and the blanks when it refuses", () => {
    expect(() => assertPublishable("content/legal/x.md", ["A_TOKEN"], PRODUCTION)).toThrow(
      "content/legal/x.md still has placeholders (A_TOKEN)."
    );
    expect(() => assertPublishable("content/legal/x.md", [], PRODUCTION)).not.toThrow();
  });

  it("marks a pending link target instead of guessing one", () => {
    const facts = { ...LEGAL_FACTS, dmvRepairShopLookupUrl: null };
    const { doc, pending } = readSitePolicyPage("trust", { facts });
    expect(pending).toEqual(["DMV_REPAIR_SHOP_LOOKUP_URL"]);
    expect(blockText(doc.sections[0].blocks)).toContain("You can check it yourself: [DMV repair shop lookup].");
    expect(() => readSitePolicyPage("trust", { facts, env: PRODUCTION })).toThrow(/DMV_REPAIR_SHOP_LOOKUP_URL/);
  });
});

describe("counsel's site policy pages", () => {
  const split = splitSitePolicyPages(read(SITE_POLICY_FILE));

  it("maps one page to each URL the document names, and the routes exist", () => {
    expect(split.pages.map((p) => p.path)).toEqual(["/cancellation", "/warranties", "/trust", "/accessibility"]);
    expect(KINDS.map((k) => SITE_POLICY_PAGES[k].path)).toEqual(split.pages.map((p) => p.path));
    for (const p of split.pages) {
      expect(existsSync(join(process.cwd(), "app", "(marketing)", p.path.slice(1), "page.tsx"))).toBe(true);
    }
  });

  it("never renders counsel's instructions to us", () => {
    expect(split.preamble).toHaveLength(3);
    expect(split.preamble[1]).toMatch(/^Four pages for otopair\.com\./);
    expect(split.preamble[2]).toMatch(/^Each page is self-contained\./);
    for (const p of split.pages) {
      expect(p.implementationNotes).toHaveLength(1);
      expect(p.source).not.toMatch(/Implementation note|Four pages for otopair|self-contained|otopair\.com\//);
    }
    for (const kind of KINDS) {
      const { doc } = readSitePolicyPage(kind);
      const all = [doc.title, blockText(doc.intro), ...doc.sections.flatMap((s) => [s.title, blockText(s.blocks)])].join("\n");
      expect(all).not.toMatch(/Implementation note|H1\/H2|Dotson|Exhibit B|Uber\/DoorDash/);
    }
  });

  it("has no unwired bracketed placeholders — only [text](href) links", () => {
    expect(read(SITE_POLICY_FILE)).not.toMatch(/\[[^\]]+\](?!\()/);
  });

  it("renders /cancellation's table as counsel laid it out", () => {
    const { doc } = readSitePolicyPage("cancellation");
    expect(doc.title).toBe("Cancellations and No-Shows");
    expect(doc.sections).toEqual([]);
    const table = doc.intro.find((b) => b.type === "table");
    expect(table).toEqual({
      type: "table",
      head: ["", "What happens"],
      rows: [
        ["Cancel more than 24 hours before", "Nothing. The hold is released."],
        ["Cancel inside 24 hours", "Up to $20 from the hold."],
        ["Don’t show up", "Up to $20 from the hold."],
        ["The shop cancels", "Full refund of anything paid. Hold released."],
      ],
    });
    expect(doc.intro.map((b) => b.type)).toEqual(["p", "p", "table", "p", "p", "p", "p", "note"]);
    expect(doc.intro.at(-1)).toEqual({
      type: "note",
      text: "You’ll see these terms before you confirm any booking. This page summarizes Section 6 of the Terms of Use; if anything here differs from the Terms, the Terms govern.",
    });
  });

  it("gives /trust counsel's three H2 sections and wires both bracketed links", () => {
    const { doc } = readSitePolicyPage("trust");
    expect(doc.title).toBe("How we choose shops");
    expect(doc.sections.map((s) => [s.number, s.title, s.id])).toEqual([
      [null, "What we verify", "what-we-verify"],
      [null, "What that means for you", "what-that-means-for-you"],
      [null, "What verification means — and doesn’t", "what-verification-means-and-doesnt"],
    ]);
    expect(texts(doc.sections[0].blocks)[0]).toBe(
      "**Registered.** Every shop’s New York State DMV repair shop registration is checked against the public registry before it’s listed. You can check it yourself: [DMV repair shop lookup](https://dmv.ny.gov/business/find-a-dmv-regulated-business)."
    );
    expect(texts(doc.sections[2].blocks)).toContain(
      "**If something goes wrong,** tell us in the app within 7 days and we’ll help. [Warranties and Service Issues →](/warranties)"
    );
  });

  it("keeps /accessibility at WCAG 2.1 AA, working toward it, never claiming conformance", () => {
    const { doc } = readSitePolicyPage("accessibility");
    const all = [blockText(doc.intro), SITE_POLICY_PAGES.accessibility.description].join("\n");
    expect(all).toContain("Otopair is working toward WCAG 2.1 Level AA across the app and the website.");
    expect(all).toContain("email support@otopair.com.");
    expect(all).not.toMatch(/2\.2|conform/i);
  });

  it("keeps counsel's words-to-avoid off every page, its metadata and its hero line", () => {
    for (const kind of KINDS) {
      const { doc } = readSitePolicyPage(kind);
      const meta = sitePolicyMetadata(kind);
      const all = [doc.title, blockText(doc.intro), ...doc.sections.flatMap((s) => [s.title, blockText(s.blocks)])]
        .concat([String(meta.title), String(meta.description)])
        .join("\n");
      expect(bannedWordsIn(kind, all)).toEqual([]);
    }
    expect(bannedWordsIn("warranties", "Every repair is guaranteed and covered — we make  it right.")).toEqual([
      "guarantee",
      "covered",
      "make it right",
    ]);
    expect(bannedWordsIn("warranties", "What was uncovered at inspection")).toEqual([]);
    expect(bannedWordsIn("trust", "Vetted, background-checked, ASE Certified mechanics")).toEqual([
      "background-checked",
      "certified",
      "vetted",
    ]);
  });

  it("fails loudly on shapes the parser does not know", () => {
    expect(() => parseLegalMarkdown("# T\n\n| a | b |\n| c | d |", { requireSections: false })).toThrow(/Malformed table/);
    expect(() => parseLegalMarkdown("# T\n\n| a | b |\n| --- | --- |\n| c |", { requireSections: false })).toThrow(
      /has 1 cells; its header has 2/
    );
    expect(() => parseLegalMarkdown("# T\n\n### Deeper\n\nText", { requireSections: false })).toThrow(/Unsupported heading/);
    expect(() => parseLegalMarkdown("# T\n\nText\n\n# Another page", { requireSections: false })).toThrow(/Unsupported heading/);
    expect(() => parseLegalMarkdown("# T\n\nText")).toThrow(/no numbered sections/);
    expect(() => splitSitePolicyPages("# A\n\nText")).toThrow(/otopair\.com\/… URL line/);
    expect(() => splitSitePolicyPages("# A\n\notopair.com/a\n\nx\n\n# B\n\notopair.com/a\n\ny")).toThrow(/Two site policy pages claim \/a/);
  });
});

describe("the pages the site policy pages replace", () => {
  const OLD_TO_NEW = {
    "/cancellation-policy": "/cancellation",
    "/warranty": "/warranties",
    "/how-shops-are-verified": "/trust",
  };

  it("redirect permanently (308) to their replacements", async () => {
    const redirects = await nextConfig.redirects!();
    for (const [source, destination] of Object.entries(OLD_TO_NEW)) {
      expect(redirects).toContainEqual({ source, destination, permanent: true });
    }
  });

  it("are gone from the app and the sitemap; the new pages are in it", () => {
    const paths = PUBLIC_ROUTES.map((r) => r.path);
    for (const [source, destination] of Object.entries(OLD_TO_NEW)) {
      expect(existsSync(join(process.cwd(), "app", "(marketing)", source.slice(1)))).toBe(false);
      expect(paths).not.toContain(source);
      expect(paths).toContain(destination);
    }
    expect(paths).toContain("/accessibility");
  });
});
