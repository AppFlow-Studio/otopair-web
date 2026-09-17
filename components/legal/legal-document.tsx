import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import PageShell, { Prose, Section, type TocItem } from "@/components/flagship/page-shell";
import { SITE_POLICY_PAGES, type LegalDocKind, type SitePolicyKind } from "@/lib/legal";
import { readLegalDocument, readSitePolicyPage } from "@/lib/legal-content";
import type { LegalBlock, LegalDocument } from "@/lib/legal-markdown";

/** Site-internal paths the documents mention as "otopair.com/…". */
const SITE_PATH = /\botopair\.com(\/[a-z0-9-]*)?/gi;

function tocFor(doc: LegalDocument): TocItem[] {
  return doc.sections.map((s) => ({ id: s.id, title: s.number ? `${s.number}. ${s.title}` : s.title }));
}

/**
 * Load one of counsel's documents with its placeholders filled. A production
 * deploy refuses to render one that still has any (lib/legal-content.ts);
 * `next dev` and Vercel previews render them marked.
 */
export function loadLegalDocument(kind: LegalDocKind) {
  const { doc, pending } = readLegalDocument(kind);
  return { doc, toc: tocFor(doc), pending };
}

function PendingMark({ name }: { name: string }) {
  return (
    <mark className="rounded bg-amber-200/70 px-1 text-[#1a1a1a]">
      [pending: {name.toLowerCase().replace(/_/g, " ")}]
    </mark>
  );
}

/** Links, bold runs, emails, URLs and otopair.com paths → elements. Pending tokens are marked. */
function inline(text: string, crossLinks: Record<string, string>): ReactNode[] {
  const phrases = Object.keys(crossLinks)
    .sort((a, b) => b.length - a.length)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(
    [
      // A link counsel bracketed to be wired in: [text](href).
      String.raw`\[([^\]]+)\]\(([^)\s]+)\)`,
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
    const [match, linkText, href, bold, pendingName, url, email, sitePath, phrase] = m;
    if (m.index! > last) out.push(text.slice(last, m.index));
    if (linkText) {
      const target = href.match(/^⟦([A-Z_]+)⟧$/);
      out.push(
        target ? (
          <Fragment key={key++}>
            {linkText} <PendingMark name={target[1]} />
          </Fragment>
        ) : href.startsWith("/") ? (
          <Link key={key++} href={href}>
            {linkText}
          </Link>
        ) : (
          <a key={key++} href={href} rel="noopener noreferrer" target="_blank">
            {linkText}
          </a>
        )
      );
    } else if (bold) {
      out.push(<strong key={key++}>{inline(bold, {})}</strong>);
    } else if (pendingName) {
      out.push(<PendingMark key={key++} name={pendingName} />);
    } else if (url) {
      // A bare URL is one unbreakable word; let it wrap so a phone-width
      // column (375px) doesn't scroll sideways.
      out.push(
        <a key={key++} href={url} rel="noopener noreferrer" target="_blank" className="[overflow-wrap:anywhere]">
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
      const phraseHref = crossLinks[Object.keys(crossLinks).find((p) => p.toLowerCase() === phrase.toLowerCase())!];
      out.push(
        <Link key={key++} href={phraseHref}>
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
  // Prose sets a section's first paragraph as the answer to its heading
  // (larger, darker). A paragraph of counsel's that opens with a bold run-in
  // term is one of a set of equals — Registered. / Insured. / Signed the
  // rules. — so when one comes first the blocks sit a level down, out of that
  // rule's reach. A plain opening paragraph ("Plans change. …") keeps it.
  const runIn = blocks[0]?.type === "p" && blocks[0].text.startsWith("**");
  const Wrap = runIn ? RunInGroup : Fragment;
  return (
    <Wrap>
      {blocks.map((b, i) => {
        switch (b.type) {
          case "p":
            return <p key={i}>{inline(b.text, crossLinks)}</p>;
          case "ul":
            return (
              <ul key={i}>
                {b.items.map((item, j) => (
                  <li key={j}>{inline(item, crossLinks)}</li>
                ))}
              </ul>
            );
          case "note":
            // Italic and set small in counsel's draft: the page's closing
            // pointer to the document that governs it.
            return (
              <p key={i} className="text-[14.5px] italic leading-[1.6] text-[#777169]">
                {inline(b.text, crossLinks)}
              </p>
            );
          case "table":
            // The first column names the situation, so its cells are row
            // headers (bold in the draft); an empty corner cell stays a <td>.
            // Prose styles every <th> as a small caps column label and rules
            // every <td>, so row headers and that corner cell are reset here
            // on more specific selectors.
            return (
              <div key={i} className="my-6 overflow-x-auto">
                <table className="[&_thead_td]:border-0 [&_tbody_th]:border-t [&_tbody_th]:border-[#1a1a1a]/10 [&_tbody_th]:py-3 [&_tbody_th]:pr-4 [&_tbody_th]:align-top [&_tbody_th]:text-[15px] [&_tbody_th]:font-medium [&_tbody_th]:normal-case [&_tbody_th]:tracking-normal [&_tbody_th]:text-[#1a1a1a]">
                  <thead>
                    <tr>
                      {b.head.map((cell, j) =>
                        cell ? (
                          <th key={j} scope="col">
                            {inline(cell, crossLinks)}
                          </th>
                        ) : (
                          <td key={j} />
                        )
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, j) => (
                      <tr key={j}>
                        {row.map((cell, k) =>
                          k === 0 ? (
                            <th key={k} scope="row">
                              {inline(cell, crossLinks)}
                            </th>
                          ) : (
                            <td key={k}>{inline(cell, crossLinks)}</td>
                          )
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </Wrap>
  );
}

function RunInGroup({ children }: { children: ReactNode }) {
  return <div className="[&:not(:first-child)]:mt-5">{children}</div>;
}

/** The document body: the preamble, then one titled section per heading. */
export function LegalDocumentBody({
  doc,
  crossLinks = {},
  pending = [],
}: {
  doc: LegalDocument;
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
      {(doc.effectiveLine || doc.intro.length > 0) && (
        <div className="pb-10 tab:pb-14">
          <Prose>
            {doc.effectiveLine && <p>{inline(doc.effectiveLine, {})}</p>}
            <Blocks blocks={doc.intro} crossLinks={crossLinks} />
          </Prose>
        </div>
      )}
      {doc.sections.map((s) => (
        <Fragment key={s.id}>
          <Section id={s.id} title={s.number ? `${s.number}. ${s.title}` : s.title}>
            <Blocks blocks={s.blocks} crossLinks={crossLinks} />
          </Section>
        </Fragment>
      ))}
    </>
  );
}

/**
 * One of counsel's Site Policy Pages, whole. The H1 and every line of the
 * body are counsel's (content/legal/site-policy-pages.md); the breadcrumb and
 * the hero line are the page's own chrome from lib/legal.ts SITE_POLICY_PAGES.
 * Only the links counsel bracketed are wired, so no cross-links here.
 */
export function SitePolicyDocument({ kind }: { kind: SitePolicyKind }) {
  const { doc, pending } = readSitePolicyPage(kind);
  const page = SITE_POLICY_PAGES[kind];
  const toc = tocFor(doc);
  return (
    <PageShell
      title={doc.title}
      lede={page.description}
      crumbs={[
        { name: "Home", href: "/" },
        { name: page.name, href: page.path },
      ]}
      toc={toc.length ? toc : undefined}
    >
      <LegalDocumentBody doc={doc} pending={pending} />
    </PageShell>
  );
}
