/**
 * Text checks for Oto's chat transcript. Pure (no React, no SDK), so the rules
 * that decide what a visitor reads can be tested against real agent replies.
 */

// Words that carry no claim of their own. Two replies that only share these
// have not said the same thing.
const STOPWORDS = new Set(
  (
    "a an the and or but if so to of in on at for with is are be was it its this that you your we our " +
    "they their them can will not no do does as by from about after again also because been before being " +
    "both could doing done each even every have having here into just like made make many more most much " +
    "must only other over really same should since some such than then there these those through very " +
    "want were what when where which while would i i'm me my you'll you're you'd it's that's there's " +
    "don't doesn't isn't won't can't"
  ).split(" ")
);

function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9$']+/g) ?? []).filter((w) => !STOPWORDS.has(w));
}

/** Share of `part`'s entries that `whole` also has. */
function containment(part: Set<string>, whole: Set<string>): number {
  let shared = 0;
  for (const x of part) if (whole.has(x)) shared++;
  return part.size ? shared / part.size : 0;
}

const words = (t: string[]) => new Set(t.filter((w) => w.length > 3));
const phrases = (t: string[]) => new Set(t.slice(1).map((w, i) => `${t[i]} ${w}`));

/**
 * True when one Oto bubble re-says the other in different words. The live
 * agent sometimes answers, calls a card tool, then answers again: 10 of 141
 * live answers on 2026-09-14, and still 2 of 47 after the prompt said to
 * answer once.
 *
 * Both signals must agree. Most of the shorter bubble's words AND a quarter of
 * its two-word phrases must appear in the longer one. Words alone would merge
 * a "this is a demo" disclaimer into an oil-change answer that shares the
 * topic's words; phrases alone would merge "the $20 hold is released" with
 * "the $20 hold is kept".
 */
export function restates(a: string, b: string): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  const s = tokens(shorter);
  const l = tokens(longer);
  const sWords = words(s);
  const sPhrases = phrases(s);
  if (sWords.size < 5 || sPhrases.size < 4) return false;
  return containment(sWords, words(l)) >= 0.5 && containment(sPhrases, phrases(l)) >= 0.25;
}
