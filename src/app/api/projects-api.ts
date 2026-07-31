import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { QITS_API_BASE } from './api-base';
import type {
  ProjectDto,
  ProjectEntriesResponse,
  RepositoryDto,
  RepositoryEntriesResponse,
} from './dto';

/**
 * The two reads this app makes against qits-projects, and it makes them for one reason:
 * **qits-workspaces cannot list repositories.** Its workspace listing takes a mandatory
 * `repositoryId`, and it holds repository ids as opaque strings with no listing of its own — so the
 * only place a person can find out which repositories exist is the service that owns them.
 *
 * This service is duplicated in qits-spa-ci and qits-spa-cd rather than shared. It is roughly forty
 * lines, and the alternative — putting it in `@qits/ui-components` — would push a transport
 * dependency into seven SPAs that make no requests, and turn every change to it into a library
 * publish plus a version bump in eight applications.
 */
@Injectable({ providedIn: 'root' })
export class ProjectsApi {
  private readonly http = inject(HttpClient);
  private readonly base = inject(QITS_API_BASE);

  /** Every project. One request, on page load. */
  async projects(): Promise<readonly ProjectDto[]> {
    const response = await firstValueFrom(
      this.http.get<ProjectEntriesResponse>(`${this.base}/projects/api/projects`),
    );
    return response.entries.map((entry) => entry.project);
  }

  /** One project's repositories, fetched when that project is chosen and never before. */
  async repositories(projectId: string): Promise<readonly RepositoryDto[]> {
    const response = await firstValueFrom(
      this.http.get<RepositoryEntriesResponse>(
        `${this.base}/projects/api/projects/${encodeURIComponent(projectId)}/repositories`,
      ),
    );
    return response.entries.map((entry) => entry.repository);
  }
}
