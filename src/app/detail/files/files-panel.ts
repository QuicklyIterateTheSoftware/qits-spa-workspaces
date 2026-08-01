import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import type { DetectionDto, FileListingDto } from '../../api/files-api';
import { FilesApi } from '../../api/files-api';
import { WorkspaceEvents } from '../../api/workspace-events';
import { Async } from '../../ui/async';
import { Empty } from '../../ui/empty';
import { IDLE, LOADING, failed, ready, type Loadable } from '../../ui/loadable';
import { FileTree } from './file-tree';
import {
  EMPTY_NODE,
  applyDetection,
  buildTree,
  expandsFully,
  filePaths,
  flatten,
  frameworkSeed,
  unsearchedLazyDirs,
  visiblePaths,
  type NarrowingKind,
  type TreeRow,
} from './tree-model';

/** One button in the framework footer: a framework *kind*, however many roots declare it. */
export interface FrameworkToggle {
  readonly frameworkId: string;
  readonly label: string;
}

/**
 * The working-tree browser's left pane: the tree, its filter, and the two footers.
 *
 * ## What it loads
 *
 * **On first open this panel reads `2 + D`**, where `D` is the number of lazy directories the user
 * opens:
 *
 * 1. `GET /files` — the *whole* eager tree in one answer, at full depth, plus every wholly-ignored
 *    directory as a stub. The tree is not fetched a level at a time; only the ignored parts are.
 * 2. `GET /detection` — the frameworks the footer toggles and the token that gates them.
 * 3. `GET /files?path=…` — once per lazy directory opened, cached per directory, so re-expanding one
 *    is free for the rest of the generation.
 *
 * The two constants go out together rather than in sequence: they are independent reads of one tree,
 * and the generation token exists precisely so they do not have to be ordered.
 *
 * **It does not poll and it does not refetch while hidden.** A `files` hint arriving on another tab
 * is recorded and spent as one catch-up read when this tab is next shown — the panel stays mounted
 * (its open file and scroll position are the reason keep-mounted exists), so refetching in the
 * background would pay for a tree nobody is looking at.
 *
 * ## The two expansions, which are not the same expansion
 *
 * This is the decision most easily flattened by accident, so it is stated twice — here and in
 * `tree-model.ts`:
 *
 * - **A name search opens the tree fully.** It is a search; a match four directories down is the
 *   answer, and leaving it behind a closed folder makes the box useless.
 * - **A framework toggle opens to a framework-sensible depth.** It is browsing; it seeds the
 *   expansion at the framework's root and follows the unambiguous run beneath it, then stops. Opening
 *   everything would be jarring and is not what "show me the Angular app" asks for.
 *
 * The difference is mechanical, not only visual: the search's expansion is an **override that ends
 * with the search**, and the framework's is a **seed written into the expansion set**, which survives
 * the toggle being turned off — because by then the user has been browsing there.
 *
 * A consequence worth naming: while a search is on, a directory row cannot be collapsed. The
 * alternative is a second set recording collapses that only exist during a search, to serve a gesture
 * that contradicts what the search was asked to do.
 *
 * ## Out of scope here, on purpose
 *
 * The viewer, the advanced filter dialog, the dynamic filters and line picking all land with the
 * viewer workstream. This panel selects a file and says so; it does not draw a right-hand pane, and
 * an empty half-built one would be worse than none.
 */
@Component({
  selector: 'app-files-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Async, Empty, FileTree],
  templateUrl: './files-panel.html',
  styleUrl: './files-panel.css',
})
export class FilesPanel {
  private readonly filesApi = inject(FilesApi);
  private readonly events = inject(WorkspaceEvents);

  /** Which workspace's container to read. The row id, which is what the proxy addresses. */
  readonly workspaceRowId = input.required<number>();

  /**
   * Whether this tab is the one showing.
   *
   * The panel is mounted whether or not it is — that is the tab contract — so this is what stops it
   * refetching behind another tab. It is an input rather than something read from a host, because
   * the policy differs per panel: Chat, Web view and Agents keep working while hidden and this one
   * must not.
   */
  readonly visible = input(false);

  /** A file was chosen. The viewer reads this when it lands; for now the tree draws the highlight. */
  readonly selectedPath = signal<string | null>(null);

  protected readonly listing = signal<Loadable<FileListingDto>>(IDLE);

  /** One entry per opened lazy directory. Cleared only when the tree's generation moves. */
  private readonly opened = signal<ReadonlyMap<string, FileListingDto>>(new Map());

  protected readonly pending = signal<ReadonlySet<string>>(new Set<string>());

  /** The newest detection answer, whatever tree it describes. */
  private readonly incoming = signal<DetectionDto | null>(null);

  /** The newest detection that matched the tree on screen. Held across a mismatch, never blanked. */
  private readonly held = signal<DetectionDto | null>(null);

  /** The filter box. */
  readonly query = signal('');

  /** Which framework *kinds* are toggled on. Several compose as a union. */
  readonly activeFrameworks = signal<ReadonlySet<string>>(new Set<string>());

