import type { DetectionDto, FileListingDto } from '../../api/files-api';
import {
  OPEN_NOTHING,
  applyDetection,
  buildTree,
  expandsFully,
  filePaths,
  flatten,
  frameworkSeed,
  matchesQuery,
  unsearchedLazyDirs,
  visiblePaths,
  type TreeRow,
  type TreeView,
} from './tree-model';

/**
 * A repository with the two shapes that make the tree interesting: a Maven service whose sources sit
 * behind a long single-child chain, and an Angular app that forks at its component directory.
 *
 * The root answer holds the *whole* eager tree at full depth — that is what the daemon sends — and
 * the lazy directories are the gitignored ones, which are the only things it does not walk.
 */
const ROOT: FileListingDto = {
  paths: [
    'README.md',
    'pom.xml',
    'service/pom.xml',
    'service/src/main/java/eu/wohlben/App.java',
    'service/src/main/java/eu/wohlben/Route.java',
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
    { path: 'tools/node_modules', childCount: 4 },
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

const MAVEN_MEMBERS = [
  'pom.xml',
  'service/pom.xml',
  'service/src/main/java/eu/wohlben/App.java',
  'service/src/main/java/eu/wohlben/Route.java',
  'service/src/test/java/eu/wohlben/AppTest.java',
];

const view = (over: Partial<TreeView> = {}): TreeView => ({ ...OPEN_NOTHING, ...over });

const openEverything = (paths: readonly string[]): ReadonlySet<string> => new Set(paths);

const rowFor = (rows: readonly TreeRow[], path: string): TreeRow | undefined =>
  rows.find((row) => row.node.path === path);

const labelOf = (row: TreeRow): string => [...row.prefix, row.node.name].join('/');

describe('the working tree model', () => {
  describe('building', () => {
    it('creates the directories the deep paths only imply', () => {
      const tree = buildTree(ROOT);

      expect(tree.children.map((child) => child.name)).toEqual([
        'node_modules',
        'service',
        'tools',
        'webui',
        'pom.xml',
        'README.md',
      ]);
    });

    it('puts directories before files, which is the order every file browser has', () => {
      const tree = buildTree(ROOT);
      const kinds = tree.children.map((child) => child.kind);

      expect(kinds.indexOf('file')).toBeGreaterThan(kinds.lastIndexOf('dir'));
    });

    it('keeps a lazy directory as a stub carrying its immediate child count', () => {
      const tree = buildTree(ROOT);
      const modules = tree.children.find((child) => child.name === 'node_modules');

      expect(modules?.kind).toBe('lazy');
      expect(modules?.childCount).toBe(312);
      expect(modules?.children).toEqual([]);
    });

    it('takes an opened directory as one level, with its subdirectories stubbed again', () => {
      const opened = new Map<string, FileListingDto>([
        [
          'node_modules',
          {
            paths: ['node_modules/.package-lock.json'],
            lazyDirs: [{ path: 'node_modules/rxjs', childCount: 21 }],
            generation: 'gen-1',
          },
        ],
      ]);

      const tree = buildTree(ROOT, opened);
      const modules = tree.children.find((child) => child.name === 'node_modules');

      expect(modules?.children.map((child) => `${child.kind}:${child.name}`)).toEqual([
        'lazy:rxjs',
        'file:.package-lock.json',
      ]);
    });

    it('applies a nested opened directory after the parent that had to create it', () => {
      const opened = new Map<string, FileListingDto>([
        [
          'node_modules/rxjs',
          { paths: ['node_modules/rxjs/index.js'], lazyDirs: [], generation: 'gen-1' },
        ],
        [
          'node_modules',
          {
            paths: [],
            lazyDirs: [{ path: 'node_modules/rxjs', childCount: 1 }],
            generation: 'gen-1',
          },
        ],
      ]);

      const rows = flatten(
        buildTree(ROOT, opened),
        view({
          opened: new Set(['node_modules', 'node_modules/rxjs']),
          expanded: new Set(['node_modules', 'node_modules/rxjs']),
        }),
      );

      expect(rowFor(rows, 'node_modules/rxjs/index.js')).toBeDefined();
    });
  });

  describe('path compaction', () => {
    it('folds a single-child directory chain into one breadcrumb row', () => {
      const rows = flatten(
        buildTree(ROOT),
        view({ expanded: openEverything(['service', 'service/src']) }),
      );

      const compacted = rows.find((row) => row.prefix.length > 0);
      expect(labelOf(compacted!)).toBe('main/java/eu/wohlben');
      expect(compacted!.chain).toEqual([
        'service/src/main',
        'service/src/main/java',
        'service/src/main/java/eu',
        'service/src/main/java/eu/wohlben',
      ]);
    });

    it('never folds a lazy directory into a chain — it is a compaction boundary', () => {
      const rows = flatten(buildTree(ROOT), view());
      const tools = rowFor(rows, 'tools');

      // `tools` holds exactly one child and would fold on any other kind of node.
      expect(tools).toBeDefined();
      expect(tools!.prefix).toEqual([]);
      expect(tools!.chain).toEqual(['tools']);
    });

    it('leaves every ancestor of a folded chain open, so a later split re-opens where the user was', () => {
      const rows = flatten(
        buildTree(ROOT),
        view({ expanded: openEverything(['service', 'service/src']) }),
      );

      const compacted = rows.find((row) => row.prefix.length > 0)!;
      // A press writes the whole chain, so a filter that splits it finds the ancestors already open.
      const afterPress = new Set([...compacted.chain]);
      const split = flatten(
        buildTree(ROOT),
        view({
          expanded: new Set([...afterPress, 'service', 'service/src']),
          visible: new Set([
            'service/src/main/java/eu/wohlben/App.java',
            'service/src/main/java/eu/wohlben/Route.java',
          ]),
        }),
      );

      expect(rowFor(split, 'service/src/main/java/eu/wohlben/App.java')).toBeDefined();
    });
  });

  describe('the name filter', () => {
    it('matches a fuzzy subsequence of the file name', () => {
      expect(matchesQuery('src/app/workspace-detail-page.ts', 'wdp')).toBe(true);
      expect(matchesQuery('src/app/workspace-detail-page.ts', 'zzz')).toBe(false);
    });

    it('matches a glob form, anchored, so *.ts is not "contains .ts"', () => {
      expect(matchesQuery('webui/src/main.ts', '*.ts')).toBe(true);
      expect(matchesQuery('webui/src/main.tsx', '*.ts')).toBe(false);
    });

    it('matches the whole path when the query holds a slash, which is how a seeded path narrows', () => {
      expect(matchesQuery('webui/src/app/app.ts', 'webui/src/app/app.ts')).toBe(true);
      expect(matchesQuery('service/pom.xml', 'webui/src')).toBe(false);
    });

    it('tells "nothing is filtered" from "nothing matched"', () => {
      const paths = filePaths(buildTree(ROOT));

      expect(visiblePaths(paths, '', null)).toBeNull();
      expect(visiblePaths(paths, 'zzzz', null)?.size).toBe(0);
    });

    it('composes a framework whitelist with the name query', () => {
      const paths = filePaths(buildTree(ROOT));
      const visible = visiblePaths(paths, '*.ts', new Set(ANGULAR_MEMBERS));

      expect([...visible!].sort()).toEqual([
        'webui/src/app/app.ts',
        'webui/src/app/pages/home.ts',
        'webui/src/app/widgets/chip.ts',
        'webui/src/main.ts',
      ]);
    });
  });

  /**
   * The distinction the plan calls out by name, asserted as arithmetic here and through the DOM in
   * the panel's spec. A search must open the tree fully because a deep match is the answer; a
   * framework toggle must not, because it is browsing and opening everything would be jarring.
   *
   * `manual-rule` has no producer yet — the advanced filter dialog lands with the viewer — and it is
   * asserted anyway, so that workstream inherits the rule instead of having to rediscover it.
   */
  describe('the expansion distinction', () => {
    it('opens the tree fully for a name search', () => {
      expect(expandsFully(['name-search'])).toBe(true);
    });

    it('opens the tree fully for a manual rule, which is also a search', () => {
      expect(expandsFully(['manual-rule'])).toBe(true);
    });

    it('does not open the tree fully for a framework toggle, which is browsing', () => {
      expect(expandsFully(['framework'])).toBe(false);
    });

    it('opens fully when a search and a framework toggle compose', () => {
      expect(expandsFully(['framework', 'name-search'])).toBe(true);
    });

    it('shows a deep match with nothing expanded, when the search opened everything', () => {
      const tree = buildTree(ROOT);
      const rows = flatten(
        tree,
        view({
          fullyExpanded: true,
          visible: visiblePaths(filePaths(tree), 'AppTest', null),
        }),
      );

      expect(rowFor(rows, 'service/src/test/java/eu/wohlben/AppTest.java')).toBeDefined();
    });

    it('still does not open a lazy directory when a search opens everything else', () => {
      const rows = flatten(buildTree(ROOT), view({ fullyExpanded: true }));

      expect(rowFor(rows, 'node_modules')!.open).toBe(false);
    });
  });

  describe('the framework seed', () => {
    it('stops an Angular root at its source directory, where the components fork', () => {
      const seed = frameworkSeed(buildTree(ROOT), 'webui', new Set(ANGULAR_MEMBERS));

      expect(seed).toEqual(['webui', 'webui/src', 'webui/src/app']);
    });

    it('stops a Maven root where main and test fork, which is where the choice is', () => {
      const seed = frameworkSeed(buildTree(ROOT), 'service', new Set(MAVEN_MEMBERS));

      expect(seed).toEqual(['service', 'service/src']);
    });

    it('seeds nothing for a root the tree does not have', () => {
      expect(frameworkSeed(buildTree(ROOT), 'gone', new Set(['gone/a.txt']))).toEqual([]);
    });
  });

  describe('the collapsed-directories footer', () => {
    it('counts every stub nobody has opened', () => {
      expect(unsearchedLazyDirs(buildTree(ROOT), new Set())).toBe(3);
    });

    it('stops counting one that has been opened, and counts what it revealed', () => {
      const opened = new Map<string, FileListingDto>([
        [
          'node_modules',
          {
            paths: [],
            lazyDirs: [{ path: 'node_modules/rxjs', childCount: 21 }],
            generation: 'gen-1',
          },
        ],
      ]);

      expect(unsearchedLazyDirs(buildTree(ROOT, opened), new Set(['node_modules']))).toBe(3);
    });

    it('keeps an unopened stub visible while filtering, so "open to include" has something to open', () => {
      const tree = buildTree(ROOT);
      const rows = flatten(
        tree,
        view({ fullyExpanded: true, visible: visiblePaths(filePaths(tree), 'zzzz', null) }),
      );

      expect(rowFor(rows, 'node_modules')).toBeDefined();
    });
  });

  /**
   * The tree and the detection are two independently-fetched views of one mutable tree, so a skew is
   * normal and momentary. Blanking on a mismatch would flicker the framework footer every time an
   * agent writes a file; holding the last consistent answer lets the next tick resolve it.
   */
  describe('the generation gate', () => {
    const detection = (generation: string): DetectionDto => ({
      projects: [],
      frameworks: [],
      links: [],
      generation,
    });

    it('applies a detection computed from the tree on screen', () => {
      const incoming = detection('gen-1');

      expect(applyDetection(null, incoming, 'gen-1')).toBe(incoming);
    });

    it('holds the last consistent detection rather than blanking on a mismatch', () => {
      const held = detection('gen-1');

      expect(applyDetection(held, detection('gen-2'), 'gen-1')).toBe(held);
    });

    it('holds what it has when there is no answer yet at all', () => {
      const held = detection('gen-1');

      expect(applyDetection(held, null, 'gen-1')).toBe(held);
    });
  });
});
