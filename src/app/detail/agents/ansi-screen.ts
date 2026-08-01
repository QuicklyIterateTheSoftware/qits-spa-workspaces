/**
 * A small terminal screen: enough of VT100 to read an agent's TUI, and no more.
 *
 * ## Why this exists instead of xterm.js
 *
 * The plan names xterm.js behind an `@defer` for exactly this surface. It is a dependency, and a
 * dependency is a lockfile change — which this workstream does not make, because the lockfile's
 * `integrity` is a fact about tarball bytes and a bump has to run where the registry is reachable.
 * So the embedded session ships with **this**: a grid, a cursor, and the handful of sequences a
 * full-screen redraw actually uses.
 *
 * **What it does:** the cursor moves (`CUU`/`CUD`/`CUF`/`CUB`/`CUP`/`CHA`/`VPA`), the screen and the
 * line erase (`ED`/`EL`), carriage return, line feed, backspace and tab, wrap at the right margin,
 * and scrollback for everything that leaves the top. That is what makes a repainting TUI legible
 * rather than a wall of stacked frames — which is what appending raw output would produce, and the
 * reason a naive terminal looks broken on the first redraw.
 *
 * **What it does not do, said plainly:** colour and every other `SGR` attribute is parsed and
 * dropped, so the screen is monochrome; there is no alternate buffer, no scroll region, no mouse
 * reporting and no wide-character accounting. Adding xterm.js later replaces this file and changes
 * nothing else — {@link ./terminal-socket#TerminalSocket} hands it bytes and reads back lines.
 *
 * ## Chunk boundaries are not sequence boundaries
 *
 * An escape sequence can be split across two socket frames, and a half-parsed `ESC [` rendered as
 * text is the kind of bug that only appears under load. Anything incomplete at the end of a write is
 * held and prepended to the next one.
 */

/** How many lines that have scrolled off the top are kept. The daemon replays 256 KB; this bounds it. */
export const SCROLLBACK_LINES = 600;

/** The default grid. A PTY has to be told a size, and something has to be the answer before layout. */
export const DEFAULT_COLS = 100;
export const DEFAULT_ROWS = 30;

const ESC = '\u001b';

export class AnsiScreen {
  private grid: string[][] = [];
  private scrollback: string[] = [];
  private row = 0;
  private col = 0;

  /** An escape sequence cut in half by a frame boundary, waiting for the rest of itself. */
  private partial = '';

  constructor(
    private cols: number = DEFAULT_COLS,
    private rows: number = DEFAULT_ROWS,
  ) {
    this.reset();
  }

  /** Empty everything. Called on every re-attach, because the replay repaints the screen. */
  reset(): void {
    this.grid = Array.from({ length: this.rows }, () => this.blankRow());
    this.scrollback = [];
    this.row = 0;
    this.col = 0;
    this.partial = '';
  }

  /** Change the grid size. The content is kept as-is; the next repaint is what fixes it up. */
  resize(cols: number, rows: number): void {
    if (cols === this.cols && rows === this.rows) {
      return;
    }
    this.cols = Math.max(1, cols);
    this.rows = Math.max(1, rows);
    this.reset();
  }

  /** The screen as text: what scrolled off, then the grid, with trailing blank lines dropped. */
  lines(): readonly string[] {
    const body = this.grid.map((line) => line.join('').replace(/\s+$/, ''));
    while (body.length > 0 && body[body.length - 1] === '') {
      body.pop();
    }
    return [...this.scrollback, ...body];
  }

  /** Feed raw PTY text. */
  write(text: string): void {
    const input = this.partial + text;
    this.partial = '';
    let at = 0;
    while (at < input.length) {
      const char = input[at];
      if (char === ESC) {
        const consumed = this.escape(input, at);
        if (consumed === -1) {
          // The rest of this sequence is in the next frame. Hold it rather than printing `ESC[`.
          this.partial = input.slice(at);
          return;
        }
        at += consumed;
        continue;
      }
      at += 1;
      this.control(char);
    }
  }

  // ---- the parser ------------------------------------------------------------------------------