  private readonly expanded = signal<ReadonlySet<string>>(new Set<string>());

  private readonly fileHints = this.events.invalidations('files');

  private loadedFor: number | null = null;
  private resetFor: number | null = null;
  private seenHint = -1;
  private missedHint = false;

  constructor() {
    // Driven off the id and the hint, gated on visibility — never off a click, so a deep link and a
    // press behave identically.
    effect(() => {
      const workspaceRowId = this.workspaceRowId();
      const hint = this.fileHints();
      const visible = this.visible();
      untracked(() => this.decideRead(workspaceRowId, hint, visible));
    });

    // The generation gate. It writes rather than computes because holding the last consistent answer
    // is state: a computed would have to recompute it from an input that no longer exists.
    effect(() => {
      const incoming = this.incoming();
      const generation = this.generation();
      untracked(() => {
        const next = applyDetection(this.held(), incoming, generation);
        if (next !== this.held()) {
          this.held.set(next);
        }
      });
    });
  }

  // ---- what is on screen -------------------------------------------------------------------

  /** The tree's own token. Everything gated on a generation is gated on this one. */
  protected readonly generation = computed(() => {
    const state = this.listing();
    return state.kind === 'ready' ? state.value.generation : '';
  });

  protected readonly tree = computed(() => {
    const state = this.listing();
    return state.kind === 'ready' ? buildTree(state.value, this.opened()) : EMPTY_NODE;
  });

  private readonly openedPaths = computed<ReadonlySet<string>>(() => new Set(this.opened().keys()));

  /** Why the tree is narrowed, which decides how far it opens. */
  protected readonly narrowing = computed<readonly NarrowingKind[]>(() => {
    const kinds: NarrowingKind[] = [];
    if (this.query().trim() !== '') {
      kinds.push('name-search');
    }
    if (this.activeFrameworks().size > 0) {
      kinds.push('framework');
    }
    return kinds;
  });

  /** True while a search is on. Public because it is the assertion the expansion rule is worth. */
  readonly fullyExpanded = computed(() => expandsFully(this.narrowing()));

  /** Every framework kind the detection found, deduplicated — one toggle per kind, not per root. */
  protected readonly frameworkToggles = computed<readonly FrameworkToggle[]>(() => {
    const seen = new Map<string, FrameworkToggle>();
    for (const membership of this.held()?.frameworks ?? []) {
      if (!seen.has(membership.frameworkId)) {
        seen.set(membership.frameworkId, {
          frameworkId: membership.frameworkId,
          label: membership.label,
        });
      }
    }
    return [...seen.values()];
  });

  /**
   * The union of every active framework's members, or null when none is on.
   *
   * A whitelist over the server's membership set rather than a path prefix: a framework's files are
   * not always all under its root, and a nested sibling project under one would be swept in by a
   * prefix test.
   */
  private readonly memberSet = computed<ReadonlySet<string> | null>(() => {
    const active = this.activeFrameworks();
    if (active.size === 0) {
      return null;
    }
    const union = new Set<string>();
    for (const membership of this.held()?.frameworks ?? []) {
      if (active.has(membership.frameworkId)) {
        for (const path of membership.memberPaths) {
          union.add(path);
        }
      }
    }
    return union;
  });

  /** The file paths that survive the narrowing, or null when nothing narrows. */
  private readonly matched = computed(() =>
    visiblePaths(filePaths(this.tree()), this.query(), this.memberSet()),
  );

  protected readonly rows = computed<readonly TreeRow[]>(() =>
    flatten(this.tree(), {
      expanded: this.expanded(),
      fullyExpanded: this.fullyExpanded(),
      visible: this.matched(),
      opened: this.openedPaths(),
    }),
  );

  /**
   * How many stubs the filter could not look inside.
   *
   * Shown only while something narrows, because with no filter "collapsed" is just the tree being
   * collapsed. With one, the line is what stops "No files match." from being a lie about every
   * ignored directory in the repository.
   */
  protected readonly unsearched = computed(() =>
    this.narrowing().length === 0 ? 0 : unsearchedLazyDirs(this.tree(), this.openedPaths()),
  );

  /**
   * Nothing matched — said about *files*, not about rows.
   *
   * The distinction is load-bearing because an unopened stub stays visible under a filter, so a
   * search that found nothing still renders three collapsed directories. Counting rows would
   * therefore never reach zero and the sentence would never appear, on exactly the tree where it is
   * needed most. With no filter at all it means the workspace holds no files, which is a different
   * true thing said the same way.
   */
  protected readonly noMatch = computed(() => {
    if (this.listing().kind !== 'ready') {
      return false;
    }
    const matched = this.matched();
    return matched === null ? filePaths(this.tree()).length === 0 : matched.size === 0;
  });

  protected isFrameworkOn(frameworkId: string): boolean {
    return this.activeFrameworks().has(frameworkId);
  }

  // ---- what the panel does -----------------------------------------------------------------

