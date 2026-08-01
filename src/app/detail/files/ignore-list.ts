import type { CompiledRule } from './filter-rules';
import { basename } from './filter-rules';

/**
 * Dynamic filters read out of the tree's own ignore files.
 *
 * The user picks a **basename** — `.gitignore`, `.dockerignore` — and every file in the tree with
 * that name contributes its rules. This is not the daemon's laziness seen twice: the daemon's lazy
 * boundary is what *git* ignores, which is a fact about one tool. Choosing `.dockerignore` asks a
 * different question ("what would not go into an image"), and the answer is a set nothing else on
 * this page knows.
 *
 * Two properties make it behave the way the file it came from does:
 *
 * - **Locality scoping.** A rule in `webui/.gitignore` is about `webui/`, so it is tested against
 *   the path with that prefix removed and never against a sibling. Applying it repository-wide is
 *   the single easiest way to make this feature quietly wrong.
 * - **Shallow to deep.** The layer is built with the root file's rules first and the deepest file's
 *   last, so under last-match-wins a nested `!keep.log` beats the root's `*.log`. That is what the
 *   files themselves do, and anyone who has written one expects it.
 */

/** The ignore files worth offering. Both are near-universal and neither is expensive to read. */
export const IGNORE_BASENAMES: readonly string[] = ['.gitignore', '.dockerignore'];

/** Where one ignore file sits, and what it is therefore about. */
export interface IgnoreSource {
  /** The file to read, workspace-root-relative. */
  readonly path: string;
  /** The directory its rules apply under — `''` for the repository root. */
  readonly scope: string;
}

/**
 * Every file in the tree with this basename, ordered shallow-to-deep.
 *
 * The order is the whole contract of this function: it is what the evaluator's last-match-wins turns
 * into "the nearest file has the last word".
 */
export function ignoreSources(paths: readonly string[], name: string): readonly IgnoreSource[] {
  return paths
    .filter((path) => basename(path) === name)
    .map((path) => ({ path, scope: path.slice(0, Math.max(0, path.length - name.length - 1)) }))
    .sort(
      (left, right) =>
        depthOf(left.path) - depthOf(right.path) || left.path.localeCompare(right.path),
    );
}

/**
 * One ignore file's rules, in file order.
 *
 * Blank lines and `#` comments are dropped. A `!` prefix is a negation and becomes a `show`, which is
 * exactly the resurrection the layered evaluator already knows how to do — so the two systems agree
 * by construction rather than by a special case.
 */
export function parseIgnoreFile(scope: string, text: string): readonly CompiledRule[] {
  const rules: CompiledRule[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const negated = line.startsWith('!');
    const pattern = negated ? line.slice(1) : line;
    const test = patternTest(scope, pattern);
    if (!test) {
      continue;
    }
    rules.push({
      mode: negated ? 'show' : 'hide',
      label: scope === '' ? line : `${scope}/ · ${line}`,
      matches: test,
    });
  }
  return rules;
}

/**
 * The whole layer: every source's rules concatenated in the order {@link ignoreSources} produced.
 *
 * A source whose content has not arrived yet simply contributes nothing. The filter tightens as the
 * reads land rather than blocking on all of them, which matters because the count is the number of
 * ignore files in the repository and nobody should watch a spinner for it.
 */
export function ignoreLayer(
  sources: readonly IgnoreSource[],
  contents: ReadonlyMap<string, string>,
): readonly CompiledRule[] {
  const rules: CompiledRule[] = [];
  for (const source of sources) {
    const text = contents.get(source.path);
    if (text === undefined) {
      continue;
    }
    rules.push(...parseIgnoreFile(source.scope, text));
  }
  return rules;
}

// ---- the mechanics ------------------------------------------------------------------------------

/**
 * Turn one ignore pattern into a test over a workspace-root-relative path.
 *
 * The semantics are the ones the file's own format has, kept because calling something a `.gitignore`
 * rule and then matching it differently is worse than not offering the feature:
 *
 * - a trailing `/` means a directory, so it matches what is **under** it and never the name itself;
 * - a leading `/`, or a `/` anywhere in the body, anchors the pattern at the scope; a pattern with
 *   none matches a segment at any depth beneath it;
 * - `**` crosses `/`, while `*` and `?` stop at one.
 */
function patternTest(scope: string, pattern: string): ((path: string) => boolean) | null {
  const dirOnly = pattern.endsWith('/');
  const body = (dirOnly ? pattern.slice(0, -1) : pattern).replace(/^\//, '');
  if (body === '') {
    return null;
  }
  const anchored = pattern.startsWith('/') || body.includes('/');
  const head = anchored ? '^' : '^(?:[\\s\\S]*/)?';
  const tail = dirOnly ? '/[\\s\\S]+$' : '(?:/[\\s\\S]+)?$';
  const expression = new RegExp(`${head}${globBody(body)}${tail}`);
  const prefix = scope === '' ? '' : `${scope}/`;
  return (path) => {
    if (prefix !== '' && !path.startsWith(prefix)) {
      return false;
    }
    return expression.test(path.slice(prefix.length));
  };
}

/**
 * The pattern body as a regular expression: the wildcards keep their meaning, everything else is a
 * literal.
 *
 * One pass rather than a chain of replacements, because a chain has to park the two-star form under
 * a placeholder while it rewrites the one-star form, and any placeholder is a string some pattern
 * could contain.
 */
function globBody(body: string): string {
  return body.replace(/\*\*\/|\*\*|\*|\?|[.+^${}()|[\]\\]/g, (token) => {
    switch (token) {
      case '**/':
        return '(?:[\\s\\S]*/)?';
      case '**':
        return '[\\s\\S]*';
      case '*':
        return '[^/]*';
      case '?':
        return '[^/]';
      default:
        return `\\${token}`;
    }
  });
}

function depthOf(path: string): number {
  return path.split('/').filter((segment) => segment !== '').length;
}
