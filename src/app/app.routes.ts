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
 * Every route inside the platform chrome, three times: bare, under a project, under a repository.
 *
 * `QitsMainLayout` is a route component rather than something wrapped around the shell so that it
 * is entered once and then kept: every page this app grows lands in `children`, beneath the
 * layout's own outlet, and moving between them never rebuilds the sidebar.
 *
 * **The same components serve all three forms.** `/qits/services/qits-ci/` is the workspaces of one
 * repository, `/qits/` is the picker over that project's wrappers and `/` is the picker over every
 * project; the pages read that from `QITS_SCOPE` rather than from route parameters, which is why
 * the scoped branches declare no readers of `:project`, `:category` or `:repository`.
 *
 * **The project form is what the chrome's project picker navigates to.** `UrlScope.select(slug)`
 * goes to `/<slug>/`, so without this route picking a project here would land on the 404 page.
 *
 * **Order is the whole grammar**, and it works because the three vocabularies cannot collide: a
 * category is never a slug, and a slug is never one of this app's own first segments. Own routes
 * first, so `repositories/…` stays this application's literal rather than a project called
 * `repositories`; the repository form next, guarded on the category; the project form last, which
 * takes what is left.
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
      { path: ':project', children: own },
      { path: '**', component: NotFound },
    ],
  },
];
