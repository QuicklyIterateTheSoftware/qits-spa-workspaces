import type { Routes } from '@angular/router';
import { QitsMainLayout } from '@qits/ui-components';
import { NotFound } from './not-found/not-found';
import { WorkspacesPage } from './workspaces/workspaces-page';

/**
 * Two routes, both inside the platform chrome.
 *
 * `QitsMainLayout` is a route component rather than something wrapped around the shell so that it
 * is entered once and then kept: every page this app grows lands in `children`, beneath the
 * layout's own outlet, and moving between them never rebuilds the sidebar. This is the slot the
 * previous comment promised; the workspaces page is what arrived in it.
 *
 * **The workspaces list is the root view**, not a child called `/workspaces`: the app is already
 * served at `/workspaces/`, so a second segment of the same name would read as
 * `/workspaces/workspaces/`. Which repository is being looked at is carried in query parameters
 * (`?project=…&repository=…`) rather than in path segments — it is a selection, the path is for
 * resources, and query parameters keep the back button meaning "the previous repository".
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
      { path: '**', component: NotFound },
    ],
  },
];
