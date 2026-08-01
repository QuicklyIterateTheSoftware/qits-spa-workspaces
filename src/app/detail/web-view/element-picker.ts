import type { ComponentMapDto, ComponentMapEntryDto } from '../../api/component-map-api';
import type { PickedElement } from '../chat/picked-context';

/**
 * The element picker: click something in the framed app, and the agent hears about it in the terms
 * the codebase uses.
 *
 * **It exists because the frame is same-origin.** The app is served through this platform's own
 * proxy, so this page may read the framed document, walk it and mark it. On a foreign-origin page
 * every one of those throws, and the picker's answer is to say so plainly rather than to arm and do
 * nothing — a toggle that silently never picks is worse than one that refuses.
 *
 * ## The behaviours that are easy to get wrong
 *
 * **A plain pick is one-shot.** It captures and disarms, because the framed app has to stay usable:
 * a picker that stayed armed would eat the next click on a button the user actually wanted to press.
 * **Shift keeps it armed**, which is multi-select and is the only reason a mode is needed at all.
 *
 * **Picking an already-picked element unpicks it**, and the mark in the frame follows the store in
 * both directions — the store is the truth, and a mark left behind by a chip somebody removed on the
 * prompt panel would be a second, wrong answer to "what is picked".
 *
 * **Attribution is best-effort by design.** The component map is fetched once per activation, so a
 * component created since then simply carries no attribution; that is the contract's own rule, and
 * it is why nothing here fails when the map is missing.
 */

/** What a pick tells the prompt, before the store's own shape is filled in. */
export interface FramePick extends PickedElement {
  /** Whether the picker should stay armed — shift-click, or a long press. */
  readonly keepPicking: boolean;
}

/**
 * How a marked element is drawn inside the framed app.
 *
 * Inline and `!important`, because this page does not own the framed app's stylesheet and the mark
 * has to win over whatever the app already says about that element. `data-qits-picked` is what the
 * picker reads back — a style property is the app's to overwrite, an attribute of ours is not.
 */
const MARK = '2px solid #2563eb';

/**
 * A CSS selector for one element, stable enough to name it and short enough to read.
 *
 * An id wins outright — it is the shortest true answer. Otherwise the path is built upwards with
 * `:nth-child`, which survives a re-render in a way a text- or class-based guess does not, and is
 * cut off at the body: a selector rooted in the document is no more precise and much harder to read.
 */
export function selectorFor(element: Element): string {
  if (element.id) {
    return idSelector(element.id);
  }
  const steps: string[] = [];
  let current: Element | null = element;
  while (current && current.tagName !== 'BODY' && current.tagName !== 'HTML') {
    const tag = current.tagName.toLowerCase();
    const parent: Element | null = current.parentElement;
    if (!parent) {
      steps.unshift(tag);
      break;
    }
    const index = Array.from(parent.children).indexOf(current) + 1;
    steps.unshift(`${tag}:nth-child(${index})`);
    if (current.id) {
      steps[0] = idSelector(current.id);
      break;
    }
    current = parent;
  }
  return steps.join(' > ');
}

/**
 * `#id` for an id a selector can carry plainly, `[id="…"]` for anything else.
 *
 * Hand-written rather than `CSS.escape`, which is not present in every environment this code is
 * exercised in — and the attribute form is exact for every id, so the fallback loses nothing but
 * brevity.
 */
function idSelector(id: string): string {
  return /^[A-Za-z_-][\w-]*$/.test(id) ? `#${id}` : `[id="${id.replace(/"/g, '\\"')}"]`;
}

/** Whether one component's selectors match this element — by element name, or by attribute. */
function matches(element: Element, component: ComponentMapEntryDto): boolean {
  const tag = element.tagName.toLowerCase();
  return component.selectors.some((selector) => {
    if (selector.element && selector.element.toLowerCase() === tag) {
      return true;
    }
    return selector.attribute !== undefined && element.hasAttribute(selector.attribute);
  });
}

/**
 * The component that owns this element, found by walking **up**.
 *
 * Up rather than down, because a click lands on the deepest thing under the cursor — a `<span>`
 * inside a button inside a component — and the useful answer is the nearest thing that has a source
 * file. A map that does not know the element yields null, which is a pick with no attribution rather
 * than a failure.
 */
