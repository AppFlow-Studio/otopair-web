import { readFileSync } from "node:fs";
import { join } from "node:path";
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { Prose, Section, type TocItem } from "@/components/flagship/page-shell";
import { legalTokens, pendingTokens, type LegalDocKind } from "@/lib/legal";
import { fillTokens, parseLegalMarkdown, type LegalBlock } from "@/lib/legal-markdown";

const FILES: Record<LegalDocKind, string> = {
  privacy: "privacy-policy.md",
  "portal-terms": "shop-portal-terms.md",
};

/** Site-internal paths the documents mention as "otopair.com/…". */
const SITE_PATH = /\botopair\.com(\/[a-z0-9-]*)?/gi;

/**
 * Load one of counsel's documents, fill its placeholders, and refuse to ship a
 * production deploy that still has any (Vercel previews render them marked).
 */
export function loadLegalDocument(kind: LegalDocKind) {
  const markdown = readFileSync(join(process.cwd(), "content", "legal", FILES[kind]), "utf8");
  const tokens = legalTokens(kind);
  const pending = pendingTokens(markdown, tokens);
  const productionDeploy = process.env.VERCEL_ENV
    ? process.env.VERCEL_ENV === "production"
    : process.env.NODE_ENV === "production";
  if (pending.length && productionDeploy) {
    throw new Error(
      `content/legal/${FILES[kind]} still has placeholders (${pending.join(", ")}). Set them in lib/legal.ts before deploying.`
    );
  }
  const doc = parseLegalMarkdown(fillTokens(markdown, tokens));
  const toc: TocItem[] = doc.sections.map((s) => ({ id: s.id, title: `${s.number}. ${s.title}` }));
  return { doc, toc, pending };
}

/** Bold runs, emails, URLs and otopair.com paths → elements. Pending tokens are marked. */
function inline(text: string, crossLinks: Record<string, string>): ReactNode[] {
  const phrases = Object.keys(crossLinks)
    .sort((a, b) => b.length - a.length)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(
    [
      String.raw`\*\*(.+?)\*\*`,
      String.raw`⟦([A-Z_]+)⟧`,
      // A URL ends before trailing sentence punctuation ("…/privacy." → "…/privacy").
      String.raw`(https?:\/\/[^\s)<>,;]*[^\s)<>,;.])`,
      String.raw`([a-z0-9._-]+@otopair\.com)`,
      SITE_PATH.source,
      ...(phrases.length ? [`(${phrases.join("|")})`] : []),
    ].join("|"),
    "gi"
  );
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(pattern)) {
    const [match, bold, pendingName, url, email, sitePath, phrase] = m;
    if (m.index! > last) out.push(text.slice(last, m.index));
    if (bold) {
      out.push(<strong key={key++}>{inline(bold, {})}</strong>);
    } else if (pendingName) {
      out.push(
        <mark key={key++} className="rounded bg-amber-200/70 px-1 text-[#1a1a1a]">
          [pending: {pendingName.toLowerCase().replace(/_/g, " ")}]
        </mark>
      );
    } else if (url) {
      out.push(
        <a key={key++} href={url} rel="noopener noreferrer" target="_blank">
          {url}
        </a>
      );
    } else if (email) {
      out.push(
        <a key={key++} href={`mailto:${email}`}>
          {email}
        </a>
      );
    } else if (sitePath !== undefined || /^otopair\.com/i.test(match)) {
      out.push(
        <Link key={key++} href={sitePath || "/"}>
          {match}
        </Link>
      );
    } else if (phrase) {
      const href = crossLinks[Object.keys(crossLinks).find((p) => p.toLowerCase() === phrase.toLowerCase())!];
      out.push(
        <Link key={key++} href={href}>
          {phrase}
        </Link>
      );
    }
    last = m.index! + match.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Blocks({ blocks, crossLinks }: { blocks: LegalBlock[]; crossLinks: Record<string, string> }) {
  return (
    <>
      {blocks.map((b, i) =>
        b.type === "p" ? (
          <p key={i}>{inline(b.text, crossLinks)}</p>
        ) : (
          <ul key={i}>
            {b.items.map((item, j) => (
              <li key={j}>{inline(item, crossLinks)}</li>
            ))}
          </ul>
        )
      )}
    </>
  );
}

/** The document body: the preamble, then one titled section per numbered heading. */
export function LegalDocumentBody({
  doc,
  crossLinks = {},
  pending = [],
}: {
  doc: ReturnType<typeof loadLegalDocument>["doc"];
  /** Exact phrases to link, e.g. { "Shop Portal Terms of Use": "/shop-portal-terms" }. */
  crossLinks?: Record<string, string>;
  pending?: string[];
}) {
  return (
    <>
      {pending.length > 0 && (
        <p className="mb-8 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-[14px] text-[#5b4a1a]">
          Draft — {pending.length} placeholder{pending.length === 1 ? "" : "s"} still to be confirmed ({pending
            .map((p) => p.toLowerCase().replace(/_/g, " "))
            .join(", ")}). This page will not deploy to production until they are set in lib/legal.ts.
        </p>
      )}
      <div className="pb-10 tab:pb-14">
        <Prose>
          {doc.effectiveLine && <p>{inline(doc.effectiveLine, {})}</p>}
          <Blocks blocks={doc.intro} crossLinks={crossLinks} />
        </Prose>
      </div>
      {doc.sections.map((s) => (
        <Fragment key={s.id}>
          <Section id={s.id} title={`${s.number}. ${s.title}`}>
            <Blocks blocks={s.blocks} crossLinks={crossLinks} />
          </Section>
        </Fragment>
      ))}
    </>
  );
}
