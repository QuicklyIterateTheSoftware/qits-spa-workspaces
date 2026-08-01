import type { DetectionDto, FileListingDto } from '../../api/files-api';

/**
 * What a node is.
 *
 * `lazy` is a directory the daemon stubbed instead of walking, and it carries meaning beyond
 * cheapness: the daemon's lazy boundary is exactly the gitignored one, and content only ever enters
 * the tree through such a directory. So **"at or under a lazy node" is an exact test for "git ignores
 * this"** — the dimming needs no ignore-file parsing, and the tree gets it for free.
 */
export type NodeKind = 'file' | 'dir' | 'lazy';

/** One node of the working tree, as this app models it. */
export interface TreeNode {
  readonly kind: NodeKind;
  /** Workspace-root-relative. The empty string is the tree root, which is never rendered. */
  readonly path: string;
  /** The last segment, which is what a row shows. */
  readonly name: string;
  readonly children: readonly TreeNode[];
  /** The daemon's immediate-child count. Meaningful on `lazy` nodes and zero everywhere else. */
  readonly childCount: number;
}

/** A root with nothing in it — what the tree is before the first answer arrives. */
export const EMPTY_NODE: TreeNode = {
  kind: 'dir',
  path: '',
  name: '',
  children: [],
  childCount: 0,
};

/**
 * Why the tree is narrowed. This type exists to carry **one decision**, and it is the decision the
 * plan warns is easy to flatten by accident:
 *
 * - A **name search** or a **manual rule** is a *search*. Deep matches must be visible, so the tree
 *   opens **fully** — otherwise the answer to "where is that file" is a closed folder.
 * - A **framework toggle** is *browsing*. It narrows to that framework's files and opens to a
 *   framework-sensible depth; opening everything would be jarring, and nobody toggled "Angular"
 *   to be shown four hundred rows.
 *
 * `manual-rule` has no producer in this workstream — the advanced filter dialog lands with the
 * viewer — and it is declared here anyway, because the rule is *"a search opens fully"* rather than
 * *"the name box opens fully"*, and a later workstream adding rules should find the policy already
 * written rather than have to notice it.
 */
export type NarrowingKind = 'name-search' | 'manual-rule' | 'framework';

/**
 * Whether the active narrowing opens the whole tree.
 *
 * True when *any* of the reasons is a search: a framework toggle that composes with a name search is
 * still a search, and hiding a typed-for match because a framework is also selected would read as a
 * bug.
 */
export function expandsFully(kinds: readonly NarrowingKind[]): boolean {
  return kinds.some((kind) => kind === 'name-search' || kind === 'manual-rule');
}

/**
 * How far a framework toggle descends before it stops. Six is well past the deepest real answer
 * (`src/main/java` is three) and exists only so a pathological tree cannot make the walk long.
 */
export const MAX_FRAMEWORK_DEPTH = 6;

/** How the tree is currently being looked at. Everything the flattener needs and nothing else. */
export interface TreeView {
  /** Directory paths the user has opened, plus whatever a framework toggle seeded. */
  readonly expanded: ReadonlySet<string>;
  /** A search is on, so every eager directory is open regardless of {@link expanded}. */
  readonly fullyExpanded: boolean;
  /** The file paths that survive the active narrowing, or null when nothing narrows. */
  readonly visible: ReadonlySet<string> | null;
  /** Lazy directories whose listing has been fetched. Only these can actually open. */
  readonly opened: ReadonlySet<string>;
}

/** The view of an untouched tree. */
export const OPEN_NOTHING: TreeView = {
  expanded: new Set(),
  fullyExpanded: false,
  visible: null,
  opened: new Set(),
};

/** One rendered line of the tree. Compaction means a row is not always one node. */
export interface TreeRow {
  /** The node the row acts on: for a compacted chain, the deepest directory in it. */
  readonly node: TreeNode;
  /**
   * The folded ancestors' names, outermost first — `['src', 'main']` for a row reading
   * `src / main / java`. Rendered dimmed and smaller so the final segment stands out.
   */
  readonly prefix: readonly string[];
  /**
   * Every directory path this one row stands for, deepest last.
   *
   * Toggling a compacted row writes **all** of them, which is what makes the spec's follow-up work:
   * when a later filter change splits the chain, the newly separate ancestors are already open,
   * because the user was standing inside them.
   */
  readonly chain: readonly string[];
  /** Indent level. A whole chain counts as one. */
  readonly depth: number;
  /** At or under a lazy directory, so git ignores it and the row draws dimmed. */
  readonly ignored: boolean;
  /** Whether this row's children are showing. */
  readonly open: boolean;
}

