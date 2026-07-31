/**
 * The small conversions the page needs, kept out of the template so they can be asserted directly.
 *
 * Trimmed from qits-spa-ci's `format.ts` to what this screen draws. The timestamp helpers have no
 * caller here: this list is about what is *live*, not about when anything happened, so carrying
 * them across would be duplication that is not even used.
 */

/** What is drawn where there is nothing to draw — one em dash, everywhere. */
export const NONE = '—';

/**
 * The first seven characters of a sha, as git itself abbreviates. Every caller carries the full
 * sha in the element's `title`, because seven characters is a label and the whole thing is the
 * fact — and a release's merge commit is a thing people paste into `git show`.
 */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * `3 ahead · 1 behind`, or `up to date` — how far the branch has drifted from its parent.
 *
 * Null counts are unknown rather than zero (qits-workspaces answers null when it could not compute
 * them), and unknown is drawn as nothing at all: a branch reported as "up to date" because the
 * service could not measure it would be the list's one outright lie.
 */
export function driftLabel(ahead: number | null, behind: number | null): string {
  if (ahead === null || behind === null) {
    return '';
  }
  if (ahead === 0 && behind === 0) {
    return 'up to date';
  }
  const parts: string[] = [];
  if (ahead > 0) {
    parts.push(`${ahead} ahead`);
  }
  if (behind > 0) {
    parts.push(`${behind} behind`);
  }
  return parts.join(' · ');
}
