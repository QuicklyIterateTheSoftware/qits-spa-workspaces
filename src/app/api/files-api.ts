import { Injectable, inject } from '@angular/core';
import { WorkspaceDaemonApi } from './workspace-daemon-api';

/**
 * One gitignored directory, returned as a stub rather than walked.
 *
 * **Being lazy *is* the ignored flag.** The daemon has no separate marker, and it does not need one:
 * content only ever enters the tree through one of these, so "at or under a lazy directory" is an
 * exact test for "git ignores this" — which is what lets the tree dim ignored rows without parsing a
 * single `.gitignore`.
 */
export interface LazyDirDto {
  readonly path: string;
  /** Immediate children only, never a recursive count. It is the number the label shows. */
  readonly childCount: number;
}

/**
 * One level of the working tree.
 *
 * The two levels are **not** the same shape of answer, and building a tree without knowing that is
 * the first thing to get wrong:
 *
 * - **The root** (`GET /files`, no `path`) answers the *whole eager tree* in one request — every
 *   tracked and new file, at full depth, from `git ls-files --cached --others --exclude-standard` —
 *   plus the wholly-ignored directories as stubs. So `paths` holds deep paths with slashes in them,
 *   and the directories between them are implied by the paths rather than listed.
 * - **A directory** (`GET /files?path=…`) answers that one directory a single level deep: its
 *   immediate files in `paths`, and **all** of its immediate subdirectories as stubs — laziness
 *   applies recursively, so arbitrarily deep ignored nesting resolves through the same call.
 *
 * That asymmetry is the reason the tree costs one request plus one per opened directory, rather than
 * one per directory in the repository.
 */
export interface FileListingDto {
  readonly paths: readonly string[];
  readonly lazyDirs: readonly LazyDirDto[];
  readonly generation: string;
}

/** One detected project: where it starts, what it is, and what to call it. */
export interface DetectionProjectDto {
  /** Workspace-root-relative; the empty string for the repository root itself. */
  readonly root: string;
  readonly frameworkId: string;
  readonly label: string;
}

/** Which files belong to one detected framework — the whitelist a quick-access toggle applies. */
export interface FrameworkMembershipDto {
  readonly frameworkId: string;
  readonly root: string;
  readonly label: string;
  readonly memberPaths: readonly string[];
}

/** One test that reaches a source file. Read by the viewer's test/code strip, which lands later. */
export interface TestLinkDto {
  readonly path: string;
  readonly kinds: readonly string[];
}

/** One source file and the tests that reach it. */
export interface FileLinkDto {
  readonly path: string;
  readonly projectRoot?: string;
  readonly tests: readonly TestLinkDto[];
}

/** Frameworks, projects and the source-to-test graph, stamped with the tree they were computed from. */
export interface DetectionDto {
  readonly projects: readonly DetectionProjectDto[];
  readonly frameworks: readonly FrameworkMembershipDto[];
  readonly links: readonly FileLinkDto[];
  readonly generation: string;
}

/**
 * The working tree and what the daemon has detected in it — the two reads the file browser is built
 * from.
 *
 * Written by hand against `daemons/qits-workspace-daemon/docs/openapi.yml`, which is itself
 * hand-written and carries one acceptance rule: every field named in it is asserted as a literal
 * string by a test in that repository. That document is the contract; this file is its consumer, and
 * a rename on either side is meant to be a two-repository change.
 *
 * Everything goes through {@link WorkspaceDaemonApi}, which appends the path to
 * `/workspaces/container/{id}` verbatim and watches for the daemon going away. Nothing here catches:
 * a 502 is the daemon being gone and the panel renders that state, and swallowing it would leave the
 * page looking empty rather than looking broken.
 */
@Injectable({ providedIn: 'root' })
export class FilesApi {
  private readonly daemon = inject(WorkspaceDaemonApi);

  /**
   * One level of the tree. Omit `path` for the root, which is the whole eager tree in one answer.
   *
   * The `path` parameter is sent only when there is one: the daemon reads absent and blank alike as
   * "the root", but sending `path=` on the first load would make the request that fetches everything
   * look like a request for a directory called nothing.
   */
  async files(workspaceRowId: number, path?: string): Promise<FileListingDto> {
    return this.daemon.get<FileListingDto>(workspaceRowId, '/files', path ? { path } : undefined);
  }

  /**
   * Frameworks, projects and the test graph.
   *
   * Its `generation` is computed by a byte-identical duplicate of the algorithm `/files` uses, and
   * the whole point of it is that the two can be compared: a detection is applied only while its
   * token matches the tree on screen. See `applyDetection` in the tree model for the rule.
   */
  async detection(workspaceRowId: number): Promise<DetectionDto> {
    return this.daemon.get<DetectionDto>(workspaceRowId, '/detection');
  }
}
