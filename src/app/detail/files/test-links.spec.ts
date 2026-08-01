import type { FileLinkDto } from '../../api/files-api';
import { buildGroups, reachableTests, tabLabel } from './test-links';

const LINKS: readonly FileLinkDto[] = [
  {
    path: 'webui/src/app/app.ts',
    projectRoot: 'webui',
    tests: [
      { path: 'webui/src/app/app.spec.ts', kinds: ['unit'] },
      { path: 'e2e/app.e2e.ts', kinds: ['e2e'] },
    ],
  },
  { path: 'webui/src/main.ts', projectRoot: 'webui', tests: [] },
  {
    path: 'service/src/main/java/App.java',
    tests: [{ path: 'service/src/test/java/AppTest.java', kinds: ['unit'] }],
  },
];

/**
 * The tab strip, normalised through the owning source.
 *
 * The point of the normalisation is that opening a test and opening its source are the *same screen*
 * with a different tab selected. A strip built per-file would give the source three tabs and the test
 * none, which reads as a bug the first time anybody opens a spec file directly.
 */
describe('the source-to-test graph', () => {
  it('resolves every member of a group to the same group', () => {
    const groups = buildGroups(LINKS);

    expect(groups.get('webui/src/app/app.ts')).toEqual(groups.get('webui/src/app/app.spec.ts'));
    expect(groups.get('e2e/app.e2e.ts')?.source).toBe('webui/src/app/app.ts');
  });

  it('leaves a source with no tests out, because a strip of one tab is noise', () => {
    expect(buildGroups(LINKS).has('webui/src/main.ts')).toBe(false);
  });

  it('keeps the detection order of the tests, so the tabs do not shuffle', () => {
    expect(buildGroups(LINKS).get('webui/src/app/app.ts')?.tests).toEqual([
      'webui/src/app/app.spec.ts',
      'e2e/app.e2e.ts',
    ]);
  });

  it('attributes a test shared by two sources deterministically', () => {
    const shared: readonly FileLinkDto[] = [
      { path: 'b.ts', tests: [{ path: 'shared.spec.ts', kinds: [] }] },
      { path: 'a.ts', tests: [{ path: 'shared.spec.ts', kinds: [] }] },
    ];

    // Path order, not answer order: two identical loads must not move a tab under the cursor.
    expect(buildGroups(shared).get('shared.spec.ts')?.source).toBe('a.ts');
  });

  it('collects every reachable test, which is the set that leaves the tree', () => {
    expect([...reachableTests(LINKS)].sort()).toEqual([
      'e2e/app.e2e.ts',
      'service/src/test/java/AppTest.java',
      'webui/src/app/app.spec.ts',
    ]);
  });

  it('labels a tab by the basename without its extension', () => {
    expect(tabLabel('webui/src/app/app.spec.ts')).toBe('app');
    expect(tabLabel('service/src/test/java/AppTest.java')).toBe('AppTest');
  });
});
