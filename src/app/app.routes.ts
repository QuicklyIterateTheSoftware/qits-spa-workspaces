import type { Routes } from '@angular/router';
import { QitsMainLayout } from '@qits/ui-components';

/**
 * One route, and it is the chrome. `QitsMainLayout` is a route component rather than something
 * wrapped around the shell so that it is entered once and then kept: every page this app grows
 * lands in `children`, beneath the layout's own outlet, and moving between them never rebuilds the
 * sidebar.
 *
 * `children` is empty on purpose — the workspaces pages come later, and this is the slot they
 * arrive in.
 */
export const routes: Routes = [{ path: '', component: QitsMainLayout, children: [] }];