  protected onQuery(value: string): void {
    this.query.set(value);
  }

  protected onOpenFile(path: string): void {
    this.selectedPath.set(path);
  }

  /**
   * A directory row was pressed.
   *
   * An unopened lazy directory costs one request; everything else is free. The selection is never
   * touched — toggling a folder while reading a file must not lose the user's place.
   */
  protected onToggleDir(row: TreeRow): void {
    const node = row.node;
    if (node.kind === 'lazy' && !this.openedPaths().has(node.path)) {
      void this.openLazyDir(node.path);
      return;
    }
    if (this.fullyExpanded() && node.kind !== 'lazy') {
      // The search opened the tree; collapsing one row would be arguing with it.
      return;
    }
    const paths = row.chain.length > 0 ? row.chain : [node.path];
    this.expanded.update((expanded) => {
      const next = new Set(expanded);
      for (const path of paths) {
        if (row.open) {
          next.delete(path);
        } else {
          next.add(path);
        }
      }
      return next;
    });
  }

  /**
   * Toggle one framework kind.
   *
   * Turning it **on** narrows the tree and seeds the expansion at a framework-sensible depth — the
   * browsing half of the expansion distinction. The seed is written into the expansion set rather
   * than applied as an override, so it survives the toggle being turned off again: by then the user
   * has been looking at that directory, and snapping it shut would take their place away.
   */
  protected toggleFramework(frameworkId: string): void {
    const active = new Set(this.activeFrameworks());
    if (active.has(frameworkId)) {
      active.delete(frameworkId);
      this.activeFrameworks.set(active);
      return;
    }
    active.add(frameworkId);
    this.activeFrameworks.set(active);

    const tree = this.tree();
    const seeded = new Set(this.expanded());
    for (const membership of this.held()?.frameworks ?? []) {
      if (membership.frameworkId !== frameworkId) {
        continue;
      }
      const members = new Set(membership.memberPaths);
      for (const path of frameworkSeed(tree, membership.root, members)) {
        seeded.add(path);
      }
    }
    this.expanded.set(seeded);
  }

  /** Re-read the tree on demand. The retry beside a failure, and nothing else calls it. */
  protected reload(): void {
    void this.load(this.workspaceRowId());
  }

  // ---- reads ---------------------------------------------------------------------------------

  private decideRead(workspaceRowId: number, hint: number, visible: boolean): void {
    if (workspaceRowId <= 0) {
      return;
    }
    if (hint !== this.seenHint) {
      this.seenHint = hint;
      this.missedHint = true;
    }
    // Once per workspace, not once per effect run: these are fresh objects, so re-setting them while
    // the panel sat hidden would invalidate every downstream computed for nothing.
    if (this.resetFor !== workspaceRowId) {
      this.resetFor = workspaceRowId;
      this.opened.set(new Map());
      this.expanded.set(new Set());
      this.held.set(null);
      this.incoming.set(null);
      this.selectedPath.set(null);
    }
    if (!visible) {
      return;
    }
    if (this.loadedFor === workspaceRowId && !this.missedHint) {
      return;
    }
    this.missedHint = false;
    this.loadedFor = workspaceRowId;
    void this.load(workspaceRowId);
  }

  /**
   * The two reads, issued together.
   *
   * The detection failure is swallowed and the tree's is not: a tree with no framework footer is a
   * working file browser, and a second error line for a feature the user did not ask for would bury
   * the one that matters.
   */
  private async load(workspaceRowId: number): Promise<void> {
    if (workspaceRowId <= 0) {
      return;
    }
    const detecting = this.filesApi
      .detection(workspaceRowId)
      .then((detection) => this.incoming.set(detection))
      .catch(() => undefined);

    this.listing.set(LOADING);
    try {
      const listing = await this.filesApi.files(workspaceRowId);
      // The per-directory cache describes one generation. While the token holds, re-expanding an
      // opened directory stays free; when it moves, every cached level may be stale and is dropped.
      if (this.generationOnHand() !== listing.generation) {
        this.opened.set(new Map());
      }
      this.listing.set(ready(listing));
    } catch (error) {
      this.listing.set(failed(error));
    }
    await detecting;
  }

  private generationOnHand(): string {
    const state = untracked(this.listing);
    return state.kind === 'ready' ? state.value.generation : '';
  }

  private async openLazyDir(path: string): Promise<void> {
    const workspaceRowId = this.workspaceRowId();
    this.pending.update((pending) => new Set(pending).add(path));
    try {
      const listing = await this.filesApi.files(workspaceRowId, path);
      this.opened.update((opened) => new Map(opened).set(path, listing));
      this.expanded.update((expanded) => new Set(expanded).add(path));
    } catch {
      // Silent, as the spec's interaction table says: a folder that will not open stays shut, and
      // the daemon being gone is already said once in the status strip.
    } finally {
      this.pending.update((pending) => {
        const next = new Set(pending);
        next.delete(path);
        return next;
      });
    }
  }
}
