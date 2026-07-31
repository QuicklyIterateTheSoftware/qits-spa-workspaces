import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/**
 * The shell, and deliberately nothing else. The chrome this app is seen through — the sidebar, the
 * top bar, the links out to the other SPAs — is `QitsMainLayout` behind the `''` route, so the one
 * thing this component owns is the outlet that lets the route table render at all.
 *
 * Keeping it empty is what lets the layout survive navigation: it sits one level down, *inside*
 * the routing, and only its own children change as the URL moves under /workspaces/.
 */
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet],
  template: '<router-outlet />',
})
export class App {}
