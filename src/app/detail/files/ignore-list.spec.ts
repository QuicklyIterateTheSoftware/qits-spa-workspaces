import { isShown, type FilterLayers } from './filter-rules';
import { ignoreLayer, ignoreSources, parseIgnoreFile } from './ignore-list';

const PATHS = [
  '.gitignore',
  '.dockerignore',
  'README.md',
  'build.log',
  'webui/.gitignore',
  'webui/keep.log',
  'webui/src/main.ts',
  'webui/dist/bundle.js',
  'service/target/App.class',
  'service/src/main/java/App.java',
];

function layered(rules: ReturnType<typeof ignoreLayer>): FilterLayers {
  return { defaultHidden: false, framework: [], ignoreList: rules, manual: [] };
}

/**
 * The ignore-list dynamic filter.
 *
 * Calling something a `.gitignore` rule and then matching it differently is worse than not offering
 * the feature at all, so the semantics are asserted against the ones the file's own format has: a
 * pattern with no slash floats to any depth, a trailing slash means "what is under this", a leading
 * slash anchors, and a `!` brings something back.
 *
 * The two properties that are easiest to get wrong are the two that are asserted hardest: **locality
 * scoping** (a nested file's rules never reach a sibling) and **shallow to deep** (the nearest file
 * has the last word, which only works because the layer order feeds last-match-wins).
 */
describe('the ignore lists', () => {
  describe('finding the files', () => {
    it('collects every file with the chosen basename, shallowest first', () => {
      expect(ignoreSources(PATHS, '.gitignore')).toEqual([
        { path: '.gitignore', scope: '' },
        { path: 'webui/.gitignore', scope: 'webui' },
      ]);
    });

    it('ignores the other basename entirely, because they answer different questions', () => {
      expect(ignoreSources(PATHS, '.dockerignore').map((source) => source.path)).toEqual([
        '.dockerignore',
      ]);
    });
  });

  describe('reading one file', () => {
    it('skips blanks and comments', () => {
      expect(parseIgnoreFile('', '\n# a comment\n\n*.log\n').length).toBe(1);
    });

    it('floats a pattern with no slash to any depth', () => {
      const layers = layered(parseIgnoreFile('', '*.log\n'));

      expect(isShown('build.log', layers)).toBe(false);
      expect(isShown('webui/keep.log', layers)).toBe(false);
      expect(isShown('README.md', layers)).toBe(true);
    });

    it('anchors a pattern that starts with a slash', () => {
      const layers = layered(parseIgnoreFile('', '/build.log\n'));

      expect(isShown('build.log', layers)).toBe(false);
      expect(isShown('webui/build.log', layers)).toBe(true);
    });

    it('reads a trailing slash as a directory, so it hides what is under it and not the name', () => {
      const layers = layered(parseIgnoreFile('', 'dist/\n'));

      expect(isShown('webui/dist/bundle.js', layers)).toBe(false);
      expect(isShown('webui/dist', layers)).toBe(true);
    });

    it('stops a single star at a slash and lets a double star cross one', () => {
      expect(isShown('webui/src/main.ts', layered(parseIgnoreFile('', 'webui/*.ts\n')))).toBe(true);
      expect(isShown('webui/src/main.ts', layered(parseIgnoreFile('', 'webui/**/*.ts\n')))).toBe(
        false,
      );
    });

    it('turns a negation into the show that resurrects', () => {
      const layers = layered(parseIgnoreFile('', '*.log\n!keep.log\n'));

      expect(isShown('build.log', layers)).toBe(false);
      expect(isShown('webui/keep.log', layers)).toBe(true);
    });
  });

  describe('the whole layer', () => {
    const contents = new Map([
      ['.gitignore', '*.log\n'],
      ['webui/.gitignore', '!keep.log\n'],
    ]);

    it('scopes a nested file to its own directory', () => {
      const layers = layered(ignoreLayer(ignoreSources(PATHS, '.gitignore'), contents));

      // The nested negation reached inside `webui/` and nowhere else.
      expect(isShown('webui/keep.log', layers)).toBe(true);
      expect(isShown('build.log', layers)).toBe(false);
    });

    it('gives the deeper file the last word, which is what the shallow-to-deep order buys', () => {
      const reversed = ignoreLayer([...ignoreSources(PATHS, '.gitignore')].reverse(), contents);

      // Reversed, the root's `*.log` runs last and wins — the very outcome the ordering prevents.
      expect(isShown('webui/keep.log', layered(reversed))).toBe(false);
    });

    it('contributes nothing for a file whose content has not landed', () => {
      expect(ignoreLayer(ignoreSources(PATHS, '.gitignore'), new Map()).length).toBe(0);
    });
  });
});
