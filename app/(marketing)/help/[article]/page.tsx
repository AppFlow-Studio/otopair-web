import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import PageShell, { Prose, Section } from "@/components/flagship/page-shell";
import { Reveal } from "@/components/flagship/landing/reveal";
import { JsonLd } from "@/components/seo/json-ld";
import { HELP_SLUGS, helpBySlug } from "@/lib/help-articles";
import { SUPPORT_EMAIL } from "@/lib/site";

/**
 * /help/<slug> — one static article from lib/help-articles.tsx. Reads like
 * the privacy page (same shell, no numbering, no rail): the summary is the
 * lede, the body is Prose, related questions close it. The page emits a
 * single-question FAQPage node (title → summary) so the answer-first summary
 * is what a search engine quotes; BreadcrumbList comes from the shell's
 * crumbs.
 */
type Params = { article: string };

export function generateStaticParams(): Params[] {
  return HELP_SLUGS.map((article) => ({ article }));
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { article } = await params;
  const a = helpBySlug(article);
  if (!a) return {};
  return {
    title: a.title,
    description: a.summary,
    alternates: { canonical: `/help/${a.slug}` },
  };
}

export default async function HelpArticlePage({ params }: { params: Promise<Params> }) {
  const { article } = await params;
  const a = helpBySlug(article);
  if (!a) notFound();

  const related = a.related.flatMap((slug) => {
    const r = helpBySlug(slug);
    return r ? [r] : [];
  });

  return (
    <PageShell
      title={a.title}
      lede={a.summary}
      updated={a.updated}
      crumbs={[
        { name: "Home", href: "/" },
        { name: "Help", href: "/help" },
        { name: a.title, href: `/help/${a.slug}` },
      ]}
    >
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: [
            {
              "@type": "Question",
              name: a.title,
              acceptedAnswer: { "@type": "Answer", text: a.summary },
            },
          ],
        }}
      />

      {/* The answer itself: one block, one fade. Never per paragraph — the
          reader is here to read, not to watch the page assemble. The
          "Related questions" Section below carries the shell's own Reveal. */}
      <Reveal>
        <article>
          <Prose>{a.body}</Prose>
        </article>
      </Reveal>

      <Section id="related" title="Related questions">
        {related.length > 0 && (
          <ul>
            {related.map((r) => (
              <li key={r.slug}>
                <Link href={`/help/${r.slug}`}>{r.title}</Link>
              </li>
            ))}
          </ul>
        )}
        <p>
          Still stuck? Email{" "}
          <a href={`mailto:${SUPPORT_EMAIL}?subject=Driver%20support`}>{SUPPORT_EMAIL}</a> or see
          the <Link href="/help">help hub</Link> and the <Link href="/contact">contact page</Link>.
        </p>
      </Section>
    </PageShell>
  );
}
