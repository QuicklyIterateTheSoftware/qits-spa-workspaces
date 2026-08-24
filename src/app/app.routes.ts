import type { CanMatchFn, Routes } from '@angular/router';
import { QITS_CATEGORIES, QitsMainLayout, type QitsCategory } from '@qits/ui-components';
import { WorkspaceDetailPage } from './detail/workspace-detail-page';
import { NotFound } from './not-found/not-found';
import { WorkspacesPage } from './overview/workspaces-page';

/**
 * The two pages this application owns.
 *
 * **The root view is intentionally small.** It lists the active workspaces of whatever repository
 * is in scope and offers the create flow. Unscoped it falls back to a picker, one wrapper per
 * project — the row qits-projects names as the wrapper — and `?repository=<id>` preselects one.
 *
 * **The detail route names a repository and then a workspace**, and the repository segment is not
 * decoration: qits-workspaces' listing takes a mandatory `repositoryId` and answers 404 without one,
 * so a detail page that could not name its repository could not read its own header. The workspace
 * id is the generated one every route addresses, never the branch-derived label — the label is
 * unique only among active workspaces in one repository and is reusable once one resolves.
 *
 * **Which tab is open rides in `?tab=`, not in a trailing segment.** A trailing segment would make a
 * tab switch free (Angular reuses a component across a parameter change) and would make a *workspace*
 * switch free too — which is the bug, not the feature. Keeping the tab in the query string leaves the
 * path meaning "which workspace", makes a bare URL mean "no tab pinned" by simple absence, and keeps
 * every tab a shareable link.
 */
const own: Routes = [
  { path: '', component: WorkspacesPage },
  {
    path: 'repositories/:repositoryId/workspaces/:workspaceId',
    component: WorkspaceDetailPage,
  },
];

/**
 * Is `<project>/<category>/<repository>` a repository address, or this application's own three
 * segments?
 *
 * The category is what decides, because it is the one segment of the three drawn from a closed set.
 * `segments` are the ones left at this level, so the category is `segments[1]` — the parent route is
 * the layout's `''` and consumes nothing.
 */
export const categoryIsKnown: CanMatchFn = (_route, segments) =>
  QITS_CATEGORIES.includes(segments[1]?.path as QitsCategory);

/**
 * Every route inside the platform chrome, twice: once bare, once under a repository.
 *
 * `QitsMainLayout` is a route component rather than something wrapped around the shell so that it
 * is entered once and then kept: every page this app grows lands in `children`, beneath the
 * layout's own outlet, and moving between them never rebuilds the sidebar.
 *
 * **The same components serve both forms.** `/qits/services/qits-ci/` is the workspaces of one
 * repository and `/` is the picker over all of them; the pages read that from `QITS_SCOPE` rather
 * than from route parameters, which is why the scoped branch declares no readers of `:project`,
 * `:category` or `:repository`.
 *
 * **Own routes come first**, so `repositories/…` stays this application's literal rather than being
 * read as a project called `repositories`.
 *
 * The `**` route sits *inside* the layout: this application is served at the root of its own host,
 * so an unknown URL under it is an ordinary 404 and is drawn with the chrome around it.
 */
export const routes: Routes = [
  {
    path: '',
    component: QitsMainLayout,
    children: [
      ...own,
      { path: ':project/:category/:repository', canMatch: [categoryIsKnown], children: own },
      { path: '**', component: NotFound },
    ],
  },
];
