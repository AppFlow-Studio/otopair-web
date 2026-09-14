// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LEGAL_FACTS, legalTokens, pendingTokens } from "@/lib/legal";
import { fillTokens, parseLegalMarkdown } from "@/lib/legal-markdown";

const read = (file: string) => readFileSync(join(process.cwd(), "content", "legal", file), "utf8");
const DOCS = [
  { kind: "privacy" as const, file: "privacy-policy.md", title: "OTOPAIR PRIVACY POLICY", sections: 15 },
  { kind: "portal-terms" as const, file: "shop-portal-terms.md", title: "OTOPAIR SHOP PORTAL TERMS OF USE", sections: 18 },
];

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

  it("keeps a list with the section it belongs to", () => {
    const doc = parseLegalMarkdown(read("privacy-policy.md"));
    const collect = doc.sections.find((s) => s.number === "1")!;
    const list = collect.blocks.find((b) => b.type === "ul");
    expect(list && list.type === "ul" && list.items[0]).toMatch(/^\*\*Account information:\*\*/);
    expect(doc.sections.find((s) => s.number === "9")!.title).toBe("Shop Portal Users");
  });

  it("fills known tokens and marks the ones still pending", () => {
    const facts = { ...LEGAL_FACTS, entityName: "Example Co.", privacyEmail: null };
    const tokens = legalTokens("privacy", facts);
    expect(fillTokens("{{ENTITY_NAME}} — {{PRIVACY_EMAIL}}", tokens)).toBe("Example Co. — ⟦PRIVACY_EMAIL⟧");
    expect(pendingTokens("{{ENTITY_NAME}} {{PRIVACY_EMAIL}} {{SITE_DOMAIN}}", tokens)).toEqual(["PRIVACY_EMAIL"]);
  });
});
