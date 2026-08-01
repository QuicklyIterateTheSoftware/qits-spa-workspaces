import {
  NO_LAYERS,
  PREVIEW_LIMIT,
  compile,
  compileAll,
  frameworkWhitelist,
  hideSet,
  isShown,
  matchesKind,
  narrows,
  orderedRules,
  previewOf,
  stem,
  type FilterLayers,
  type FilterRule,
} from './filter-rules';

const PATHS = [
  'README.md',
  'webui/src/main.ts',
  'webui/src/app/app.ts',
  'webui/src/app/app.spec.ts',
  'service/src/main/java/App.java',
];

function rule(over: Partial<FilterRule>): FilterRule {
  return { id: 'r', kind: 'fuzzy', query: '', mode: 'hide', enabled: true, ...over };
}

/**
 * The evaluator, as arithmetic.
 *
 * Two properties carry the whole feature and both are invisible from a screenshot: **last match
 * wins** within the list, and the **fixed framework → ignore-list → manual order** between the
 * layers. A build that got either backwards would still draw a tree, still narrow it, and still look
 * entirely reasonable.
 */
describe('the filter rules', () => {
  describe('last match wins', () => {
    it('lets a later rule overturn an earlier one', () => {
      const layers: FilterLayers = {
        ...NO_LAYERS,
        manual: compileAll([
          rule({ id: 'a', kind: 'includes', query: '.ts', mode: 'hide' }),
          rule({ id: 'b', kind: 'exact', query: 'main.ts', mode: 'show' }),
        ]),
      };

      expect(isShown('webui/src/main.ts', layers)).toBe(true);
      expect(isShown('webui/src/app/app.ts', layers)).toBe(false);
    });

    it('reverses when the same two rules are reordered — which is why they are a list', () => {
      const layers: FilterLayers = {
        ...NO_LAYERS,
        manual: compileAll([
          rule({ id: 'b', kind: 'exact', query: 'main.ts', mode: 'show' }),
          rule({ id: 'a', kind: 'includes', query: '.ts', mode: 'hide' }),
        ]),
      };

      expect(isShown('webui/src/main.ts', layers)).toBe(false);
    });

    it('drops a disabled or blank rule from the evaluation but not from the list', () => {
      expect(compile(rule({ enabled: false, query: 'x' }))).toBeNull();
      expect(compile(rule({ query: '   ' }))).toBeNull();
      expect(compileAll([rule({ query: 'x' }), rule({ enabled: false, query: 'y' })]).length).toBe(
        1,
      );
    });
  });

  /**
   * The precedence, asserted as the guarantee it exists to make: **a manual `show` can always
   * resurrect a file something else hid.** Nothing else distinguishes this order from the others.
   */
  describe('the fixed layer order', () => {
    const layers: FilterLayers = {
      defaultHidden: true,
      framework: [frameworkWhitelist(new Set(['webui/src/main.ts']), 'Angular')],
      ignoreList: [hideSet(new Set(['webui/src/main.ts']), 'hide · .gitignore')],
      manual: compileAll([rule({ kind: 'exact', query: 'README.md', mode: 'show' })]),
    };

    it('puts the layers in one order and only one', () => {
      expect(orderedRules(layers).map((entry) => entry.label)).toEqual([
        'show · framework · Angular',
        'hide · .gitignore',
        'show · exact · README.md',
      ]);
    });

    it('starts hidden under a framework restriction and whitelists its members', () => {
      expect(isShown('service/src/main/java/App.java', layers)).toBe(false);
    });

    it('lets the ignore list take back what the framework let through', () => {
      const withoutManual: FilterLayers = { ...layers, manual: [] };
      expect(isShown('webui/src/main.ts', withoutManual)).toBe(false);
    });

    it('lets a manual show resurrect what both of the others hid', () => {
      expect(isShown('README.md', layers)).toBe(true);
    });

    it('says nothing narrows when nothing does', () => {
      expect(narrows(NO_LAYERS)).toBe(false);
      expect(narrows({ ...NO_LAYERS, defaultHidden: true })).toBe(true);
    });
  });

  describe('the match kinds', () => {
    it('matches the filename when the query has no slash, and the path when it has one', () => {
      expect(matchesKind('webui/src/main.ts', 'main.ts', 'exact')).toBe(true);
      expect(matchesKind('webui/src/main.ts', 'webui/src/main.ts', 'exact')).toBe(true);
      expect(matchesKind('webui/src/main.ts', 'webui/src', 'exact')).toBe(false);
      expect(matchesKind('webui/src/main.ts', 'webui/src', 'includes')).toBe(true);
    });

    it('reads fuzzy as a subsequence, which is what makes an abbreviation work', () => {
      expect(matchesKind('webui/src/app/app.spec.ts', 'aspec', 'fuzzy')).toBe(true);
      expect(matchesKind('webui/src/main.ts', 'zzz', 'fuzzy')).toBe(false);
    });

    it('takes the extension off a name for a tab label', () => {
      expect(stem('webui/src/app/app.spec.ts')).toBe('app');
      expect(stem('Makefile')).toBe('Makefile');
      expect(stem('.gitignore')).toBe('.gitignore');
    });
  });

  /**
   * The preview truncates its *printing* and never its *counting*. A preview that stopped counting
   * at the cap would answer "500" to the one question it exists to answer.
   */
  describe('the live preview', () => {
    it('counts everything and prints at most the cap', () => {
      const many = Array.from({ length: PREVIEW_LIMIT + 40 }, (_, at) => `src/file-${at}.ts`);

      const preview = previewOf(many, NO_LAYERS);

      expect(preview.total).toBe(PREVIEW_LIMIT + 40);
      expect(preview.paths.length).toBe(PREVIEW_LIMIT);
      expect(preview.truncated).toBe(true);
    });

    it('reflects the name box too, so it agrees with the tree beside it', () => {
      const preview = previewOf(PATHS, NO_LAYERS, '*.java');

      expect(preview.paths).toEqual(['service/src/main/java/App.java']);
      expect(preview.truncated).toBe(false);
    });
  });
});
