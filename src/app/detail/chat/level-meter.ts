import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * The input level, while recording.
 *
 * It looks like decoration and is a diagnostic: **a bar that stays flat while you speak means no
 * audio is reaching the page** — a muted device, the wrong default input, a permission granted to a
 * tab that is not this one. Without it, the only symptom of any of those is a transcript that never
 * grows, which reads as "the transcription service is broken" and sends you looking in the wrong
 * place. That is why it is not the part of the old flow to drop.
 *
 * Drawn as segments rather than a smooth bar so that "moving a little" is visible without staring,
 * and announced as a plain percentage so it is not only a visual signal.
 */
@Component({
  selector: 'app-level-meter',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="meter"
      role="meter"
      aria-label="Microphone input level"
      [attr.aria-valuenow]="percent()"
      aria-valuemin="0"
      aria-valuemax="100"
    >
      @for (segment of segments; track segment) {
        <span class="seg" [class.lit]="segment <= lit()"></span>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
    }
    .meter {
      display: flex;
      gap: 0.15rem;
      align-items: flex-end;
      height: 1.1rem;
    }
    .seg {
      display: block;
      width: 0.28rem;
      height: 100%;
      border-radius: 0.1rem;
      background: #e5e7eb;
      transition: background-color 60ms linear;
    }
    .seg.lit {
      background: #059669;
    }
    .seg.lit:nth-child(n + 13) {
      background: #d97706;
    }
    .seg.lit:nth-child(n + 15) {
      background: #b91c1c;
    }
  `,
})
export class LevelMeter {
  /** The most recent level, 0 to 1. */
  readonly level = input.required<number>();

  protected readonly segments = Array.from({ length: 16 }, (_, index) => index + 1);

  protected readonly lit = computed(() => Math.round(Math.min(1, Math.max(0, this.level())) * 16));

  protected readonly percent = computed(() =>
    Math.round(Math.min(1, Math.max(0, this.level())) * 100),
  );
}
