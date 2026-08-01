/**
 * How the tree decides what to show: the matching vocabulary, and the layered last-match-wins
 * evaluator the advanced filter dialog and the dynamic filters both feed.
 *
 * It is arithmetic on purpose. Compaction, expansion and narrowing are the three things a file
 * browser gets subtly wrong, and the only way to know they are right is to test them without a DOM.
 */

/**
 * How a rule decides whether one path matches.
 *
 * The three are the dialog's own vocabulary, and the name box uses the same words: `exact` is the
 * whole subject, `includes` is a substring, and `fuzzy` is a case-insensitive subsequence — so `wdp`
 * finds `workspace-detail-page.ts`.
 */
export type MatchKind = 'exact' | 'fuzzy' | 'includes';

/** What a matching rule does. `show` is the only thing that can resurrect a hidden file. */
export type RuleMode = 'show' | 'hide';

/** One row of the advanced filter dialog. */
export interface FilterRule {
  /** Stable across a reorder, which is what lets `@for` track a row that moved. */
  readonly id: string;
  readonly kind: MatchKind;
  readonly query: string;
  readonly mode: RuleMode;
  /** A disabled rule keeps its place in the order and takes no part in the decision. */
  readonly enabled: boolean;
}

/**
 * A rule reduced to what the evaluator needs.
 *
 * Generated rules — a framework's membership whitelist, an ignore file's patterns, the reachable-test
 * hide — are not editable and have no query of their own, so they exist only in this form. `label` is
 * what the dialog prints when a generated set is expanded read-only.
 */
export interface CompiledRule {
  readonly mode: RuleMode;
  readonly label: string;
  readonly matches: (path: string) => boolean;
}

/**
 * The three layers, and the fixed precedence between them.
 *
 * **framework → ignore-list → manual**, evaluated as one ordered list with **last match wins**,
 * exactly like a `.gitignore`. The order is not a preference and must not become one: a framework
 * restriction sets a *default-hidden* stance and whitelists its members, ignore-list rules subtract
 * from whatever is left, and the manual rules go last **so that a manual `show` can always resurrect
 * a file something else hid.** Reverse any pair and the dialog stops being an override and becomes a
 * suggestion.
 *
 * Within a layer the order is the layer's own: the dialog's rows in the order the user put them, an
 * ignore list's files shallow-to-deep so a nested `.gitignore` wins over the root one.
 */
export interface FilterLayers {
  /**
   * The stance before any rule runs. True exactly when a framework restriction is active — that is
   * what "restrict to this framework" means, and it is why the framework layer is a whitelist of
   * `show` rules rather than a set of hides.
   */
  readonly defaultHidden: boolean;
  readonly framework: readonly CompiledRule[];
  readonly ignoreList: readonly CompiledRule[];
  readonly manual: readonly CompiledRule[];
}

/** Nothing is filtered. */
export const NO_LAYERS: FilterLayers = {
  defaultHidden: false,
  framework: [],
  ignoreList: [],
  manual: [],
};

/** How many rows the dialog's live preview prints before it stops and counts instead. */
export const PREVIEW_LIMIT = 500;

/** The layers as one list, in the fixed precedence. The single place that order is written down. */
export function orderedRules(layers: FilterLayers): readonly CompiledRule[] {
  return [...layers.framework, ...layers.ignoreList, ...layers.manual];
}

/**
 * Whether one path survives the rules.
 *
 * Last match wins: every rule is tried, and the last one that matches decides. An earlier `hide` and
 * a later `show` is a resurrection, which is the whole point of the layer order.
 */
export function isShown(path: string, layers: FilterLayers): boolean {
  let shown = !layers.defaultHidden;
  for (const rule of orderedRules(layers)) {
    if (rule.matches(path)) {
      shown = rule.mode === 'show';
    }
  }
  return shown;
}

/** Whether the layers say anything at all. Nothing narrowing is not the same as nothing matching. */
export function narrows(layers: FilterLayers): boolean {
  return layers.defaultHidden || orderedRules(layers).length > 0;
}

/** What the dialog's live preview shows: the surviving paths, capped, and the honest total. */
export interface FilterPreview {
  readonly paths: readonly string[];
  readonly total: number;
  readonly truncated: boolean;
}

/**
 * The preview, truncated at {@link PREVIEW_LIMIT} with a count.
 *
 * The count is computed over everything and only the *printing* is capped — a preview that stopped
 * counting at 500 would answer "500" to "how many files does this show", which is the one question
 * the preview exists to answer.
 *
 * The name box is included because the preview is meant to be the truth about the tree, and a preview
 * that ignored the filter box sitting directly above the tree would disagree with what the user can
 * see.
 */
