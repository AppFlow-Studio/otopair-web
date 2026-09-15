/**
 * Parser for counsel's legal documents as stored in content/legal/*.md.
 *
 * Deliberately tiny: the documents use a handful of shapes, and a general
 * markdown library would render anything else silently instead of failing
 * loudly when counsel's next draft changes shape.
 *   **OTOPAIR PRIVACY POLICY**            document title (first bold-only line)
 *   Effective Date: {{EFFECTIVE_DATE}}   effective-date line
 *   **4. How We Share Information**      numbered section heading
 *   - item                               list item (blank lines between items keep one list)
 * Counsel's Site Policy Pages (content/legal/site-policy-pages.md) add:
 *   # Cancellations and No-Shows         a page title (H1 in the draft)…
 *   otopair.com/cancellation             …and the page's URL, on the next line
 *   ## What we verify                    unnumbered section heading (H2 in the draft)
 *   |  | What happens |                   table: header row, | --- | rule, body rows
 *   _This page summarizes…_              closing note (italic in the draft)
 *   Implementation note: …               counsel's instruction to us — split out, never rendered
 * Links counsel bracketed to be wired in are written [text](href) and resolved
 * by the renderer. Everything else is a paragraph; blank lines separate blocks.
 */

export type LegalBlock =
  | { type: "p"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "table"; head: string[]; rows: string[][] }
  | { type: "note"; text: string };

export type LegalSection = {
  id: string;
  /** The document's own number ("4" — the text cross-references it), or null for an unnumbered heading. */
  number: string | null;
  title: string;
  blocks: LegalBlock[];
};

export type LegalDocument = {
  title: string;
  effectiveLine: string | null;
  intro: LegalBlock[];
  sections: LegalSection[];
};

const SECTION_HEADING = /^\*\*(\d+)\.\s+(.+?)\*\*$/;
const TITLE_LINE = /^\*\*([^*a-z]+)\*\*$/;
const PAGE_TITLE = /^#\s+(.+)$/;
const SUBHEADING = /^##\s+(.+)$/;
const TABLE_ROW = /^\|.*\|$/;
const TABLE_RULE = /^\|(\s*:?-{3,}:?\s*\|)+$/;
const NOTE = /^_(.+)_$/;
const PAGE_PATH = /^otopair\.com(\/[a-z0-9-]+)$/;
const IMPLEMENTATION_NOTE = /^Implementation note:/i;

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseTable(lines: string[], where: string): LegalBlock {
  const cells = (line: string) => line.slice(1, -1).split("|").map((c) => c.trim());
  if (lines.length < 3 || !TABLE_RULE.test(lines[1])) {
    throw new Error(`Malformed table in "${where}": expected a header row, a | --- | rule, then at least one row.`);
  }
  const head = cells(lines[0]);
  const rows = lines.slice(2).map(cells);
  for (const row of rows) {
    if (row.length !== head.length) {
      throw new Error(`Table row in "${where}" has ${row.length} cells; its header has ${head.length}.`);
    }
  }
  return { type: "table", head, rows };
}

/**
 * `requireSections` (default true) is for counsel's agreements, which are
 * all numbered sections; a site policy page may be a single block of copy.
 */
