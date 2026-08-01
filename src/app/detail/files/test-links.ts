import type { FileLinkDto } from '../../api/files-api';
import { stem } from './filter-rules';

/**
 * The source-to-test graph, seen the way the viewer's tab strip needs it.
 *
 * The daemon answers `links: [{path, projectRoot?, tests[]}]` — a list keyed by the **source**. The
 * strip has to work when the test is what is open, and it has to show the *same* strip either way,
 * so the graph is normalised: every member of a group, source and tests alike, resolves to the one
 * group its owning source defines. Opening `AppTest.java` and opening `App.java` are then the same
 * screen with a different tab selected, which is what makes the strip navigation rather than a badge.
 */

/** One source file and the tests that reach it — the tab strip, in data. */
export interface FileGroup {
  /** The owning source. Always the "Code" tab, always first. */
  readonly source: string;
  /** Its tests, in the order the detection listed them. */
  readonly tests: readonly string[];
}

/**
 * Every path that belongs to a group, mapped to that group.
 *
 * A test reached from two sources is attributed to the first source in path order. It is arbitrary
 * and it is deterministic, which is the property that matters: an attribution that changed between
 * two identical loads would move a tab under the user's cursor.
 */
export function buildGroups(links: readonly FileLinkDto[]): ReadonlyMap<string, FileGroup> {
  const groups = new Map<string, FileGroup>();
  const ordered = [...links].sort((left, right) => left.path.localeCompare(right.path));
  for (const link of ordered) {
    if (link.tests.length === 0) {
      continue;
    }
    const group: FileGroup = { source: link.path, tests: link.tests.map((test) => test.path) };
    groups.set(link.path, group);
    for (const test of group.tests) {
      if (!groups.has(test)) {
        groups.set(test, group);
      }
    }
  }
  return groups;
}

/**
 * Every test that some source reaches.
 *
 * These leave the tree, because a test that is one click away from its source is a second row saying
 * the same thing — and in a Maven or Angular layout that is half the file list. **Except while
 * name-searching**: a search is the user asking where something is, and answering "not here" about a
 * file that exists would be the tree lying. So the hide is dropped the moment the box has text in it.
 */
export function reachableTests(links: readonly FileLinkDto[]): ReadonlySet<string> {
  const tests = new Set<string>();
  for (const link of links) {
    for (const test of link.tests) {
      tests.add(test.path);
    }
  }
  return tests;
}

/** What one test tab is labelled: its basename without the extension, with the path as its tooltip. */
export function tabLabel(path: string): string {
  return stem(path);
}
