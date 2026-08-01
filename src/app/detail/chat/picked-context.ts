import { Injectable, computed, signal } from '@angular/core';

/**
 * The things picked elsewhere on the page that the prompt is composed from.
 *
 * Two producers and one consumer, and they land in different workstreams — the Files viewer picks
 * line ranges, the Web view picks elements, and the prompt panel renders both as rows you press to
 * insert. So the store is the seam between them, and it is here because the *consumer* is here:
 * without it the pickers would have nowhere to write and the rows nothing to read.
 *
 * It is application-scoped and keyed by workspace, like the tab host it lives inside. {@link use}
 * clears it when the workspace under it changes, because a line range in one workspace's file means
 * nothing in another's.
 *
 * **The picks are work product, so they ride the prompt draft.** They are saved into the draft's
 * `content` blob and restored from it, which is why a chip survives a reload and why the schema of
 * that blob is the client's own.
 */

/** A range of lines picked in the Files tab. */
export interface CodeReference {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  /** What those lines said when they were picked, for the preview. */
  readonly excerpt: string;
}

/** An element picked in the Web view. */
export interface PickedElement {
  readonly tag: string;
  readonly selector: string;
  readonly textPreview: string;
  /** The app-side route, with the proxy prefix stripped — the route the app was on, not ours. */
  readonly route: string;
  readonly componentName: string | null;
  readonly sourceFiles: readonly string[];
}

/** What the prompt panel writes to the server and reads back. */
export interface DraftComposition {
  readonly text: string;
  readonly references: readonly CodeReference[];
  readonly elements: readonly PickedElement[];
}

/** The `path:start-end` label a reference is known by, on its chip and in the text it inserts. */
export function referenceLabel(reference: CodeReference): string {
  return reference.startLine === reference.endLine
    ? `${reference.path}:${reference.startLine}`
    : `${reference.path}:${reference.startLine}-${reference.endLine}`;
}

/** What pressing a reference row puts in the draft: the label, then the lines, fenced. */
export function referenceText(reference: CodeReference): string {
  return `${referenceLabel(reference)}\n\`\`\`\n${reference.excerpt}\n\`\`\``;
}

/** What pressing an element row puts in the draft. */
export function elementText(element: PickedElement): string {
  const lines = [
    `<${element.tag}> ${element.selector}`,
    `route: ${element.route}`,
    element.componentName ? `component: ${element.componentName}` : null,
    element.sourceFiles.length > 0 ? `source: ${element.sourceFiles.join(', ')}` : null,
    element.textPreview ? `text: ${element.textPreview}` : null,
  ].filter((line): line is string => line !== null);
  return `\`\`\`\n${lines.join('\n')}\n\`\`\``;
}

@Injectable({ providedIn: 'root' })
export class PickedContext {
  private readonly workspaceRowId = signal(0);
  private readonly refs = signal<readonly CodeReference[]>([]);
  private readonly picks = signal<readonly PickedElement[]>([]);

  readonly references = this.refs.asReadonly();
  readonly elements = this.picks.asReadonly();

  /** Whether anything has been picked. The rows are drawn only when there is something in them. */
  readonly any = computed(() => this.refs().length > 0 || this.picks().length > 0);

  /** Point at a workspace. A change empties the picks; the same id is a no-op. */
  use(workspaceRowId: number): void {
    if (this.workspaceRowId() === workspaceRowId) {
      return;
    }
    this.workspaceRowId.set(workspaceRowId);
    this.refs.set([]);
    this.picks.set([]);
  }

  /** Pick a line range. Picking the same range twice keeps one, so a double click is harmless. */
  addReference(reference: CodeReference): void {
    this.refs.update((current) =>
      current.some((entry) => referenceLabel(entry) === referenceLabel(reference))
        ? current
        : [...current, reference],
    );
  }

  removeReference(label: string): void {
    this.refs.update((current) => current.filter((entry) => referenceLabel(entry) !== label));
  }

  /** Pick an element. Picking an already-picked one unpicks it, as the frame's own toggle does. */
  toggleElement(element: PickedElement): void {
    this.picks.update((current) =>
      current.some((entry) => entry.selector === element.selector)
        ? current.filter((entry) => entry.selector !== element.selector)
        : [...current, element],
    );
  }

  removeElement(selector: string): void {
    this.picks.update((current) => current.filter((entry) => entry.selector !== selector));
  }

  clear(): void {
    this.refs.set([]);
    this.picks.set([]);
  }

  /** Adopt what a restored draft carried. */
  restore(composition: DraftComposition): void {
    this.refs.set(composition.references ?? []);
    this.picks.set(composition.elements ?? []);
  }
}

/**
 * Read a draft's `content` blob.
 *
 * The blob is this client's own schema and the host validates only that it is JSON, so a blob written
 * by an older build — or by hand — has to degrade rather than throw. Anything unreadable becomes an
 * empty composition, which is the same screen as "no draft" and never worse than one.
 */
export function parseComposition(content: string): DraftComposition {
  try {
    const value: unknown = JSON.parse(content);
    if (typeof value !== 'object' || value === null) {
      return { text: '', references: [], elements: [] };
    }
    const record = value as Record<string, unknown>;
    return {
      text: typeof record['text'] === 'string' ? record['text'] : '',
      references: Array.isArray(record['references'])
        ? (record['references'] as readonly CodeReference[])
        : [],
      elements: Array.isArray(record['elements'])
        ? (record['elements'] as readonly PickedElement[])
        : [],
    };
  } catch {
    return { text: '', references: [], elements: [] };
  }
}

/**
 * The flattened prompt: what the agent is actually handed.
 *
 * The picked rows are buttons that *insert* their text into the box, so anything the user chose to
 * include is already in `text`. What is appended here is the rest — picks that were made and never
 * inserted — under a heading, because dropping them silently would make the chips a lie about what
 * the agent will see.
 */
export function serializePrompt(composition: DraftComposition): string {
  const parts: string[] = [];
  if (composition.text.trim()) {
    parts.push(composition.text.trim());
  }
  const extras = [
    ...composition.references
      .filter((reference) => !composition.text.includes(referenceLabel(reference)))
      .map(referenceText),
    ...composition.elements
      .filter((element) => !composition.text.includes(element.selector))
      .map(elementText),
  ];
  if (extras.length > 0) {
    parts.push(`Context picked in the workspace:\n\n${extras.join('\n\n')}`);
  }
  return parts.join('\n\n');
}