export function parseLegalMarkdown(markdown: string, { requireSections = true }: { requireSections?: boolean } = {}): LegalDocument {
  const doc: LegalDocument = { title: "", effectiveLine: null, intro: [], sections: [] };
  let blocks = doc.intro;
  let paragraph: string[] = [];
  let list: string[] | null = null;
  let table: string[] | null = null;
  const where = () => doc.title || "legal document";

  const endParagraph = () => {
    if (paragraph.length) blocks.push({ type: "p", text: paragraph.join(" ") });
    paragraph = [];
  };
  const endList = () => {
    if (list) blocks.push({ type: "ul", items: list });
    list = null;
  };
  const endTable = () => {
    if (table) blocks.push(parseTable(table, where()));
    table = null;
  };
  const flush = () => {
    endParagraph();
    endList();
    endTable();
  };
  const startSection = (number: string | null, title: string) => {
    flush();
    const section: LegalSection = { id: slugify(title), number, title, blocks: [] };
    doc.sections.push(section);
    blocks = section.blocks;
  };

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      // Counsel's lists put a blank line between items; the list only ends
      // at the next line that isn't an item.
      endParagraph();
      endTable();
      continue;
    }
    const title = line.match(TITLE_LINE) ?? line.match(PAGE_TITLE);
    if (!doc.title && title) {
      doc.title = title[1].trim();
      continue;
    }
    if (line.startsWith("#")) {
      const sub = line.match(SUBHEADING);
      if (!sub) throw new Error(`Unsupported heading in "${where()}": ${line}`);
      startSection(null, sub[1].trim());
      continue;
    }
    if (doc.effectiveLine == null && /^Effective Date:/i.test(line)) {
      doc.effectiveLine = line;
      continue;
    }
    const heading = line.match(SECTION_HEADING);
    if (heading) {
      startSection(heading[1], heading[2]);
      continue;
    }
    if (TABLE_ROW.test(line)) {
      endParagraph();
      endList();
      table ??= [];
      table.push(line);
      continue;
    }
    if (table) endTable();
    const note = line.match(NOTE);
    if (note) {
      flush();
      blocks.push({ type: "note", text: note[1].trim() });
      continue;
    }
    if (line.startsWith("- ")) {
      endParagraph();
      list ??= [];
      list.push(line.slice(2).trim());
      continue;
    }
    endList();
    paragraph.push(line);
  }
  flush();

  if (!doc.title) throw new Error("Legal document has no title line (**TITLE** or # Title).");
  if (requireSections && !doc.sections.length) {
    throw new Error(`"${doc.title}" has no numbered sections (**1. Heading**).`);
  }
  if (!doc.intro.length && !doc.sections.length) throw new Error(`"${doc.title}" has no content.`);
  return doc;
}

export type SitePolicyChunk = {
  title: string;
  /** Route, from the page's otopair.com/… line. */
  path: string;
  /** The page's own text (title first) — no URL line, no implementation notes. */
  source: string;
  /** Counsel's instructions for this page. Kept for reference; never rendered. */
  implementationNotes: string[];
};

/**
 * Counsel's Site Policy Pages document → one chunk per page. The document's
 * preamble ("Four pages for otopair.com…") and every "Implementation note:"
 * paragraph are instructions to the developer, so they are split out here
 * and never reach a page.
 */
export function splitSitePolicyPages(markdown: string): { preamble: string[]; pages: SitePolicyChunk[] } {
  type Draft = SitePolicyChunk & { parts: string[] };
  const preamble: string[] = [];
  const pages: Draft[] = [];
  let page: Draft | null = null;
  let expectPath = false;

  for (const paragraph of markdown.split(/\r?\n[ \t]*\r?\n/).map((p) => p.trim()).filter(Boolean)) {
    const title = paragraph.match(PAGE_TITLE);
    if (title && !paragraph.includes("\n")) {
      page = { title: title[1].trim(), path: "", source: "", implementationNotes: [], parts: [paragraph] };
      pages.push(page);
      expectPath = true;
      continue;
    }
    if (expectPath) {
      const path = paragraph.match(PAGE_PATH);
      if (!path) throw new Error(`Site policy page "${page!.title}" must be followed by its otopair.com/… URL line.`);
      page!.path = path[1];
      expectPath = false;
      continue;
    }
    if (!page) preamble.push(paragraph);
    else if (IMPLEMENTATION_NOTE.test(paragraph)) page.implementationNotes.push(paragraph);
    else page.parts.push(paragraph);
  }
  if (expectPath) throw new Error(`Site policy page "${page!.title}" has no otopair.com/… URL line.`);

  const paths = pages.map((p) => p.path);
  const repeated = paths.find((p, i) => paths.indexOf(p) !== i);
  if (repeated) throw new Error(`Two site policy pages claim ${repeated}.`);

  return {
    preamble,
    pages: pages.map(({ parts, ...p }) => ({ ...p, source: parts.join("\n\n") })),
  };
}

/** Replace {{TOKENS}} with values; unresolved tokens come back as ⟦TOKEN⟧. */
export function fillTokens(text: string, tokens: Record<string, string | null>): string {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (_, name: string) => tokens[name] ?? `⟦${name}⟧`);
}
