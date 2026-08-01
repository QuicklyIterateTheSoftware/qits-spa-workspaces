import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  input,
  output,
  viewChild,
} from '@angular/core';

/**
 * The screen and the keyboard: a PTY you can read and type into.
 *
 * It renders what {@link ./ansi-screen#AnsiScreen} already resolved — the emulation is *not* here, so
 * swapping in xterm.js later replaces two files and touches nothing that resolves a session.
 *
 * **Keys are translated here, not on the socket**, because this is the only place that knows a
 * `KeyboardEvent`. The translation is the small standard one: Enter is a carriage return (a PTY in
 * canonical mode expects `\r`, and sending `\n` is the classic "my Enter does nothing" bug),
 * Backspace is DEL rather than BS, the arrows are their escape sequences, and `Ctrl`+letter is the
 * control character it names. Anything a browser handles better than a terminal — copy, paste, the
 * page's own shortcuts — is left alone rather than swallowed.
 */
@Component({
  selector: 'app-terminal-view',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      #screen
      class="screen"
      tabindex="0"
      role="textbox"
      aria-multiline="true"
      [attr.aria-label]="label()"
      (keydown)="onKey($event)"
      (paste)="onPaste($event)"
    >
      <pre>{{ text() }}</pre>
    </div>
    <p class="hint">{{ hint() }}</p>
  `,
  styles: `
    :host {
      display: block;
    }
    .screen {
      max-height: 26rem;
      overflow: auto;
      padding: 0.6rem 0.75rem;
      border: 1px solid #1f2937;
      border-radius: 0.375rem;
      background: #111827;
      color: #e5e7eb;
    }
    .screen:focus {
      outline: 2px solid #2563eb;
      outline-offset: 1px;
    }
    pre {
      margin: 0;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.8rem;
      line-height: 1.35;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .hint {
      margin: 0.35rem 0 0;
      color: #6b7280;
      font-size: 0.8rem;
    }
  `,
})
export class TerminalView {
  /** The screen, already emulated. */
  readonly lines = input.required<readonly string[]>();

  /** What a screen reader calls this terminal. */
  readonly label = input('Agent session');

  /** Whether keystrokes go anywhere. A detached terminal is readable and inert. */
  readonly attached = input(false);

  /** One keystroke, or one pasted run of text, as the bytes the PTY should receive. */
  readonly data = output<string>();

  private readonly screen = viewChild<ElementRef<HTMLElement>>('screen');

  protected readonly text = computed(() => this.lines().join('\n'));

  protected readonly hint = computed(() =>
    this.attached()
      ? 'Click the screen and type. Keystrokes go straight to the agent.'
      : 'Not attached — this is the last screen the session painted.',
  );

  constructor() {
    // Follow the tail, the way a terminal does. Reading the text is what makes this run on output.
    effect(() => {
      this.text();
      const element = this.screen()?.nativeElement;
      if (element) {
        element.scrollTop = element.scrollHeight;
      }
    });
  }

  protected onKey(event: KeyboardEvent): void {
    if (!this.attached()) {
      return;
    }
    const data = translate(event);
    if (data === null) {
      return;
    }
    event.preventDefault();
    this.data.emit(data);
  }

  protected onPaste(event: ClipboardEvent): void {
    if (!this.attached()) {
      return;
    }
    const text = event.clipboardData?.getData('text') ?? '';
    if (text) {
      event.preventDefault();
      this.data.emit(text);
    }
  }
}

/** The bytes a key means, or null for a key this terminal should not eat. */
function translate(event: KeyboardEvent): string | null {
  if (event.metaKey) {
    // Every meta chord on every platform belongs to the browser or the OS, never to the PTY.
    return null;
  }
  if (event.ctrlKey && event.key.length === 1) {
    const upper = event.key.toUpperCase();
    if (upper === 'V' || upper === 'C') {
      // Paste keeps its own handler; copy must keep working on a selected screen.
      return null;
    }
    const code = upper.charCodeAt(0);
    return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : null;
  }
  switch (event.key) {
    case 'Enter':
      return '\r';
    case 'Backspace':
      return '\u007f';
    case 'Tab':
      return '\t';
    case 'Escape':
      return '\u001b';
    case 'ArrowUp':
      return '\u001b[A';
    case 'ArrowDown':
      return '\u001b[B';
    case 'ArrowRight':
      return '\u001b[C';
    case 'ArrowLeft':
      return '\u001b[D';
    case 'Home':
      return '\u001b[H';
    case 'End':
      return '\u001b[F';
    case 'Delete':
      return '\u001b[3~';
    case 'PageUp':
      return '\u001b[5~';
    case 'PageDown':
      return '\u001b[6~';
    default:
      return event.key.length === 1 ? event.key : null;
  }
}
