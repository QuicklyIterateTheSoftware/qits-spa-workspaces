import { editorOrigin } from './editor-origin';

/**
 * The hand-off's address, derived from the one the reader is already on.
 *
 * The rule is "drop this application's label and this project's, keep the rest": what is left is
 * the environment's domain, which is the only part of the address this page must not invent. A
 * configured base would be a second statement of it — one a `dev` deployment could hold pointing at
 * production — so the derivation is the whole contract and these are its edges.
 */
describe('editorOrigin', () => {
  it('keeps the environment and the domain, and replaces the first two labels', () => {
    expect(editorOrigin('workspaces.qits.dev.wohlben.eu', 'qits')).toBe(
      'https://editor.qits.dev.wohlben.eu/',
    );
  });

  it('sends a reader to their own project, not to the one the host names', () => {
    // The slug comes from the scope: `/other/editor` served on qits' host is other's editor.
    expect(editorOrigin('workspaces.qits.dev.wohlben.eu', 'other')).toBe(
      'https://editor.other.dev.wohlben.eu/',
    );
  });

  it('leaves a one-label domain alone rather than treating it as too short', () => {
    expect(editorOrigin('workspaces.qits.localhost', 'qits')).toBe(
      'https://editor.qits.localhost/',
    );
  });

  it('answers null where there is no domain left to keep', () => {
    // `ng serve` with no gateway in front. There is nothing to derive, and inventing one would
    // send a reader to `https://editor.qits./`.
    expect(editorOrigin('localhost', 'qits')).toBeNull();
    expect(editorOrigin('workspaces.localhost', 'qits')).toBeNull();
  });

  it('answers null for an empty slug, which no address states', () => {
    expect(editorOrigin('workspaces.qits.dev.wohlben.eu', '')).toBeNull();
  });
});
