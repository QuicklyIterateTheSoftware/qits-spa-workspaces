import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { FilterDialog, type GeneratedSet } from './filter-dialog';
import { PREVIEW_LIMIT, type FilterPreview, type FilterRule } from './filter-rules';

const RULES: readonly FilterRule[] = [
  { id: 'a', kind: 'includes', query: '.ts', mode: 'hide', enabled: true },
  { id: 'b', kind: 'exact', query: 'main.ts', mode: 'show', enabled: true },
];

const PREVIEW: FilterPreview = {
  paths: ['webui/src/main.ts'],
  total: 1,
  truncated: false,
};

const IGNORE_SETS: readonly GeneratedSet[] = [
  {
    id: '.gitignore',
    name: '.gitignore',
    on: true,
    note: '2 files in the tree',
    rules: ['hide · *.log', 'show · webui/ · !keep.log'],
  },
];

@Component({
  selector: 'app-dialog-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FilterDialog],
  template: `
    <app-filter-dialog
      [rules]="rules()"
      [ignoreSets]="ignoreSets()"
      [preview]="preview()"
      (rulesChange)="rules.set($event)"
      (toggleIgnore)="toggled.set($event)"
    />
  `,
})
class DialogHost {
  readonly rules = signal<readonly FilterRule[]>(RULES);
  readonly ignoreSets = signal<readonly GeneratedSet[]>(IGNORE_SETS);
  readonly preview = signal<FilterPreview>(PREVIEW);
  readonly toggled = signal<string | null>(null);
}

/**
 * The dialog is an editor for an ordered list, and the order is the meaning.
 *
 * So the assertions are about *position*: moving a row moves only that row, removing one leaves the
 * rest where they were, and disabling one keeps its place. A dialog that sorted, deduplicated or
 * compacted its rows would silently change what they do.
 */
describe('FilterDialog', () => {
  let fixture: ComponentFixture<DialogHost>;
  let host: DialogHost;

  beforeEach(async () => {
    fixture = TestBed.createComponent(DialogHost);
    host = fixture.componentInstance;
    await fixture.whenStable();
    fixture.detectChanges();
  });

  function element(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  async function settle(): Promise<void> {
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function queries(): string[] {
    return Array.from(element().querySelectorAll<HTMLInputElement>('.query')).map(
      (box) => box.value,
    );
  }

  it('says out loud that the last match wins and that the generated sets run first', () => {
    const explain = element().querySelector('.explain')?.textContent ?? '';

    expect(explain).toContain('last one that matches wins');
    expect(explain).toContain('framework');
    expect(explain).toContain('ignore');
  });

  it('moves one row and leaves the rest where they were', async () => {
    // Two arrows per row, so index 1 is the first row's "later".
    element().querySelectorAll<HTMLButtonElement>('.move')[1].click();
    await settle();

    // The down arrow on the first row: the two swapped and nothing else shifted.
    expect(queries()).toEqual(['main.ts', '.ts']);
  });

  it('disables the arrows that would walk off the ends', () => {
    const arrows = Array.from(element().querySelectorAll<HTMLButtonElement>('.move'));

    expect(arrows[0].disabled).toBe(true);
    expect(arrows[arrows.length - 1].disabled).toBe(true);
  });

  it('adds a rule at the end, where a new rule has the last word', async () => {
    element().querySelector<HTMLElement>('qits-button[variant="secondary"] button')?.click();
    await settle();

    expect(host.rules().length).toBe(3);
    expect(host.rules()[2].query).toBe('');
  });

  it('removes a rule without touching its neighbours', async () => {
    element().querySelector<HTMLButtonElement>('.drop')!.click();
    await settle();

    expect(queries()).toEqual(['main.ts']);
  });

  it('keeps a disabled rule in its place', async () => {
    const checkbox = element().querySelector<HTMLInputElement>('.rule .on')!;
    checkbox.click();
    await settle();

    expect(host.rules()[0].enabled).toBe(false);
    expect(queries()).toEqual(['.ts', 'main.ts']);
  });

  it('shows a generated set read-only, in evaluation order', () => {
    const lines = Array.from(element().querySelectorAll('.set .lines li')).map((node) =>
      node.textContent?.trim(),
    );

    expect(lines).toEqual(['hide · *.log', 'show · webui/ · !keep.log']);
    expect(element().querySelector('.set input[type="text"]')).toBeNull();
  });

  it('emits the toggle rather than deciding for itself', async () => {
    element().querySelector<HTMLInputElement>('.set .on')!.click();
    await settle();

    expect(host.toggled()).toBe('.gitignore');
  });

  it('counts everything and says when it is only printing some of it', async () => {
    host.preview.set({
      paths: Array.from({ length: PREVIEW_LIMIT }, (_, at) => `file-${at}.ts`),
      total: PREVIEW_LIMIT + 12,
      truncated: true,
    });
    await settle();

    const count = element().querySelector('.count')?.textContent ?? '';
    expect(count).toContain(`${PREVIEW_LIMIT + 12} files visible`);
    expect(count).toContain(`Showing the first ${PREVIEW_LIMIT}`);
    expect(element().querySelectorAll('.paths li').length).toBe(PREVIEW_LIMIT);
  });

  it('says nothing matches rather than drawing an empty box', async () => {
    host.preview.set({ paths: [], total: 0, truncated: false });
    await settle();

    expect(element().textContent).toContain('Nothing matches these rules.');
  });
});
