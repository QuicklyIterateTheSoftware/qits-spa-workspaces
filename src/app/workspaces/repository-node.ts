import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Async } from '../ui/async';
import { Empty } from '../ui/empty';
import { repositoryLabel, type RepositoryNode } from './overview-tree';
import { BranchRow } from './branch-row';
import { WorkspaceRow } from './workspace-row';

/**
 * One root of the overview: a repository, and everything in flight under it.
 *
 * **It renders its own two loading states rather than the page's one.** The workspace listing is the
 * expensive read on this screen — qits-workspaces refreshes the repository's mirror and asks docker
 * what is running before it can answer — so a page-wide barrier would hold every repository at the
 * speed of the slowest. Each root waits for itself, and the rest of the tree is already usable.
 *
 * The rows appear in two steps for the same reason. Workspaces are drawn the moment they land; the
 * branch rows join a beat later, because a branch cannot be offered a "Create workspace" button
 * until it is known that no workspace already claims it. Drawing them early would offer to create
 * something that exists.
 */
@Component({
  selector: 'app-repository-node',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Async, BranchRow, Empty, RouterLink, WorkspaceRow],
  template: `
    <div class="root">
      <h2>{{ label() }}</h2>
      <span class="project">{{ node().projectName }}</span>
    </div>

    <app-async
      [state]="node().workspaces"
      loadingLabel="Loading workspaces"
      errorLabel="Could not load the workspaces"
      (retry)="retryWorkspaces.emit()"
    />
    <app-async
      [state]="node().branches"
      loadingLabel="Loading branches"
      errorLabel="Could not load the branches"
      (retry)="retryBranches.emit()"
    />

    @if (node().children.length > 0) {
      <ul class="children">
        @for (child of node().children; track child.key) {
          <li>
            @if (child.kind === 'workspace') {
              <app-workspace-row [workspace]="child.workspace">
                <a
                  class="open"
                  [routerLink]="[
                    '/repositories',
                    node().repository.id,
                    'workspaces',
                    child.workspace.id,
                  ]"
                  >Open this workspace</a
                >
              </app-workspace-row>
            } @else {
              <app-branch-row
                [branch]="child.branch"
                [busy]="node().creating.has(child.branch.name)"
                [error]="node().createErrors.get(child.branch.name) ?? ''"
                (create)="create.emit($event)"
              />
            }
          </li>
        }
      </ul>
    } @else if (node().settled) {
      <app-empty
        message="Nothing in flight here — no workspaces, and no branch off the trunk waiting for one."
      />
    }
  `,
  styles: `
    :host {
      display: block;
      margin-bottom: 1.25rem;
    }
    .root {
      display: flex;
      align-items: baseline;
      gap: 0.5rem;
      flex-wrap: wrap;
    }
    h2 {
      margin: 0;
      font-size: 1.05rem;
    }
    .project {
      padding: 0.05rem 0.4rem;
      border: 1px solid #e5e7eb;
      border-radius: 0.75rem;
      background: #f9fafb;
      color: #6b7280;
      font-size: 0.75rem;
    }
    .children {
      list-style: none;
      margin: 0;
      padding: 0 0 0 1rem;
      border-left: 2px solid #e5e7eb;
    }
    /* The way into the detail view. A link and not a button: it is a navigation, and it is worth
       being able to open in a new tab. */
    .open {
      display: inline-block;
      color: #1d4ed8;
      font-size: 0.85rem;
    }
  `,
})
export class RepositoryNodeView {
  readonly node = input.required<RepositoryNode>();

  readonly retryWorkspaces = output<void>();
  readonly retryBranches = output<void>();

  /** A branch name to make a workspace over. */
  readonly create = output<string>();

  label(): string {
    return repositoryLabel(this.node().repository);
  }
}
