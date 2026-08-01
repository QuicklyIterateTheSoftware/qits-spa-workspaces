import { Injectable, computed, inject, signal } from '@angular/core';
import { FilesApi, type DetectionDto } from './files-api';

/**
 * The one detection answer, shared between the two surfaces that want it.
 *
 * The plan names them: *"one detection entry feeds the file browser and the plugin recommender."*
 * They want very different halves of it — the browser wants membership sets and the source-to-test
 * graph, the recommender wants nothing but the framework ids — and they are on different tabs, so a
 * naive second fetch would be invisible until somebody counted requests.
 *
 * **The file browser stays the owner of the fetch, and this holds what it read.** That is deliberate
 * rather than tidy. The browser's read is gated on a generation token against `GET /files`, and
 * moving it here would either drag that gate along or quietly break it — the flicker it prevents is
 * the kind of bug that is very hard to diagnose later. So the browser {@link publish}es what it got,
 * and the recommender {@link ensure}s: it reads what is already on hand, and pays for one fetch only
 * when nothing has.
 *
 * The consequence, stated rather than hidden: opening Agents before Files costs one `GET /detection`,
 * and opening Files afterwards still does its own gated read. One extra request in one order of
 * clicks, against a second permanent copy of a surface another panel owns.
 */
@Injectable({ providedIn: 'root' })
export class WorkspaceDetection {
  private readonly api = inject(FilesApi);

  private readonly workspaceRowId = signal(0);
  private readonly held = signal<DetectionDto | null>(null);
  private asking: Promise<void> | null = null;

  /** The detection on hand, or null while nobody has read one for this workspace. */
  readonly detection = this.held.asReadonly();

  /** Every framework id detected anywhere in the tree, deduplicated. What the recommender reads. */
  readonly frameworkIds = computed<ReadonlySet<string>>(() => {
    const detection = this.held();
    if (!detection) {
      return new Set<string>();
    }
    const ids = new Set<string>();
    for (const project of detection.projects) {
      ids.add(project.frameworkId);
    }
    for (const framework of detection.frameworks) {
      ids.add(framework.frameworkId);
    }
    return ids;
  });

  /** Point at a workspace. A change drops what was held: one container's frameworks are not another's. */
  use(workspaceRowId: number): void {
    if (this.workspaceRowId() === workspaceRowId) {
      return;
    }
    this.workspaceRowId.set(workspaceRowId);
    this.held.set(null);
    this.asking = null;
  }

  /**
   * The file browser's own read, handed on so nobody else has to make it.
   *
   * An unclaimed entry adopts the workspace it is handed — the browser reads a detection long before
   * anything here asks for one, and dropping that answer would make the *first* reader pay for a
   * request that has already been made. An entry that is claimed keeps its own id, so a late answer
   * for a workspace the page has left cannot repoint it.
   */
  publish(workspaceRowId: number, detection: DetectionDto): void {
    if (this.workspaceRowId() === 0) {
      this.workspaceRowId.set(workspaceRowId);
    }
    if (this.workspaceRowId() === workspaceRowId) {
      this.held.set(detection);
    }
  }

  /**
   * Read one, but only if nothing has.
   *
   * Idempotent while a read is in flight, so a second caller in the same frame joins the first rather
   * than racing it. A failure is swallowed: detection drives a *badge* here, and a recommender that
   * cannot sort is a worse screen than one that does not, never a broken one.
   */
  async ensure(workspaceRowId: number): Promise<void> {
    this.use(workspaceRowId);
    if (workspaceRowId <= 0 || this.held() !== null) {
      return;
    }
    this.asking ??= this.api
      .detection(workspaceRowId)
      .then((detection) => this.publish(workspaceRowId, detection))
      .catch(() => undefined)
      .finally(() => {
        this.asking = null;
      });
    await this.asking;
  }
}
