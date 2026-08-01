import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { QitsButton } from '@qits/ui-components';
import type { FilterPreview, FilterRule, MatchKind, RuleMode } from './filter-rules';
import { PREVIEW_LIMIT } from './filter-rules';

/** One generated rule set the dialog can expand read-only. */
export interface GeneratedSet {
  /** What the toggle is called: an ignore file's basename, or a framework's label. */
  readonly name: string;
  /** The key the toggle emits. */
  readonly id: string;
  readonly on: boolean;
  /** Something worth saying beside the name — "3 files", "412 paths". */
  readonly note: string;
  /** The rules it generated, in evaluation order, as text. */
  readonly rules: readonly string[];
}

/**
 * The advanced filter: an ordered rule list, the dynamic filters under it, and a live preview.
 *
 * ## Last match wins
 *
 * The list is evaluated top to bottom and **the last rule that matches decides**, exactly like a
 * `.gitignore`. That is why the rows are ordered rather than a set, why they can be moved, and why a
 * disabled row keeps its place instead of disappearing: the order *is* the meaning, and a row that
 * jumped to the end when you switched it off would change what the rows around it do.
 *
 * ## Why the layers are not reorderable
 *
 * The generated sets sit **under** the manual rules in a fixed order — framework, then ignore-list,
 * then manual — and the dialog says so out loud rather than offering to change it. A framework
 * restriction sets a default-hidden stance and whitelists its members; the ignore lists subtract;
 * the manual rules go last **so that a manual `show` can always resurrect a file something else
 * hid.** That guarantee is the reason to open this dialog at all, and it only exists because the
 * order is fixed.
 *
 * ## Why it is not a `<dialog>`
 *
 * `showModal` is a browser API a jsdom spec cannot exercise, and this panel's whole content is
 * arithmetic worth asserting. A `role="dialog"` region with the same focus semantics costs nothing
 * and stays testable.
 */
