import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { TreeRow } from './tree-model';

/**
 * The rows of the working tree, and nothing else — it holds no state and makes no request.
 *
 * Everything it draws was decided in `tree-model.ts` and everything it does is an output. That split
 * is what lets the model be tested as arithmetic (which is what compaction, filtering and the
 * expansion rules are) rather than through a DOM.
 *
 * **The chevron is drawn in CSS.** The explorer screens use literal `▸`/`▾` characters and render
 * tofu boxes wherever the font has no glyph — five sites, a parked bug. This repo had no tree until
 * now, so it inherits nothing: a rotated bordered corner costs the same and cannot fail to render.
 *
 * **A folder click never moves the selection.** Toggling a directory while reading a file is
 * navigation, not a choice of file, and stealing the highlight would lose the user's place — which
 * is the one thing a two-pane browser must not do.
 *
 * **The flattened list is deliberate.** A recursive component would nest one host element per level
 * and make `aria-level` a lie about the DOM; a flat list with `aria-level` is the pattern assistive
 * technology expects, and it is also what a virtualised tree would need later.
 */
@Component({
  selector: 'app-file-tree',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ul class="tree" role="tree" [attr.aria-label]="label()">
      @for (row of rows(); track row.node.path) {
        <li
          class="row"
          role="treeitem"
          [class.ignored]="row.ignored"
          [class.selected]="row.node.path === selected()"
          [attr.aria-level]="row.depth + 1"
          [attr.aria-expanded]="row.node.kind === 'file' ? null : row.open"
          [attr.aria-selected]="row.node.path === selected()"
          [style.padding-left.rem]="0.35 + row.depth * 0.85"
        >
          <button
            type="button"
            class="entry"
            [class.file]="row.node.kind === 'file'"
            [attr.data-path]="row.node.path"
            [attr.data-kind]="row.node.kind"
            [attr.title]="titleOf(row)"
            (click)="press(row)"
          >
            @if (row.node.kind === 'file') {
              <span class="gap" aria-hidden="true"></span>
            } @else {
              <span class="chevron" [class.open]="row.open" aria-hidden="true"></span>
            }
            @if (row.prefix.length > 0) {
              <span class="prefix">
                @for (segment of row.prefix; track $index) {
                  <span class="segment">{{ segment }}</span>
                  <span class="slash" aria-hidden="true">/</span>
                }
              </span>
            }
            <span class="name">{{ row.node.name }}</span>
            @if (row.node.kind === 'lazy') {
              <span class="count">({{ row.node.childCount }})</span>
            }
            @if (loading().has(row.node.path)) {
              <span class="pending">Loading…</span>
            }
          </button>
        </li>
      }
    </ul>
  `,
  styles: `
    :host {
      display: block;
    }
    .tree {
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .row {
      display: block;
    }
    .entry {
      display: flex;
      align-items: center;
      gap: 0.3rem;
      width: 100%;
      padding: 0.15rem 0.35rem;
      border: 0;
      border-radius: 0.25rem;
      background: none;
      color: #111827;
      font: inherit;
      font-size: 0.85rem;
      text-align: left;
      cursor: pointer;
    }
    .entry:hover {
      background: #f3f4f6;
    }
    .row.selected > .entry {
      background: #eff6ff;
      color: #1d4ed8;
      font-weight: 600;
    }
    .row.ignored > .entry {
      color: #9ca3af;
    }
    .row.ignored.selected > .entry {
      color: #60a5fa;
    }
    /* A rotated bordered corner rather than a ▸ character: no font can fail to render a border. */
    .chevron,
    .gap {
      flex: 0 0 auto;
      width: 0.7rem;
      height: 0.7rem;
    }
    .chevron::before {
      content: '';
      display: block;
      width: 0.34rem;
      height: 0.34rem;
      margin: 0.16rem 0 0 0.1rem;
      border-right: 1.5px solid currentColor;
      border-bottom: 1.5px solid currentColor;
      transform: rotate(-45deg);
      transition: transform 120ms ease;
    }
    .chevron.open::before {
      transform: rotate(45deg);
    }
    @media (prefers-reduced-motion: reduce) {
      .chevron::before {
        transition: none;
      }
    }
    .prefix {
      color: #9ca3af;
      font-size: 0.78rem;
    }
    .slash {
      margin: 0 0.15rem;
    }
    .count {
      color: #9ca3af;
      font-size: 0.78rem;
    }
    .pending {
      color: #6b7280;
      font-size: 0.78rem;
      font-style: italic;
    }
    .name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `,
})
export class FileTree {
  /** The rows to draw, already filtered, compacted and ordered by the model. */
  readonly rows = input.required<readonly TreeRow[]>();

  /** The open file's path, which is the only row drawn as chosen. */
  readonly selected = input<string | null>(null);

  /** Lazy directories with a fetch in flight. They say "Loading…" beside the count. */
  readonly loading = input<ReadonlySet<string>>(new Set<string>());

  /** What the tree is called, for a screen reader. */
  readonly label = input('Working tree');

  /** A file was chosen. */
  readonly openFile = output<string>();

  /** A directory row was pressed. The panel decides whether that costs a request. */
  readonly toggleDir = output<TreeRow>();

  protected press(row: TreeRow): void {
    if (row.node.kind === 'file') {
      this.openFile.emit(row.node.path);
    } else {
      this.toggleDir.emit(row);
    }
  }

  /**
   * The full path on hover. A compacted row shows three names and one of them is the whole story,
   * and an ignored row is worth being told about rather than left to be inferred from the colour.
   */
  protected titleOf(row: TreeRow): string {
    const suffix = row.ignored ? ' — git ignores this' : '';
    return `${row.node.path}${suffix}`;
  }
}
