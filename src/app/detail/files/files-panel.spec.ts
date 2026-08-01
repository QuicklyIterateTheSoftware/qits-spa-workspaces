import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { DetectionDto, FileListingDto } from '../../api/files-api';
import { WorkspaceEvents } from '../../api/workspace-events';
import { FilesPanel } from './files-panel';

const ROOT: FileListingDto = {
  paths: [
    'README.md',
    'service/src/main/java/eu/wohlben/App.java',
    'service/src/test/java/eu/wohlben/AppTest.java',
    'webui/package.json',
    'webui/src/main.ts',
    'webui/src/app/app.ts',
    'webui/src/app/pages/home.ts',
    'webui/src/app/widgets/chip.ts',
  ],
  lazyDirs: [
    { path: 'node_modules', childCount: 312 },
    { path: 'service/target', childCount: 9 },
    { path: 'webui/dist', childCount: 3 },
  ],
  generation: 'gen-1',
};

const ANGULAR_MEMBERS = [
  'webui/package.json',
  'webui/src/main.ts',
  'webui/src/app/app.ts',
  'webui/src/app/pages/home.ts',
  'webui/src/app/widgets/chip.ts',
];

const detectionAt = (generation: string): DetectionDto => ({
  projects: [
    { root: 'webui', frameworkId: 'angular', label: 'Angular' },
    { root: 'service', frameworkId: 'java-quarkus', label: 'Java / Quarkus' },
  ],
  frameworks: [
    { frameworkId: 'angular', root: 'webui', label: 'Angular', memberPaths: ANGULAR_MEMBERS },
    {
      frameworkId: 'java-quarkus',
      root: 'service',
      label: 'Java / Quarkus',
      memberPaths: [
        'service/src/main/java/eu/wohlben/App.java',
        'service/src/test/java/eu/wohlben/AppTest.java',
      ],
    },
  ],
  links: [],
  generation,
});

@Component({
  selector: 'app-panel-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FilesPanel],
  template: `<app-files-panel [workspaceRowId]="id()" [visible]="visible()" />`,
})
class PanelHost {
  readonly id = signal(7);
  readonly visible = signal(true);
}

/**
 * The working-tree browser, in the terms the plan set it.
 *
 * **The load budget is asserted, not just written down.** `2 + D` — the whole eager tree, the
 * detection, and one read per lazy directory opened. A budget that lives only in a comment grows a
 * third constant the first time somebody needs one, and nobody notices until a file browser is
 * fetching a level at a time.
 *
 * **The expansion distinction is asserted through the DOM as well as as arithmetic**, because it is
 * the thing the plan warns is easy to flatten by accident: a name search opens the tree fully so a
 * deep match is visible, and a framework toggle opens to a framework-sensible depth and stops.
 * Reversing either one would still look like a working file browser.
 *
 * **A hidden panel does not refetch.** It stays mounted — the open file and the scroll position are
 * why keep-mounted exists — so without the gate a `files` hint on another tab pays for a tree nobody
 * is looking at.
 */
