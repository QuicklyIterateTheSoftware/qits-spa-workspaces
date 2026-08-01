import { Directive, TemplateRef, inject, input } from '@angular/core';

/**
 * One tab's content, declared where the page can see it and rendered where the host decides.
 *
 * A template rather than a component, because the latch-and-hide contract needs the host to own
 * *when* the content is created. `<ng-template appTabPanel="files">` is inert until the host renders
 * it, which is what makes "expensive panels initialise on first selection" the default rather than
 * something every panel has to remember.
 *
 * The templates are read in declaration order and rendered in declaration order, forever. That is
 * the second of the two loops: the tab strip renders the user's order, this renders the document's,
 * and the gap between them is why dragging a tab cannot reload an iframe or reset a scroll position.
 */
@Directive({ selector: '[appTabPanel]' })
export class TabPanel {
  /**
   * Which tab this is the content of. Matches a {@link ./tabs#TabDef.slug}.
   *
   * Declared with an empty default rather than as required, and the reason is timing rather than
   * taste: the host latches inside an `effect`, and a content child's inputs are not bound when the
   * host's effects first run — a required input read there throws before anything has gone wrong.
   * The empty string is therefore "not bound yet", and the host skips it, which costs one extra
   * change-detection pass on the first render and nothing after that.
   */
  readonly appTabPanel = input('');

  readonly template = inject<TemplateRef<unknown>>(TemplateRef);
}
