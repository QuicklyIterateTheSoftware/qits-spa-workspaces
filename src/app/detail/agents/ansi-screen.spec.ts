import { AnsiScreen } from './ansi-screen';

const ESC = '\u001b';

/**
 * The terminal screen, in the terms a repainting TUI sets.
 *
 * The point of every case here is the same one: **an agent's TUI redraws rather than appends**, so a
 * screen that only concatenated output would show every frame stacked on the last one and look
 * broken from the first keystroke. What is asserted is that a redraw *replaces*.
 */
describe('AnsiScreen', () => {
  it('prints text and breaks lines on a line feed', () => {
    const screen = new AnsiScreen(20, 5);
    screen.write('first\r\nsecond');
    expect(screen.lines()).toEqual(['first', 'second']);
  });

  it('lets a carriage return overwrite the line, which is how a progress line works', () => {
    const screen = new AnsiScreen(20, 5);
    screen.write('working 1%\rworking 99%');
    expect(screen.lines()).toEqual(['working 99%']);
  });

  it('erases the display and repaints from the top, rather than stacking frames', () => {
    const screen = new AnsiScreen(20, 5);
    screen.write('old frame\r\nsecond line');
    screen.write(`${ESC}[2J${ESC}[Hnew frame`);
    expect(screen.lines()).toEqual(['new frame']);
  });

  it('addresses the cursor, so a redraw can rewrite one row in place', () => {
    const screen = new AnsiScreen(20, 5);
    screen.write('one\r\ntwo\r\nthree');
    screen.write(`${ESC}[2;1H${ESC}[KTWO`);
    expect(screen.lines()).toEqual(['one', 'TWO', 'three']);
  });

  it('drops colour rather than printing it', () => {
    const screen = new AnsiScreen(40, 5);
    screen.write(`${ESC}[33mThis command is no longer running.${ESC}[0m`);
    expect(screen.lines()).toEqual(['This command is no longer running.']);
  });

  it('holds an escape sequence split across two frames', () => {
    const screen = new AnsiScreen(20, 5);
    screen.write('a');
    screen.write(`${ESC}[`);
    // The rest of the erase arrives in the next frame, together with a home.
    screen.write(`2J${ESC}[H`);
    screen.write('b');
    // The erase took effect and nothing of the sequence was ever printed as text.
    expect(screen.lines()).toEqual(['b']);
  });

  it('keeps what scrolls off the top', () => {
    const screen = new AnsiScreen(20, 2);
    screen.write('one\r\ntwo\r\nthree');
    expect(screen.lines()).toEqual(['one', 'two', 'three']);
  });

  it('wraps at the right margin instead of losing the overflow', () => {
    const screen = new AnsiScreen(4, 3);
    screen.write('abcdef');
    expect(screen.lines()).toEqual(['abcd', 'ef']);
  });

  it('empties on reset, because a re-attach replays the whole screen', () => {
    const screen = new AnsiScreen(20, 5);
    screen.write('stale');
    screen.reset();
    expect(screen.lines()).toEqual([]);
  });

  it('backspaces over a character, which is what a typed correction sends', () => {
    const screen = new AnsiScreen(20, 5);
    screen.write('cat\b\bo');
    expect(screen.lines()).toEqual(['cot']);
  });
});