export function attributionFor(
  element: Element,
  map: ComponentMapDto | null,
): { className: string; sourceFiles: readonly string[] } | null {
  if (!map || map.components.length === 0) {
    return null;
  }
  let current: Element | null = element;
  while (current) {
    const owner = map.components.find((component) => matches(current!, component));
    if (owner) {
      return {
        className: owner.className,
        sourceFiles: [
          owner.componentFile,
          ...(owner.templateFile ? [owner.templateFile] : []),
          ...owner.styleFiles,
        ],
      };
    }
    current = current.parentElement;
  }
  return null;
}

/** Everything the picker needs from the panel around it, as functions so nothing is stale. */
export interface PickerHooks {
  /** The app-side route at pick time, with the proxy prefix already stripped. */
  readonly route: () => string;
  /** The map fetched for this activation, or null when it never arrived. */
  readonly map: () => ComponentMapDto | null;
  /** Somebody picked. The panel writes it into the store and decides whether to stay armed. */
  readonly picked: (pick: FramePick) => void;
}

export class ElementPicker {
  private document: Document | null = null;
  private armed = false;
  private marked: readonly string[] = [];

  constructor(private readonly hooks: PickerHooks) {}

  /**
   * Take over a framed document.
   *
   * Called on arming and again on every frame load, because navigating inside the app replaces the
   * document — an in-frame location change and a fresh `src` come through the same hook, which is
   * what keeps re-attaching a single code path.
   */
  attach(document: Document): void {
    if (this.document === document) {
      this.paint();
      return;
    }
    this.detach();
    this.document = document;
    document.addEventListener('click', this.onClick, true);
    this.paint();
  }

  detach(): void {
    this.document?.removeEventListener('click', this.onClick, true);
    this.clearMarks();
    this.document = null;
  }

  /** Arm or disarm. Disarming leaves the marks: they say what is picked, not what is picking. */
  arm(armed: boolean): void {
    this.armed = armed;
  }

  /** Draw the store's picks inside the frame. Called whenever the store changes, in either direction. */
  mark(selectors: readonly string[]): void {
    this.marked = selectors;
    this.paint();
  }

  private readonly onClick = (event: Event): void => {
    if (!this.armed) {
      return;
    }
    const target = event.target as Element | null;
    if (!target || !this.document) {
      return;
    }
    // Capture phase, and stopped here: the click was for the picker, not for the app under it.
    event.preventDefault();
    event.stopPropagation();

    const mouse = event as MouseEvent;
    const attribution = attributionFor(target, this.hooks.map());
    this.hooks.picked({
      tag: target.tagName.toLowerCase(),
      selector: selectorFor(target),
      textPreview: (target.textContent ?? '').trim().slice(0, 160),
      route: this.hooks.route(),
      componentName: attribution?.className ?? null,
      sourceFiles: attribution?.sourceFiles ?? [],
      keepPicking: mouse.shiftKey === true,
    });
  };

  /** Put the outline on what is picked and take it off everything else. */
  private paint(): void {
    const document = this.document;
    if (!document) {
      return;
    }
    this.clearMarks();
    for (const selector of this.marked) {
      let element: HTMLElement | null = null;
      try {
        element = document.querySelector<HTMLElement>(selector);
      } catch {
        // A selector the frame's document cannot parse names nothing here. Skip it.
      }
      // **Not `instanceof HTMLElement`.** The frame is a separate realm with its own class objects,
      // so an element from inside it fails that check against this window's — the classic
      // cross-frame bug, and it would silently mark nothing at all.
      if (element?.style && element.dataset) {
        element.dataset['qitsPicked'] = 'true';
        element.style.setProperty('outline', MARK, 'important');
      }
    }
  }

  private clearMarks(): void {
    const document = this.document;
    if (!document) {
      return;
    }
    document.querySelectorAll<HTMLElement>('[data-qits-picked]').forEach((element) => {
      element.style.removeProperty('outline');
      delete element.dataset['qitsPicked'];
    });
  }
}
