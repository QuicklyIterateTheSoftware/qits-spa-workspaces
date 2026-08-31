import { editorOrigin } from './editor-origin';

/**
 * The hand-off's address: `editor.<slug>.` in front of the environment origin THE PLATFORM STATES
 * — the navigation document's `origin`, the same statement every sidebar link composes against.
 *
 * These specs replaced two generations that blessed deriving the domain from this page's own
 * hostname (first dropping two labels — the first real click landed on `https://editor.qits.eu/`,
 * somebody else's domain — then one). The address is asked for now, never derived, so what is
 * pinned here is composition alone.
 */
describe('editorOrigin', () => {
  it('puts editor.<slug>. in front of the stated origin', () => {
    expect(editorOrigin('https://wohlben.eu', 'qits')).toBe('https://editor.qits.wohlben.eu/');
  });

  it('keeps the stated scheme and port — a plain-http platform hands off to plain http', () => {
    expect(editorOrigin('http://dev.localhost:8080', 'qits')).toBe(
      'http://editor.qits.dev.localhost:8080/',
    );
  });

  it('sends a reader to their own project, not to anything the origin names', () => {
    expect(editorOrigin('https://wohlben.eu', 'other')).toBe('https://editor.other.wohlben.eu/');
  });

  it('answers null while the platform has not stated an origin', () => {
    // The document not loaded yet, or `ng serve` with no edge in front. The page keeps waiting
    // rather than inventing an address.
    expect(editorOrigin(undefined, 'qits')).toBeNull();
    expect(editorOrigin('', 'qits')).toBeNull();
  });

  it('answers null for a statement that is not an origin', () => {
    expect(editorOrigin('not an origin', 'qits')).toBeNull();
  });

  it('answers null for an empty slug, which no address states', () => {
    expect(editorOrigin('https://wohlben.eu', '')).toBeNull();
  });
});