/**
 * Build the tree from the root listing and whatever lazy directories have been opened.
 *
 * The two inputs have different shapes and that is the whole trick: the root answer is the *entire*
 * eager tree as deep slash-separated paths, so the directories in it are implied and have to be
 * created on the way down; an opened directory's answer is one level, with every subdirectory coming
 * back as another lazy stub.
 *
 * Opened directories are applied shallowest-first so a nested one always finds its parent already
 * built. A listing for a path that no longer exists is dropped rather than resurrecting a node — the
 * tree moved under a cache entry, and the cache is the thing that is wrong.
 */
export function buildTree(
  root: FileListingDto,
  opened: ReadonlyMap<string, FileListingDto> = new Map(),
): TreeNode {
  const draft = newDraft('dir', '', '');
  for (const path of root.paths) {
    addFile(draft, path);
  }
  for (const dir of root.lazyDirs) {
    addLazy(draft, dir.path, dir.childCount);
  }
  const byDepth = [...opened.entries()].sort(
    ([left], [right]) => depthOf(left) - depthOf(right) || left.localeCompare(right),
  );
  for (const [path, listing] of byDepth) {
    const node = findDraft(draft, path);
    if (!node) {
      continue;
    }
    for (const file of listing.paths) {
      addFile(draft, file);
    }
    for (const dir of listing.lazyDirs) {
      addLazy(draft, dir.path, dir.childCount);
    }
  }
  return freeze(draft);
}

/**
 * The rows to render, in order.
 *
 * Three things happen here at once, because they are not separable: a node is dropped when the
 * narrowing hides everything under it, a single-child directory chain folds into one row, and a
 * folded row is only descended into when it is open.
 *
 * **Lazy directories are compaction boundaries.** One never folds into a chain, in either direction.
 * Folding it would hide the fact that a fetch happens on expand, and would put a child count in the
 * middle of a breadcrumb where it means nothing.
 *
 * **A search does not open lazy directories.** `fullyExpanded` opens every eager directory and no
 * stub, deliberately: opening them would fire one request per ignored directory in the repository on
 * every keystroke. What honesty costs instead is one footer line — see {@link unsearchedLazyDirs}.
 */
export function flatten(root: TreeNode, view: TreeView): readonly TreeRow[] {
  const shown = new Map<TreeNode, boolean>();
  const isShown = (node: TreeNode): boolean => {
    const known = shown.get(node);
    if (known !== undefined) {
      return known;
    }
    let answer: boolean;
    if (node.kind === 'file') {
      answer = view.visible === null || view.visible.has(node.path);
    } else if (node.kind === 'lazy') {
      // Kept while filtering rather than hidden: its contents are unknown, so hiding it would be a
      // claim nobody checked — and the footer's "open to include" needs something to open.
      answer = view.opened.has(node.path) ? node.children.some(isShown) : true;
    } else {
      answer = node.children.some(isShown);
    }
    shown.set(node, answer);
    return answer;
  };

  const rows: TreeRow[] = [];
  const walk = (parent: TreeNode, depth: number, ignored: boolean): void => {
    for (const child of parent.children) {
      if (!isShown(child)) {
        continue;
      }
      if (child.kind === 'file') {
        rows.push({ node: child, prefix: [], chain: [], depth, ignored, open: false });
        continue;
      }
      if (child.kind === 'lazy') {
        const open = view.expanded.has(child.path) && view.opened.has(child.path);
        // The stub itself is ignored, not only what is under it — being lazy *is* the ignored flag.
        rows.push({ node: child, prefix: [], chain: [child.path], depth, ignored: true, open });
        if (open) {
          walk(child, depth + 1, true);
        }
        continue;
      }
      const chain = foldChain(child, isShown);
      const tail = chain[chain.length - 1];
      const open = view.fullyExpanded || view.expanded.has(tail.path);
      rows.push({
        node: tail,
        prefix: chain.slice(0, -1).map((node) => node.name),
        chain: chain.map((node) => node.path),
        depth,
        ignored,
        open,
      });
      if (open) {
        walk(tail, depth + 1, ignored);
      }
    }
  };
  walk(root, 0, false);
  return rows;
}

