import { editorOrigin } from './editor-origin';

/**
 * The hand-off's address, derived from the one the reader is already on.
 *
 * The rule is "drop this application's label, keep the rest": the public host is `<app>.<domain>`
 * (`workspaces.wohlben.eu` — the edge reads only the first label as the application), so what is
 * left after one label is the domain, which is the only part of the address this page must not
 * invent. These specs replaced a set that pinned a `<app>.<project>.<env>.<domain>` shape no
 * deployment serves — the drop-two derivation they blessed sent the first real reader to
 * `https://editor.qits.eu/`, somebody else's domain.
 */
describe('editorOrigin', () => {
  it('replaces the application label and keeps the domain', () => {
    expect(editorOrigin('workspaces.wohlben.eu', 'qits')).toBe('https://editor.qits.wohlben.eu/');
  });

  it('sends a reader to their own project, not to the one the host names', () => {
    // The slug comes from the scope: `/other/editor` served on the shared host is other's editor.
    expect(editorOrigin('workspaces.wohlben.eu', 'other')).toBe(
      'https://editor.other.wohlben.eu/',
    );
  });

  it('keeps whatever domain remains, an environment label included', () => {
    // An environment-labelled host is not a certified spelling for the editor (the certificate
    // carries `editor.<slug>.<domain>` alone), but the derivation stays honest about what it was
    // served on rather than guessing which label is an environment.
    expect(editorOrigin('workspaces.dev.wohlben.eu', 'qits')).toBe(
      'https://editor.qits.dev.wohlben.eu/',
    );
  });

  it('answers null where there is no domain left to keep', () => {
    // `ng serve` with no gateway in front. There is nothing to derive, and inventing one would
    // send a reader to `https://editor.qits./`.
    expect(editorOrigin('localhost', 'qits')).toBeNull();
  });

  it('answers null for an empty slug, which no address states', () => {
    expect(editorOrigin('workspaces.wohlben.eu', '')).toBeNull();
  });
});