describe('FilesPanel', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<PanelHost>;
  let host: PanelHost;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function element(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function panel(): FilesPanel {
    return fixture.debugElement.children[0].componentInstance as FilesPanel;
  }

  function rowPaths(): string[] {
    return Array.from(element().querySelectorAll<HTMLElement>('.entry')).map(
      (entry) => entry.dataset['path'] ?? '',
    );
  }

  function entry(path: string): HTMLButtonElement {
    return element().querySelector<HTMLButtonElement>(`.entry[data-path="${path}"]`)!;
  }

  function chip(frameworkId: string): HTMLButtonElement {
    return element().querySelector<HTMLButtonElement>(`.chip[data-framework="${frameworkId}"]`)!;
  }

  /** The root read, in the order the panel issues it. */
  function answerRoot(
    listing: FileListingDto = ROOT,
    detection: DetectionDto | null = detectionAt('gen-1'),
  ): void {
    const files = http.expectOne(
      (request) => request.url === '/workspaces/container/7/files' && !request.params.has('path'),
    );
    files.flush(listing);
    const detect = http.expectOne('/workspaces/container/7/detection');
    if (detection) {
      detect.flush(detection);
    } else {
      detect.flush({ message: 'no' }, { status: 500, statusText: 'Server Error' });
    }
  }

  async function open(): Promise<void> {
    fixture = TestBed.createComponent(PanelHost);
    host = fixture.componentInstance;
    await settle();
    answerRoot();
    await settle();
  }

  async function type(query: string): Promise<void> {
    const box = element().querySelector<HTMLInputElement>('#file-filter')!;
    box.value = query;
    box.dispatchEvent(new Event('input'));
    await settle();
  }

  describe('the load budget', () => {
    it('reads two things on first open: the whole tree, and the detection', async () => {
      fixture = TestBed.createComponent(PanelHost);
      host = fixture.componentInstance;
      await settle();

      const requests = http.match(() => true);

      expect(requests.map((request) => request.request.urlWithParams).sort()).toEqual([
        '/workspaces/container/7/detection',
        '/workspaces/container/7/files',
      ]);
      for (const request of requests) {
        request.flush(request.request.url.endsWith('/detection') ? detectionAt('gen-1') : ROOT);
      }
      await settle();
    });

    it('costs one read per lazy directory opened, and nothing for the tree around it', async () => {
      await open();

      entry('node_modules').click();
      await settle();
      http
        .expectOne(
          (request) =>
            request.url === '/workspaces/container/7/files' &&
            request.params.get('path') === 'node_modules',
        )
        .flush({
          paths: ['node_modules/.package-lock.json'],
          lazyDirs: [{ path: 'node_modules/rxjs', childCount: 21 }],
          generation: 'gen-1',
        });
      await settle();

      expect(rowPaths()).toContain('node_modules/rxjs');
      expect(rowPaths()).toContain('node_modules/.package-lock.json');
    });

    it('caches a directory, so closing and re-opening it is free', async () => {
      await open();

      entry('node_modules').click();
      await settle();
      http
        .expectOne((request) => request.params.get('path') === 'node_modules')
        .flush({ paths: ['node_modules/index.js'], lazyDirs: [], generation: 'gen-1' });
      await settle();

      entry('node_modules').click();
      await settle();
      entry('node_modules').click();
      await settle();

      // No second fetch: `http.verify()` in afterEach is the assertion, and the contents are back.
      expect(rowPaths()).toContain('node_modules/index.js');
    });
  });

  describe('the visibility gate', () => {
    it('reads nothing at all while its tab is not the one showing', async () => {
      fixture = TestBed.createComponent(PanelHost);
      host = fixture.componentInstance;
      host.visible.set(false);
      await settle();

      expect(http.match(() => true)).toEqual([]);
    });

    it('spends a hint it missed as one catch-up read on becoming visible', async () => {
      await open();

      host.visible.set(false);
      await settle();
      TestBed.inject(WorkspaceEvents).invalidateAll();
      await settle();
      expect(http.match(() => true)).toEqual([]);

      host.visible.set(true);
      await settle();
      answerRoot();
      await settle();

      expect(rowPaths()).toContain('README.md');
    });
  });

  /**
   * The distinction the plan calls out by name. Both halves are asserted here because either one
   * alone still looks like a working tree — the bug is silent, and it is the deep match nobody can
   * find that eventually reports it.
   */
  describe('the two expansions', () => {
    it('opens the tree fully for a name search, so a deep match is visible with no clicks', async () => {
      await open();
      expect(rowPaths()).not.toContain('service/src/test/java/eu/wohlben/AppTest.java');

      await type('AppTest');

      expect(panel().fullyExpanded()).toBe(true);
      expect(rowPaths()).toContain('service/src/test/java/eu/wohlben/AppTest.java');
    });

    it('opens a framework toggle only to a framework-sensible depth', async () => {
      await open();

      chip('angular').click();
      await settle();

      expect(panel().fullyExpanded()).toBe(false);
      // Down to the source directory, where the components fork and the user has a choice to make.
      expect(rowPaths()).toContain('webui/src/app');
      expect(rowPaths()).toContain('webui/src/app/pages');
      // And no further: this is browsing, not searching.
      expect(rowPaths()).not.toContain('webui/src/app/pages/home.ts');
    });

    it('opens fully again when a search composes with a framework toggle', async () => {
      await open();
      chip('angular').click();
      await settle();

      await type('home');

      expect(panel().fullyExpanded()).toBe(true);
      expect(rowPaths()).toContain('webui/src/app/pages/home.ts');
    });

    it('keeps where the user was browsing when the framework toggle goes off again', async () => {
      await open();
      chip('angular').click();
      await settle();

      chip('angular').click();
      await settle();

      // The seed was written into the expansion set rather than applied as an override, so turning
      // the toggle off does not snap shut the directory the user has been reading.
      expect(rowPaths()).toContain('webui/src/app');
    });
  });

  describe('the tree itself', () => {
    it('labels a lazy directory with its immediate child count and dims it', async () => {
      await open();

      expect(entry('node_modules').textContent).toContain('(312)');
      expect(entry('node_modules').closest('.row')?.classList.contains('ignored')).toBe(true);
    });

    it('folds a single-child chain into one breadcrumb row', async () => {
      await open();

      entry('service').click();
      await settle();
      entry('service/src').click();
      await settle();

      const chain = entry('service/src/main/java/eu/wohlben');
      expect(chain).toBeTruthy();
      expect(chain.querySelector('.prefix')?.textContent).toContain('main');
      expect(chain.querySelector('.name')?.textContent?.trim()).toBe('wohlben');
    });

    it('does not let a folder steal the selection from the open file', async () => {
      await open();

      entry('README.md').click();
      await settle();
      expect(panel().selectedPath()).toBe('README.md');

      entry('webui').click();
      await settle();

      expect(panel().selectedPath()).toBe('README.md');
    });
  });

  describe('the footers', () => {
    it('says how many collapsed directories the filter could not look inside', async () => {
      await open();
      expect(element().querySelector('.unsearched')).toBeNull();

      await type('zzzz');

      expect(element().querySelector('.unsearched')?.textContent).toContain(
        '3 collapsed directories not searched',
      );
    });

    it('says nothing matched, beside the directories it could not search', async () => {
      await open();

      await type('zzzz');

      expect(element().textContent).toContain('No files match.');
      expect(element().querySelector('.unsearched')).not.toBeNull();
    });

    it('offers one quick-access toggle per detected framework kind', async () => {
      await open();

      const labels = Array.from(element().querySelectorAll('.chip')).map((node) =>
        node.textContent?.trim(),
      );

      expect(labels).toEqual(['Angular', 'Java / Quarkus']);
    });
  });

  /**
   * `/files` and `/detection` are two independently-fetched views over one mutable tree, so a skew is
   * normal. Applying a detection to a tree it was not computed from makes the footer flicker in a way
   * that is very hard to diagnose later, and blanking it does the same thing more loudly.
   */
  describe('the generation gate', () => {
    it('does not apply a detection computed from a different tree', async () => {
      fixture = TestBed.createComponent(PanelHost);
      host = fixture.componentInstance;
      await settle();
      answerRoot(ROOT, detectionAt('gen-2'));
      await settle();

      expect(element().querySelectorAll('.chip').length).toBe(0);
      expect(rowPaths()).toContain('README.md');
    });

    it('holds the last consistent detection rather than blanking it on a mismatch', async () => {
      await open();
      expect(element().querySelectorAll('.chip').length).toBe(2);

      TestBed.inject(WorkspaceEvents).invalidateAll();
      await settle();
      answerRoot({ ...ROOT, generation: 'gen-3' }, detectionAt('gen-1'));
      await settle();

      // The tree moved to gen-3 and the detection still describes gen-1, so the footer holds what it
      // had. The next tick resolves it; a blank footer in the meantime would read as "no frameworks".
      expect(element().querySelectorAll('.chip').length).toBe(2);
    });
  });
});
