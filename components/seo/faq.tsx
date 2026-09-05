import { JsonLd } from "./json-ld";
import { Section } from "@/components/flagship/page-shell";

export type FaqItem = { q: string; a: string };

/**
 * FAQ block that ships FAQPage structured data alongside the visible Q&A
 * (site audit 2026-08-31 §5.4 — the Oto prompt chips were "FAQ content
 * sitting in a UI component with no schema and no visible answers"). Each
 * answer is plain text (no JSX) so the same string feeds both the DOM and
 * the JSON-LD, and they can never drift. Renders as the shell's numbered
 * Section so it matches the rest of the long-form pages.
 *
 * Laid out as an editorial two-column list from `tab`: the question in the
 * text serif on the left two fifths, the answer on the right, one hairline
 * between items and none at the ends. Stacks on phones. Stays a `<dl>` so
 * the visible pairs and the schema describe the same thing.
 */
export function FaqSection({
  title = "Questions people ask",
  items,
  id = "faq",
}: {
  title?: string;
  items: FaqItem[];
  id?: string;
}) {
  return (
    <>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: items.map((it) => ({
            "@type": "Question",
            name: it.q,
            acceptedAnswer: { "@type": "Answer", text: it.a },
          })),
        }}
      />
      <Section id={id} title={title}>
        <FaqList items={items} />
      </Section>
    </>
  );
}

/** The list on its own, for pages that place it outside a Section. */
export function FaqList({ items, className = "" }: { items: FaqItem[]; className?: string }) {
  return (
    <dl className={`flex flex-col divide-y divide-[#1a1a1a]/10 ${className}`}>
      {items.map((it) => (
        <div
          key={it.q}
          className="grid gap-2 py-5 first:pt-0 last:pb-0 tab:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] tab:gap-x-10 tab:py-6"
        >
          <dt className="serif-text text-[19px] leading-[1.3] text-[#1a1a1a] [text-wrap:balance]">{it.q}</dt>
          <dd className="text-[16px] leading-[1.6] text-[#4c5661]">{it.a}</dd>
        </div>
      ))}
    </dl>
  );
}