export function previewOf(
  paths: readonly string[],
  layers: FilterLayers,
  query = '',
): FilterPreview {
  const kept: string[] = [];
  let total = 0;
  for (const path of paths) {
    if (!isShown(path, layers) || !matchesQuery(path, query)) {
      continue;
    }
    total += 1;
    if (kept.length < PREVIEW_LIMIT) {
      kept.push(path);
    }
  }
  return { paths: kept, total, truncated: total > kept.length };
}

/** Turn one dialog row into an evaluable rule. A disabled or blank row compiles to nothing. */
export function compile(rule: FilterRule): CompiledRule | null {
  const query = rule.query.trim();
  if (!rule.enabled || query === '') {
    return null;
  }
  return {
    mode: rule.mode,
    label: `${rule.mode} · ${rule.kind} · ${query}`,
    matches: (path) => matchesKind(path, query, rule.kind),
  };
}

/** Every enabled, non-blank row, in the user's order. */
export function compileAll(rules: readonly FilterRule[]): readonly CompiledRule[] {
  return rules.map(compile).filter((rule): rule is CompiledRule => rule !== null);
}

/**
 * A framework's rule: a **whitelist over the server-resolved membership set**, never a path prefix.
 *
 * A framework's files are not always all under its root, and a prefix test would sweep in a sibling
 * project nested inside one. The daemon resolved the membership; guessing it again here would be a
 * second, worse answer to a question already answered.
 */
export function frameworkWhitelist(members: ReadonlySet<string>, label: string): CompiledRule {
  return {
    mode: 'show',
    label: `show · framework · ${label}`,
    matches: (path) => members.has(path),
  };
}

/** Hide a fixed set of paths — how the reachable tests leave the tree. */
export function hideSet(paths: ReadonlySet<string>, label: string): CompiledRule {
  return { mode: 'hide', label, matches: (path) => paths.has(path) };
}

// ---- the matching vocabulary --------------------------------------------------------------------

/**
 * Whether one path answers the filter box.
 *
 * Three forms, in the order they are tested:
 *
 * - **A query with a `/` matches the whole path**, not the basename. That is not a nicety: the
 *   viewer's "open the closest match to a possibly-stale path" entry point seeds this box with a
 *   path exactly as if the user had typed it, so the user can see *why* the tree is narrowed.
 * - **A query with `*` or `?` is a glob**, anchored at both ends, because `*.ts` meaning "contains
 *   .ts anywhere" would make the wildcard decorative. `*` crosses `/` here — a filter box is not a
 *   shell, and `src/*.spec.ts` is far more likely to mean "under src" than "directly in src".
 * - **Anything else is fuzzy**: a case-insensitive subsequence, so `wdp` finds
 *   `workspace-detail-page.ts`.
 */
export function matchesQuery(path: string, query: string): boolean {
  const trimmed = query.trim();
  if (trimmed === '') {
    return true;
  }
  const subject = subjectFor(path, trimmed);
  if (trimmed.includes('*') || trimmed.includes('?')) {
    return globOf(trimmed).test(subject);
  }
  return isSubsequence(trimmed.toLowerCase(), subject.toLowerCase());
}

/**
 * Whether one path answers a rule of a given kind.
 *
 * A rule uses the same subject rule as the box — a query with a `/` in it is about the path, and one
 * without is about the filename — so a rule and a typed query with the same text mean the same thing.
 * A dialog whose `includes` disagreed with the box's would be the kind of difference nobody finds.
 */
export function matchesKind(path: string, query: string, kind: MatchKind): boolean {
  const subject = subjectFor(path, query).toLowerCase();
  const needle = query.toLowerCase();
  if (kind === 'exact') {
    return subject === needle;
  }
  if (kind === 'includes') {
    return subject.includes(needle);
  }
  return isSubsequence(needle, subject);
}

/** The last segment of a path. */
export function basename(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? path : path.slice(at + 1);
}

/** A basename with its extension taken off — what a test tab is labelled by. */
export function stem(path: string): string {
  const name = basename(path);
  const dot = name.indexOf('.');
  return dot <= 0 ? name : name.slice(0, dot);
}

function subjectFor(path: string, query: string): string {
  return query.includes('/') ? path : basename(path);
}

function globOf(query: string): RegExp {
  const pattern = query
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/[*?]/g, (token) => (token === '*' ? '[\\s\\S]*' : '[\\s\\S]'));
  return new RegExp(`^${pattern}$`, 'i');
}

export function isSubsequence(needle: string, haystack: string): boolean {
  let at = 0;
  for (const character of haystack) {
    if (character === needle[at]) {
      at += 1;
      if (at === needle.length) {
        return true;
      }
    }
  }
  return at === needle.length;
}