/**
 * How many known lazy directories have not been opened, and therefore were not searched.
 *
 * This is the number behind *"N collapsed directories not searched — open to include."* Without that
 * line, "No files match." silently lies about every ignored directory in the repository, and a user
 * looking for a file in `dist/` concludes it is gone.
 *
 * It counts every stub the tree knows about, whatever its ancestors' expansion state — a collapsed
 * parent whose listing is cached still tells us the stub is there — and stops at one that is closed,
 * because a closed stub's contents are not known to include anything at all.
 */
export function unsearchedLazyDirs(root: TreeNode, opened: ReadonlySet<string>): number {
  let count = 0;
  const walk = (node: TreeNode): void => {
    for (const child of node.children) {
      if (child.kind === 'file') {
        continue;
      }
      if (child.kind === 'lazy' && !opened.has(child.path)) {
        count += 1;
        continue;
      }
      walk(child);
    }
  };
  walk(root);
  return count;
}

/** Every file path in the tree, eager and fetched alike. The input to the narrowing. */
export function filePaths(root: TreeNode): readonly string[] {
  const paths: string[] = [];
  const walk = (node: TreeNode): void => {
    for (const child of node.children) {
      if (child.kind === 'file') {
        paths.push(child.path);
      } else {
        walk(child);
      }
    }
  };
  walk(root);
  return paths;
}

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
  const subject = trimmed.includes('/') ? path : basename(path);
  if (trimmed.includes('*') || trimmed.includes('?')) {
    return globOf(trimmed).test(subject);
  }
  return isSubsequence(trimmed.toLowerCase(), subject.toLowerCase());
}

/**
 * The file paths that survive the narrowing, or null when nothing narrows.
 *
 * Null is not the empty set and the difference is the whole point: "nothing is filtered" renders the
 * tree, and "nothing matched" renders *"No files match."*.
 *
 * A framework restriction is a **whitelist over a server-resolved membership set**, not a path
 * prefix — a framework's files are not always all under its root, and guessing from the root would
 * quietly include a sibling project nested inside it.
 */
export function visiblePaths(
  paths: readonly string[],
  query: string,
  frameworkMembers: ReadonlySet<string> | null,
): ReadonlySet<string> | null {
  const searching = query.trim() !== '';
  if (!searching && frameworkMembers === null) {
    return null;
  }
  const visible = new Set<string>();
  for (const path of paths) {
    if (frameworkMembers !== null && !frameworkMembers.has(path)) {
      continue;
    }
    if (searching && !matchesQuery(path, query)) {
      continue;
    }
    visible.add(path);
  }
  return visible;
}

/**
 * The directories a framework toggle opens: its root, its ancestors, and the unambiguous run of
 * directories beneath it.
 *
 * This is the *browsing* half of the expansion distinction, and the rule is deliberately modest:
 * descend while exactly one subdirectory holds any of the framework's files, and stop the moment
 * there is a choice to make. On an Angular root that lands on `src/app`; on a Maven root it lands on
 * `src` and stops where `main` and `test` fork, which is the point at which the user has a decision
 * and the tree should let them make it.
 *
 * Deriving it from membership rather than from a per-framework table is what keeps a framework the
 * daemon learns about tomorrow working without a change here.
 */
export function frameworkSeed(
  root: TreeNode,
  frameworkRoot: string,
  members: ReadonlySet<string>,
): readonly string[] {
  const seed: string[] = [];
  let node: TreeNode | null = root;
  if (frameworkRoot !== '') {
    for (const path of ancestorPaths(frameworkRoot)) {
      const next: TreeNode | undefined = node?.children.find((child) => child.path === path);
      if (!next || next.kind === 'file') {
        return seed;
      }
      seed.push(path);
      node = next;
    }
  }
  for (let step = 0; step < MAX_FRAMEWORK_DEPTH && node; step += 1) {
    const holders: readonly TreeNode[] = node.children.filter(
      (child) => child.kind === 'dir' && hasMember(child, members),
    );
    if (holders.length !== 1) {
      break;
    }
    seed.push(holders[0].path);
    node = holders[0];
  }
  return seed;
}

