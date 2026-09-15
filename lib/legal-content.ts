import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LEGAL_FACTS,
  SITE_POLICY_PAGES,
  bannedWordsIn,
  legalTokens,
  pendingTokens,
  type LegalDocKind,
  type LegalFacts,
  type SitePolicyKind,
} from "./legal";
import { fillTokens, parseLegalMarkdown, splitSitePolicyPages, type LegalBlock, type LegalDocument } from "./legal-markdown";

/**
 * Reads counsel's documents from content/legal, fills their placeholders and
 * enforces the publishing rules. Server-only (node:fs) — kept apart from
 * lib/legal.ts so that module stays importable anywhere, and kept free of
 * React so the rules can be tested directly.
 */

export const LEGAL_DOC_FILES: Record<LegalDocKind, string> = {
  privacy: "privacy-policy.md",
  "portal-terms": "shop-portal-terms.md",
};
export const SITE_POLICY_FILE = "site-policy-pages.md";

type Env = Record<string, string | undefined>;

function read(file: string): string {
  return readFileSync(join(process.cwd(), "content", "legal", file), "utf8");
}

/** Vercel production, or a plain `next build`/`next start` outside Vercel. Previews and `next dev` are not. */
export function isProductionDeploy(env: Env = process.env): boolean {
  return env.VERCEL_ENV ? env.VERCEL_ENV === "production" : env.NODE_ENV === "production";
}

/** A production deploy refuses to render a legal page that still has a placeholder in it. */
export function assertPublishable(source: string, pending: string[], env: Env = process.env): void {
  if (pending.length && isProductionDeploy(env)) {
    throw new Error(`${source} still has placeholders (${pending.join(", ")}). Set them in lib/legal.ts before deploying.`);
  }
}

export function readLegalDocument(
  kind: LegalDocKind,
  { facts = LEGAL_FACTS, env = process.env }: { facts?: LegalFacts; env?: Env } = {}
): { doc: LegalDocument; pending: string[] } {
  const markdown = read(LEGAL_DOC_FILES[kind]);
  const tokens = legalTokens(kind, facts);
  const pending = pendingTokens(markdown, tokens);
  assertPublishable(`content/legal/${LEGAL_DOC_FILES[kind]}`, pending, env);
  return { doc: parseLegalMarkdown(fillTokens(markdown, tokens)), pending };
}

/** Every piece of text a reader sees in the body, for content checks. Markdown link targets are left out. */
export function blockText(blocks: LegalBlock[]): string {
  return blocks
    .flatMap((b) => (b.type === "ul" ? b.items : b.type === "table" ? [...b.head, ...b.rows.flat()] : [b.text]))
    .join("\n")
    .replace(/\]\([^)\s]*\)/g, "]");
}

export function readSitePolicyPage(
  kind: SitePolicyKind,
  { facts = LEGAL_FACTS, env = process.env }: { facts?: LegalFacts; env?: Env } = {}
): { doc: LegalDocument; pending: string[] } {
  const { path } = SITE_POLICY_PAGES[kind];
  const page = splitSitePolicyPages(read(SITE_POLICY_FILE)).pages.find((p) => p.path === path);
  if (!page) throw new Error(`content/legal/${SITE_POLICY_FILE} has no page for otopair.com${path}.`);
  const tokens = legalTokens(kind, facts);
  const pending = pendingTokens(page.source, tokens);
  assertPublishable(`content/legal/${SITE_POLICY_FILE} (${path})`, pending, env);
  const doc = parseLegalMarkdown(fillTokens(page.source, tokens), { requireSections: false });

  // Counsel's words-to-avoid are a content error in every environment, not a placeholder.
  const text = [doc.title, SITE_POLICY_PAGES[kind].name, SITE_POLICY_PAGES[kind].description, blockText(doc.intro)]
    .concat(doc.sections.flatMap((s) => [s.title, blockText(s.blocks)]))
    .join("\n");
  const banned = bannedWordsIn(kind, text);
  if (banned.length) {
    throw new Error(`${path} uses ${banned.map((w) => `"${w}"`).join(", ")}, which counsel's implementation note keeps off that page.`);
  }
  return { doc, pending };
}
