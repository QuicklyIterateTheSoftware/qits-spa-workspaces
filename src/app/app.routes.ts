import type { Routes } from '@angular/router';
import { QitsMainLayout } from '@qits/ui-components';
import { WorkspaceDetailPage } from './detail/workspace-detail-page';
import { NotFound } from './not-found/not-found';
import { WorkspacesPage } from './overview/workspaces-page';

/**
 * Two routes, both inside the platform chrome.
 *
 * `QitsMainLayout` is a route component rather than something wrapped around the shell so that it
 * is entered once and then kept: every page this app grows lands in `children`, beneath the
 * layout's own outlet, and moving between them never rebuilds the sidebar.
 *
 * **The root view is intentionally small.** It lists active workspaces for the picked wrapper and
 * offers the aggregate create flow. The picker holds one wrapper per project — the row qits-projects
 * names as the wrapper — and `?repository=<id>` preselects one, which is how the projects SPA links
 * a project straight to its own aggregate create.
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
 *
 * The `**` route sits *inside* the layout, unlike spa-home's. spa-home is mounted at the gateway
 * root, where an unrecognised first segment belongs to another application and has to be handed
 * back; `/workspaces/` is a segment this application owns outright, so an unknown URL under it is
 * an ordinary 404 and is drawn with the chrome around it.
 */
export const routes: Routes = [
  {
    path: '',
    component: QitsMainLayout,
    children: [
      { path: '', component: WorkspacesPage },
      {
        path: 'repositories/:repositoryId/workspaces/:workspaceId',
        component: WorkspaceDetailPage,
      },
      { path: '**', component: NotFound },
    ],
  },
];
