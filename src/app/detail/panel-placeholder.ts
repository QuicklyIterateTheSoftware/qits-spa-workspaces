import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * A tab that exists before its panel does.
 *
 * The shell ships first and on purpose: the route, the status strip, the activity bar, the live
 * channel and the tab contract are what every panel mounts into, and they are worth proving before
 * anything mounts. Each placeholder names the surface that is coming rather than drawing an empty
 * box, so the row is honest about being early instead of looking broken.
 *
 * It is a real panel as far as the host is concerned — created on first selection, then kept — which
 * is what makes the latch-and-hide contract observable from the day the shell lands.
 */
@Component({
  selector: 'app-panel-placeholder',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="title">{{ title() }}</p>
    <p class="note">{{ note() }}</p>
  `,
  styles: `
    :host {
      display: block;
      padding: 1.5rem 0;
    }
    .title {
      margin: 0;
      color: #374151;
      font-weight: 600;
    }
    .note {
      margin: 0.25rem 0 0;
      color: #6b7280;
      font-size: 0.9rem;
    }
  `,
})
export class PanelPlaceholder {
  readonly title = input.required<string>();
  readonly note = input.required<string>();
}