@Component({
  selector: 'app-filter-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [QitsButton],
  template: `
    <section class="sheet" role="dialog" aria-modal="true" aria-label="Advanced file filter">
      <header class="head">
        <h3>Filter rules</h3>
        <qits-button variant="ghost" size="sm" (pressed)="closed.emit()">Done</qits-button>
      </header>

      <p class="explain">
        Rules run top to bottom and the <strong>last one that matches wins</strong>, the way a
        <code>.gitignore</code> does. The generated sets below run first — framework, then ignore
        list — so a <em>show</em> rule up here can always bring back a file they hid.
      </p>

      <ol class="rules">
        @for (rule of rules(); track rule.id; let index = $index; let last = $last) {
          <li class="rule">
            <input
              type="checkbox"
              class="on"
              [attr.aria-label]="'Enable rule ' + (index + 1)"
              [checked]="rule.enabled"
              (change)="patch(index, { enabled: !rule.enabled })"
            />
            <select
              class="mode"
              [attr.aria-label]="'Rule ' + (index + 1) + ' mode'"
              [value]="rule.mode"
              (change)="patch(index, { mode: modeOf($event) })"
            >
              <option value="show">show</option>
              <option value="hide">hide</option>
            </select>
            <select
              class="kind"
              [attr.aria-label]="'Rule ' + (index + 1) + ' match'"
              [value]="rule.kind"
              (change)="patch(index, { kind: kindOf($event) })"
            >
              <option value="fuzzy">fuzzy</option>
              <option value="includes">includes</option>
              <option value="exact">exact</option>
            </select>
            <input
              type="text"
              class="query"
              autocomplete="off"
              spellcheck="false"
              placeholder="a name, or a path with a /"
              [attr.aria-label]="'Rule ' + (index + 1) + ' query'"
              [value]="rule.query"
              (input)="patch(index, { query: valueOf($event) })"
            />
            <button
              type="button"
              class="move"
              [disabled]="index === 0"
              [attr.aria-label]="'Move rule ' + (index + 1) + ' earlier'"
              (click)="move(index, -1)"
            >
              ↑
            </button>
            <button
              type="button"
              class="move"
              [disabled]="last"
              [attr.aria-label]="'Move rule ' + (index + 1) + ' later'"
              (click)="move(index, 1)"
            >
              ↓
            </button>
            <button
              type="button"
              class="drop"
              [attr.aria-label]="'Remove rule ' + (index + 1)"
              (click)="remove(index)"
            >
              ✕
            </button>
          </li>
        }
      </ol>

      <qits-button variant="secondary" size="sm" (pressed)="add()">Add a rule</qits-button>

      @if (frameworkSets().length > 0 || ignoreSets().length > 0) {
        <div class="generated">
          <h4>Generated sets</h4>
          @for (set of frameworkSets(); track set.id) {
            <details class="set">
              <summary>
                <input
                  type="checkbox"
                  class="on"
                  [attr.data-framework]="set.id"
                  [attr.aria-label]="'Restrict to ' + set.name"
                  [checked]="set.on"
                  (change)="toggleFramework.emit(set.id)"
                />
                <span class="name">{{ set.name }}</span>
                <span class="note">framework · {{ set.note }}</span>
              </summary>
              <ul class="lines">
                @for (line of set.rules; track $index) {
                  <li>{{ line }}</li>
                }
              </ul>
            </details>
          }
          @for (set of ignoreSets(); track set.id) {
            <details class="set">
              <summary>
                <input
                  type="checkbox"
                  class="on"
                  [attr.data-ignore]="set.id"
                  [attr.aria-label]="'Apply ' + set.name"
                  [checked]="set.on"
                  (change)="toggleIgnore.emit(set.id)"
                />
                <span class="name">{{ set.name }}</span>
                <span class="note">ignore list · {{ set.note }}</span>
              </summary>
              <ul class="lines">
                @if (set.on && set.rules.length === 0) {
                  <li class="muted">Reading the ignore files…</li>
                }
                @for (line of set.rules; track $index) {
                  <li>{{ line }}</li>
                }
              </ul>
            </details>
          }
        </div>
      }

      <div class="preview">
        <h4>Preview</h4>
        <p class="count">
          {{ preview().total }} {{ preview().total === 1 ? 'file' : 'files' }} visible.
          @if (preview().truncated) {
            <span class="muted">Showing the first {{ limit }}.</span>
          }
        </p>
        @if (preview().total === 0) {
          <p class="muted">Nothing matches these rules.</p>
        } @else {
          <ul class="paths">
            @for (path of preview().paths; track path) {
              <li>{{ path }}</li>
            }
          </ul>
        }
      </div>
    </section>
  `,
  styles: `
    :host {
      display: block;
      margin: 0.5rem 0 0.75rem;
    }
    .sheet {
      padding: 0.75rem;
      border: 1px solid #d1d5db;
      border-radius: 0.4rem;
      background: #f9fafb;
    }
    .head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 0.6rem;
    }
    h3 {
      margin: 0;
      font-size: 0.95rem;
    }
    h4 {
      margin: 0.9rem 0 0.35rem;
      font-size: 0.82rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: #6b7280;
    }
    .explain {
      margin: 0.35rem 0 0.7rem;
      color: #6b7280;
      font-size: 0.8rem;
    }
    .rules {
      margin: 0 0 0.5rem;
      padding: 0;
      list-style: none;
    }
    .rule {
      display: flex;
      align-items: center;
      gap: 0.35rem;
      padding: 0.2rem 0;
    }
    .query {
      flex: 1 1 auto;
      min-width: 6rem;
      padding: 0.2rem 0.4rem;
      border: 1px solid #d1d5db;
      border-radius: 0.25rem;
      font: inherit;
      font-size: 0.8rem;
    }
    .mode,
    .kind {
      padding: 0.15rem 0.25rem;
      border: 1px solid #d1d5db;
      border-radius: 0.25rem;
      background: #ffffff;
      font: inherit;
      font-size: 0.78rem;
    }
    .move,
    .drop {
      padding: 0.1rem 0.35rem;
      border: 1px solid #e5e7eb;
      border-radius: 0.25rem;
      background: #ffffff;
      color: #6b7280;
      font: inherit;
      font-size: 0.78rem;
      cursor: pointer;
    }
    .move:disabled {
      color: #d1d5db;
      cursor: default;
    }
    .set {
      padding: 0.15rem 0;
      font-size: 0.8rem;
    }
    .set summary {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      cursor: pointer;
    }
    .name {
      font-weight: 600;
    }
    .note,
    .muted {
      color: #6b7280;
      font-size: 0.78rem;
    }
    .lines {
      margin: 0.2rem 0 0.4rem 1.6rem;
      padding: 0;
      list-style: none;
      color: #4b5563;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.75rem;
    }
    .count {
      margin: 0 0 0.3rem;
      font-size: 0.8rem;
    }
    .paths {
      max-height: 12rem;
      margin: 0;
      padding: 0.3rem 0.5rem;
      overflow: auto;
      border: 1px solid #e5e7eb;
      border-radius: 0.3rem;
      background: #ffffff;
      list-style: none;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.75rem;
    }
  `,
})
export class FilterDialog {
  /** The manual rules, in evaluation order. */
  readonly rules = input.required<readonly FilterRule[]>();

  /** The framework whitelists, which run first. */
  readonly frameworkSets = input<readonly GeneratedSet[]>([]);

  /** The ignore lists, which run between the frameworks and the manual rules. */
  readonly ignoreSets = input<readonly GeneratedSet[]>([]);

  /** What the rules currently show, already truncated by the model. */
  readonly preview = input.required<FilterPreview>();

  readonly rulesChange = output<readonly FilterRule[]>();
  readonly toggleFramework = output<string>();
  readonly toggleIgnore = output<string>();
  readonly closed = output<void>();

  protected readonly limit = PREVIEW_LIMIT;

  protected add(): void {
    const rule: FilterRule = {
      id: `rule-${Date.now()}-${this.rules().length}`,
      kind: 'fuzzy',
      query: '',
      mode: 'hide',
      enabled: true,
    };
    this.rulesChange.emit([...this.rules(), rule]);
  }

  protected patch(index: number, change: Partial<FilterRule>): void {
    this.rulesChange.emit(
      this.rules().map((rule, at) => (at === index ? { ...rule, ...change } : rule)),
    );
  }

  protected remove(index: number): void {
    this.rulesChange.emit(this.rules().filter((_, at) => at !== index));
  }

  /** Move one row and leave the rest alone — the order is the meaning, so nothing else may shift. */
  protected move(index: number, by: number): void {
    const next = [...this.rules()];
    const to = index + by;
    if (to < 0 || to >= next.length) {
      return;
    }
    [next[index], next[to]] = [next[to], next[index]];
    this.rulesChange.emit(next);
  }

  protected valueOf(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected modeOf(event: Event): RuleMode {
    return (event.target as HTMLSelectElement).value as RuleMode;
  }

  protected kindOf(event: Event): MatchKind {
    return (event.target as HTMLSelectElement).value as MatchKind;
  }
}
