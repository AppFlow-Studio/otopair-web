/**
 * Parser for counsel's legal documents as stored in content/legal/*.md.
 *
 * Deliberately tiny: the documents use exactly four shapes, and a general
 * markdown library would render anything else silently instead of failing
 * loudly when counsel's next draft changes shape.
 *   **OTOPAIR PRIVACY POLICY**            document title (first bold-only line)
 *   Effective Date: {{EFFECTIVE_DATE}}   effective-date line
 *   **4. How We Share Information**      numbered section heading
 *   - item                               list item
 * Everything else is a paragraph; blank lines separate blocks.
 */

export type LegalBlock = { type: "p"; text: string } | { type: "ul"; items: string[] };

export type LegalSection = {
  id: string;
  number: string;
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

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function parseLegalMarkdown(markdown: string): LegalDocument {
  const doc: LegalDocument = { title: "", effectiveLine: null, intro: [], sections: [] };
  let blocks = doc.intro;
  let paragraph: string[] = [];
  let list: string[] | null = null;

  const flush = () => {
    if (paragraph.length) blocks.push({ type: "p", text: paragraph.join(" ") });
    if (list) blocks.push({ type: "ul", items: list });
    paragraph = [];
    list = null;
  };

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    if (!doc.title && TITLE_LINE.test(line)) {
      doc.title = line.replace(TITLE_LINE, "$1").trim();
      continue;
    }
    if (doc.effectiveLine == null && /^Effective Date:/i.test(line)) {
      doc.effectiveLine = line;
      continue;
    }
    const heading = line.match(SECTION_HEADING);
    if (heading) {
      flush();
      const section: LegalSection = { id: slugify(heading[2]), number: heading[1], title: heading[2], blocks: [] };
      doc.sections.push(section);
      blocks = section.blocks;
      continue;
    }
    if (line.startsWith("- ")) {
      if (paragraph.length) {
        blocks.push({ type: "p", text: paragraph.join(" ") });
        paragraph = [];
      }
      list ??= [];
      list.push(line.slice(2).trim());
      continue;
    }
    if (list) flush();
    paragraph.push(line);
  }
  flush();

  if (!doc.title) throw new Error("Legal document has no title line (**TITLE**).");
  if (!doc.sections.length) throw new Error(`"${doc.title}" has no numbered sections (**1. Heading**).`);
  return doc;
}

/** Replace {{TOKENS}} with values; unresolved tokens come back as ⟦TOKEN⟧. */
export function fillTokens(text: string, tokens: Record<string, string | null>): string {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (_, name: string) => tokens[name] ?? `⟦${name}⟧`);
}
