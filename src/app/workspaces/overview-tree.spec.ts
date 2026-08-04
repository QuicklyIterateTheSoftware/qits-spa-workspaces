import type { BranchDto, RepositoryDto, WorkspaceDto } from '../api/dto';
import { LOADING, ready } from '../ui/loadable';
import {
  WORKSPACE_ID_MAX_LENGTH,
  childRows,
  deriveWorkspaceId,
  newestWorkspaceAt,
  sortRoots,
  type RepositoryNode,
} from './overview-tree';

/**
 * The tree's rules, asserted away from the DOM: what becomes a row, in what order, and what a
 * branch name becomes when it has to be a workspace label.
 */
describe('overview-tree', () => {
  const workspace = (
    id: number,
    label: string,
    over: Partial<WorkspaceDto> = {},
  ): WorkspaceDto => ({
    id,
    workspaceId: label,
    parent: 'main',
    branch: label,
    ahead: 1,
    behind: 0,
    conflictsWithParent: false,
    status: 'ACTIVE',
    runtimeStatus: 'RUNNING',
    runtimeError: null,
    clean: true,
    agentActivity: null,
    preamble: null,
    result: null,
    resolvedAt: null,
    daemonConnectedAt: null,
    daemonVersion: null,
    daemonBuildTime: null,
    daemonOutdated: null,
    ...over,
  });

  const branch = (name: string, over: Partial<BranchDto> = {}): BranchDto => ({
    name,
    canCleanup: false,
    parent: null,
    ahead: null,
    behind: null,
    ...over,
  });

  const repository = (id: string): RepositoryDto => ({
    id,
    url: `ssh://git@example/${id}.git`,
    mainBranch: 'main',
    archetype: 'SERVICE',
    projectId: 'p1',
  });

  const node = (id: string, over: Partial<RepositoryNode> = {}): RepositoryNode => ({
    repository: repository(id),
    projectName: 'qits',
    workspaces: ready([]),
    branches: ready([]),
    children: [],
    settled: true,
    newestAt: null,
    creating: new Set(),
    createErrors: new Map(),
    ...over,
  });

  describe('childRows', () => {
    it('never makes a child of the trunk', () => {
      // The main branch is what everything here forked from. Offering it a workspace would be
      // offering to work on the release branch directly.
      const rows = childRows([], [branch('main'), branch('fix-lint')], 'main');
      expect(rows.map((row) => row.key)).toEqual(['branch:fix-lint']);
    });

    it('joins by branch name, and the workspace takes the row', () => {
      const rows = childRows(
        [workspace(7, 'fix-lint')],
        [branch('main'), branch('fix-lint'), branch('drop-dead-code')],
        'main',
      );
      expect(rows.map((row) => row.kind)).toEqual(['workspace', 'branch']);
      expect(rows.map((row) => row.key)).toEqual(['workspace:7', 'branch:drop-dead-code']);
    });

    it('keeps a workspace whose branch is no longer listed', () => {
      // The work is real whether or not the mirror has caught up with the ref.
      const rows = childRows([workspace(7, 'fix-lint')], [branch('main')], 'main');
      expect(rows.map((row) => row.key)).toEqual(['workspace:7']);
    });

    it('orders workspaces newest first and leaves the undated ones at the bottom', () => {
      const rows = childRows(
        [
          workspace(1, 'older', { createdAt: '2026-08-01T09:00:00Z' }),
          workspace(2, 'undated'),
          workspace(3, 'newer', { createdAt: '2026-08-03T09:00:00Z' }),
        ],
        [],
        'main',
      );
      expect(rows.map((row) => row.key)).toEqual(['workspace:3', 'workspace:1', 'workspace:2']);
    });

    it('works with no createdAt anywhere, keeping the service’s own order', () => {
      const rows = childRows([workspace(1, 'a'), workspace(2, 'b')], [], 'main');
      expect(rows.map((row) => row.key)).toEqual(['workspace:1', 'workspace:2']);
    });
  });

  describe('sortRoots', () => {
    it('puts the most recently worked-in repository first', () => {
      const sorted = sortRoots([
        node('quiet', { newestAt: Date.parse('2026-07-01T00:00:00Z') }),
        node('busy', { newestAt: Date.parse('2026-08-03T00:00:00Z') }),
      ]);
      expect(sorted.map((root) => root.repository.id)).toEqual(['busy', 'quiet']);
    });

    it('sends the still-loading and the workspace-less below, alphabetically', () => {
      const sorted = sortRoots([
        node('zebra'),
        node('loading', { workspaces: LOADING, settled: false }),
        node('busy', { newestAt: Date.parse('2026-08-03T00:00:00Z') }),
        node('alpha'),
      ]);
      expect(sorted.map((root) => root.repository.id)).toEqual([
        'busy',
        'alpha',
        'loading',
        'zebra',
      ]);
    });
  });

  describe('newestWorkspaceAt', () => {
    it('is null when nothing dates itself', () => {
      expect(newestWorkspaceAt([workspace(1, 'a')])).toBeNull();
    });

    it('ignores a timestamp that will not parse rather than ordering by NaN', () => {
      expect(newestWorkspaceAt([workspace(1, 'a', { createdAt: 'whenever' })])).toBeNull();
    });
  });

  describe('deriveWorkspaceId', () => {
    it('keeps only what the server accepts in a label', () => {
      expect(deriveWorkspaceId('feature/add thing!', new Set())).toBe('feature-add-thing-');
    });

    it('falls back rather than posting something the server will refuse', () => {
      expect(deriveWorkspaceId('///', new Set())).toBe('workspace');
      expect(deriveWorkspaceId('', new Set())).toBe('workspace');
    });

    it('de-collides against the labels the repository already handed out', () => {
      expect(deriveWorkspaceId('fix-lint', new Set(['fix-lint']))).toBe('fix-lint-2');
      expect(deriveWorkspaceId('fix-lint', new Set(['fix-lint', 'fix-lint-2']))).toBe('fix-lint-3');
    });

    it('never exceeds the cap, suffix included', () => {
      const long = 'x'.repeat(80);
      const stem = 'x'.repeat(WORKSPACE_ID_MAX_LENGTH);
      const derived = deriveWorkspaceId(long, new Set([stem]));
      expect(derived.length).toBe(WORKSPACE_ID_MAX_LENGTH);
      expect(derived.endsWith('-2')).toBe(true);
    });
  });
});
