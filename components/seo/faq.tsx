import { JsonLd } from "./json-ld";
import { Section } from "@/components/flagship/page-shell";
import { Sequence, Seq } from "@/components/flagship/landing/reveal";

export type FaqItem = { q: string; a: string };

/** One Q&A row. Written once so the cascading and the still shapes below
 *  cannot drift apart; the classes live here as a literal so Tailwind still
 *  sees them. */
const ROW =
  "grid gap-2 py-5 first:pt-0 last:pb-0 tab:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] tab:gap-x-10 tab:py-6";

function Pair({ item }: { item: FaqItem }) {
  return (
    <>
      <dt className="serif-text text-[19px] leading-[1.3] text-[#1a1a1a] [text-wrap:balance]">{item.q}</dt>
      <dd className="text-[16px] leading-[1.6] text-[#4c5661]">{item.a}</dd>
    </>
  );
}

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
 *
 * `cascade={false}`: the shell's `Section` already wraps everything it holds
 * in a `Reveal`, so the pairs must not carry a second entrance of their own —
 * that would be a reveal inside a reveal, with the two opacity ramps
 * multiplied and the two rises stacked. It is also the wrong read for the
 * pages that use this shape: every one of them is a long-form policy or
 * guide page, and docs/design/motion.md is explicit that a `<dl>` of
 * definitions on a page like that fades up whole rather than term by term.
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
        <FaqList items={items} cascade={false} />
      </Section>
    </>
  );
}

/**
 * The list on its own, for pages that place it outside a Section.
 *
 * The pairs are peers, so by default they cascade (docs/design/motion.md):
 * one Sequence observer at the group root and each row `Seq`'d 60ms behind
 * the one above, capped at nine steps — the same step and cap the house
 * `Stagger` uses — so a long FAQ still finishes in about half a second.
 * `Stagger` itself is not usable here because its container is a hardcoded
 * `<div>` and this list has to stay a `<dl>`.
 *
 * Two constraints shape how that is wired. The row element stays the direct
 * `<div>` child of the `<dl>` — `Seq` renders a `motion.div`, so it *becomes*
 * that div rather than nesting inside one; `divide-y`, `first:pt-0`,
 * `last:pb-0` and callers' own `[&>div:first-child]` overrides all keep
 * matching. And the rise is 14px rather than the house 18 because these rows
 * sit tight against each other under a hairline apiece, where a long throw
 * makes the rules visibly slide.
 *
 * `cascade={false}` renders the same list with no motion at all, for a caller
 * that already owns the entrance — `FaqSection` above, whose `Section` is a
 * `Reveal`. A page that renders `FaqList` directly should leave it unwrapped
 * and let it run its own cascade rather than putting a `Reveal` around it.
 */
export function FaqList({
  items,
  className = "",
  cascade = true,
}: {
  items: FaqItem[];
  className?: string;
  cascade?: boolean;
}) {
  const list = (
    <dl className={`flex flex-col divide-y divide-[#1a1a1a]/10 ${className}`}>
      {items.map((it, i) =>
        cascade ? (
          <Seq key={it.q} at={Math.min(i, 8) * 0.06} y={14} className={ROW}>
            <Pair item={it} />
          </Seq>
        ) : (
          <div key={it.q} className={ROW}>
            <Pair item={it} />
          </div>
        ),
      )}
    </dl>
  );
  return cascade ? <Sequence delay={0.05}>{list}</Sequence> : list;
}