/**
 * The detection to draw, given the tree on screen.
 *
 * **A detection is applied only while its token matches the tree's**, and on a mismatch the last
 * consistent one is held rather than blanked. The two are independently-fetched views over one
 * mutable tree, so a skew is normal and momentary; blanking would flicker the framework footer on
 * every file an agent writes, and the next tick resolves it anyway. The tokens agree on first load,
 * so there is no initial flash.
 */
export function applyDetection(
  held: DetectionDto | null,
  incoming: DetectionDto | null,
  treeGeneration: string,
): DetectionDto | null {
  if (incoming && incoming.generation === treeGeneration) {
    return incoming;
  }
  return held;
}

// ---- the mechanics ------------------------------------------------------------------------------

interface Draft {
  kind: NodeKind;
  path: string;
  name: string;
  children: Map<string, Draft>;
  childCount: number;
}

function newDraft(kind: NodeKind, path: string, name: string): Draft {
  return { kind, path, name, children: new Map(), childCount: 0 };
}

function addFile(root: Draft, path: string): void {
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) {
    return;
  }
  let node = root;
  for (let at = 0; at < segments.length - 1; at += 1) {
    node = childDraft(node, segments[at]);
  }
  const name = segments[segments.length - 1];
  const existing = node.children.get(name);
  if (existing) {
    // A directory already stands here (the eager listing implied it). A file cannot replace it.
    return;
  }
  node.children.set(name, newDraft('file', joinPath(node.path, name), name));
}

function addLazy(root: Draft, path: string, childCount: number): void {
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) {
    return;
  }
  let node = root;
  for (let at = 0; at < segments.length - 1; at += 1) {
    node = childDraft(node, segments[at]);
  }
  const name = segments[segments.length - 1];
  const existing = node.children.get(name) ?? childDraft(node, name);
  existing.kind = 'lazy';
  existing.childCount = childCount;
}

function childDraft(parent: Draft, name: string): Draft {
  const existing = parent.children.get(name);
  if (existing) {
    return existing;
  }
  const made = newDraft('dir', joinPath(parent.path, name), name);
  parent.children.set(name, made);
  return made;
}

function findDraft(root: Draft, path: string): Draft | null {
  let node: Draft | undefined = root;
  for (const segment of path.split('/').filter((part) => part !== '')) {
    node = node?.children.get(segment);
    if (!node) {
      return null;
    }
  }
  return node ?? null;
}

/** Directories before files, then by name — the order every file browser has, so nobody has to learn it. */
function freeze(draft: Draft): TreeNode {
  const children = [...draft.children.values()]
    .map(freeze)
    .sort(
      (left, right) => rankOf(left) - rankOf(right) || left.name.localeCompare(right.name, 'en'),
    );
  return {
    kind: draft.kind,
    path: draft.path,
    name: draft.name,
    children,
    childCount: draft.childCount,
  };
}

function rankOf(node: TreeNode): number {
  return node.kind === 'file' ? 1 : 0;
}

/**
 * Fold a run of single-child directories into one row.
 *
 * The run is computed over the *visible* children, so a filter that leaves one child in a directory
 * folds it and a filter that leaves two splits it apart again — which is the behaviour the spec
 * describes, seen from the other side.
 */
function foldChain(head: TreeNode, isShown: (node: TreeNode) => boolean): readonly TreeNode[] {
  const chain: TreeNode[] = [head];
  let node = head;
  for (;;) {
    const shownChildren = node.children.filter(isShown);
    const only = shownChildren.length === 1 ? shownChildren[0] : null;
    if (!only || only.kind !== 'dir') {
      return chain;
    }
    chain.push(only);
    node = only;
  }
}

function hasMember(node: TreeNode, members: ReadonlySet<string>): boolean {
  if (node.kind === 'file') {
    return members.has(node.path);
  }
  return node.children.some((child) => hasMember(child, members));
}

function ancestorPaths(path: string): readonly string[] {
  const segments = path.split('/').filter((segment) => segment !== '');
  return segments.map((_, at) => segments.slice(0, at + 1).join('/'));
}

function joinPath(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`;
}

function depthOf(path: string): number {
  return path.split('/').filter((segment) => segment !== '').length;
}

function basename(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? path : path.slice(at + 1);
}

function globOf(query: string): RegExp {
  const pattern = query
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/[*?]/g, (token) => (token === '*' ? '[\\s\\S]*' : '[\\s\\S]'));
  return new RegExp(`^${pattern}$`, 'i');
}

function isSubsequence(needle: string, haystack: string): boolean {
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