  /** How many characters the sequence at `at` consumed, or -1 when it is not all here yet. */
  private escape(input: string, at: number): number {
    const next = input[at + 1];
    if (next === undefined) {
      return -1;
    }
    if (next === '[') {
      let end = at + 2;
      while (end < input.length && !isFinalByte(input[end])) {
        end += 1;
      }
      if (end >= input.length) {
        return -1;
      }
      this.csi(input.slice(at + 2, end), input[end]);
      return end - at + 1;
    }
    if (next === ']') {
      // An operating-system command — a window title, usually. It ends at BEL or at ESC \.
      const bell = input.indexOf('\u0007', at + 2);
      const terminator = input.indexOf(`${ESC}\\`, at + 2);
      if (bell === -1 && terminator === -1) {
        return -1;
      }
      const end =
        bell === -1 ? terminator + 1 : terminator === -1 ? bell : Math.min(bell, terminator + 1);
      return end - at + 1;
    }
    if (next === '(' || next === ')' || next === '#') {
      // A character-set or line-attribute selection: one more byte, and nothing this screen models.
      return input[at + 2] === undefined ? -1 : 3;
    }
    if (next === 'M') {
      this.reverseFeed();
      return 2;
    }
    // Anything else is a two-byte escape this screen has no opinion about.
    return 2;
  }

  private csi(params: string, final: string): void {
    // A private-mode sequence (`ESC [ ? 25 l`) is a setting, never a movement. Dropped whole.
    if (params.startsWith('?')) {
      return;
    }
    const numbers = params
      .split(';')
      .map((value) => (value === '' ? 0 : Number(value)))
      .map((value) => (Number.isFinite(value) ? value : 0));
    const first = numbers[0] ?? 0;
    switch (final) {
      case 'A':
        this.row = Math.max(0, this.row - Math.max(1, first));
        break;
      case 'B':
        this.row = Math.min(this.rows - 1, this.row + Math.max(1, first));
        break;
      case 'C':
        this.col = Math.min(this.cols - 1, this.col + Math.max(1, first));
        break;
      case 'D':
        this.col = Math.max(0, this.col - Math.max(1, first));
        break;
      case 'G':
        this.col = clamp(Math.max(1, first) - 1, this.cols);
        break;
      case 'd':
        this.row = clamp(Math.max(1, first) - 1, this.rows);
        break;
      case 'H':
      case 'f':
        this.row = clamp(Math.max(1, numbers[0] || 1) - 1, this.rows);
        this.col = clamp(Math.max(1, numbers[1] || 1) - 1, this.cols);
        break;
      case 'J':
        this.eraseDisplay(first);
        break;
      case 'K':
        this.eraseLine(first);
        break;
      default:
        // `m` and every other attribute, mode or report. Parsed so it cannot print, then dropped.
        break;
    }
  }

  private control(char: string): void {
    switch (char) {
      case '\n':
        this.lineFeed();
        return;
      case '\r':
        this.col = 0;
        return;
      case '\b':
        this.col = Math.max(0, this.col - 1);
        return;
      case '\t':
        this.col = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8);
        return;
      case '\u0007':
      case '\u000e':
      case '\u000f':
        return;
      default:
        break;
    }
    if (char < ' ') {
      return;
    }
    if (this.col >= this.cols) {
      this.col = 0;
      this.lineFeed();
    }
    this.grid[this.row][this.col] = char;
    this.col += 1;
  }

  // ---- the grid --------------------------------------------------------------------------------

  private lineFeed(): void {
    if (this.row < this.rows - 1) {
      this.row += 1;
      return;
    }
    const leaving = this.grid.shift();
    if (leaving) {
      this.scrollback.push(leaving.join('').replace(/\s+$/, ''));
      if (this.scrollback.length > SCROLLBACK_LINES) {
        this.scrollback.splice(0, this.scrollback.length - SCROLLBACK_LINES);
      }
    }
    this.grid.push(this.blankRow());
  }

  private reverseFeed(): void {
    if (this.row > 0) {
      this.row -= 1;
      return;
    }
    this.grid.pop();
    this.grid.unshift(this.blankRow());
  }

  private eraseDisplay(mode: number): void {
    if (mode === 0) {
      this.eraseLine(0);
      for (let row = this.row + 1; row < this.rows; row += 1) {
        this.grid[row] = this.blankRow();
      }
      return;
    }
    if (mode === 1) {
      this.eraseLine(1);
      for (let row = 0; row < this.row; row += 1) {
        this.grid[row] = this.blankRow();
      }
      return;
    }
    this.grid = Array.from({ length: this.rows }, () => this.blankRow());
  }

  private eraseLine(mode: number): void {
    const line = this.grid[this.row];
    const from = mode === 1 ? 0 : this.col;
    const to = mode === 0 ? this.cols : mode === 1 ? this.col + 1 : this.cols;
    for (let at = from; at < to && at < this.cols; at += 1) {
      line[at] = ' ';
    }
  }

  private blankRow(): string[] {
    return Array.from({ length: this.cols }, () => ' ');
  }
}

function isFinalByte(char: string): boolean {
  return char >= '@' && char <= '~';
}

function clamp(value: number, limit: number): number {
  return Math.max(0, Math.min(limit - 1, value));
}
