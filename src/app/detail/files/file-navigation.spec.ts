import { closestMatch, formatRange, parseRange } from './file-navigation';

const PATHS = [
  'webui/src/app/app.ts',
  'webui/src/app/pages/home.ts',
  'webui/src/main.ts',
  'service/src/main/java/App.java',
];

/**
 * The arithmetic behind the two entry points.
 *
 * `lines` is hand-editable and arrives from other services, so an unreadable one has to cost the
 * highlight and never the file. And the closest match has to be *explainable*, because the user can
 * see the seeded filter and has to be able to agree with the answer — which is also why "nothing
 * plausible" is a real outcome rather than a nearest-neighbour guess.
 */
describe('the file deep link', () => {
  describe('the line range', () => {
    it('reads one line and a span', () => {
      expect(parseRange('12')).toEqual({ startLine: 12, endLine: 12 });
      expect(parseRange('12-20')).toEqual({ startLine: 12, endLine: 20 });
    });

    it('reads anything else as no anchor rather than as an error', () => {
      expect(parseRange(null)).toBeNull();
      expect(parseRange('')).toBeNull();
      expect(parseRange('20-12')).toBeNull();
      expect(parseRange('0')).toBeNull();
      expect(parseRange('nonsense')).toBeNull();
    });

    it('writes a single line without a redundant dash', () => {
      expect(formatRange({ startLine: 7, endLine: 7 })).toBe('7');
      expect(formatRange({ startLine: 7, endLine: 9 })).toBe('7-9');
    });
  });

  describe('the closest match', () => {
    it('takes an exact path immediately', () => {
      expect(closestMatch(PATHS, 'webui/src/main.ts')).toBe('webui/src/main.ts');
    });

    it('follows a rename by the deepest shared trailing run of segments', () => {
      expect(closestMatch(PATHS, 'webui/source/app/app.ts')).toBe('webui/src/app/app.ts');
    });

    it('prefers the deeper agreement when two files share a filename', () => {
      const candidates = ['a/pages/home.ts', 'b/widgets/home.ts'];
      expect(closestMatch(candidates, 'x/y/pages/home.ts')).toBe('a/pages/home.ts');
    });

    it('answers nothing when not even the filename agrees', () => {
      expect(closestMatch(PATHS, 'some/other/repository/thing.rs')).toBeNull();
      expect(closestMatch([], 'webui/src/main.ts')).toBeNull();
      expect(closestMatch(PATHS, '')).toBeNull();
    });
  });
});
