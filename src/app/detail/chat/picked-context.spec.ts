import { TestBed } from '@angular/core/testing';
import {
  PickedContext,
  parseComposition,
  referenceLabel,
  referenceText,
  serializePrompt,
  type CodeReference,
  type PickedElement,
} from './picked-context';

const REFERENCE: CodeReference = {
  path: 'src/main.ts',
  startLine: 10,
  endLine: 14,
  excerpt: 'bootstrapApplication(App);',
};

const ELEMENT: PickedElement = {
  tag: 'button',
  selector: 'app-home > button.primary',
  textPreview: 'Save',
  route: '/settings',
  componentName: 'HomePage',
  sourceFiles: ['src/app/home.ts'],
};

/**
 * The seam between the two pickers and the one prompt panel.
 *
 * The Files viewer and the Web view land in later workstreams and write here; the panel reads. The
 * picks are work product, so they ride the prompt draft rather than the browser — which is why the
 * blob's schema is the client's own and has to survive being written by an older build.
 */
describe('PickedContext', () => {
  let picked: PickedContext;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    picked = TestBed.inject(PickedContext);
  });

  it('empties itself when the workspace under it changes', () => {
    // A line range in one workspace's file means nothing in another's.
    picked.use(7);
    picked.addReference(REFERENCE);
    expect(picked.any()).toBe(true);

    picked.use(8);
    expect(picked.any()).toBe(false);
  });

  it('keeps one entry when the same range is picked twice', () => {
    picked.use(7);
    picked.addReference(REFERENCE);
    picked.addReference({ ...REFERENCE, excerpt: 'different excerpt' });
    expect(picked.references()).toHaveLength(1);
  });

  it('unpicks an element that is picked again, as the frame’s own toggle does', () => {
    picked.use(7);
    picked.toggleElement(ELEMENT);
    expect(picked.elements()).toHaveLength(1);

    picked.toggleElement(ELEMENT);
    expect(picked.elements()).toHaveLength(0);
  });

  it('removes a reference by its label', () => {
    picked.use(7);
    picked.addReference(REFERENCE);
    picked.removeReference('src/main.ts:10-14');
    expect(picked.references()).toHaveLength(0);
  });
});

describe('referenceLabel', () => {
  it('writes a range, and a single line without one', () => {
    expect(referenceLabel(REFERENCE)).toBe('src/main.ts:10-14');
    expect(referenceLabel({ ...REFERENCE, endLine: 10 })).toBe('src/main.ts:10');
  });
});

describe('parseComposition', () => {
  it('reads what was written', () => {
    const blob = JSON.stringify({ text: 'hello', references: [REFERENCE], elements: [ELEMENT] });
    expect(parseComposition(blob)).toEqual({
      text: 'hello',
      references: [REFERENCE],
      elements: [ELEMENT],
    });
  });

  it('degrades to an empty composition rather than throwing on a blob it cannot read', () => {
    // The host validates only that the blob is JSON. A blob from an older build, or from a hand,
    // has to be no worse than "no draft".
    expect(parseComposition('not json')).toEqual({ text: '', references: [], elements: [] });
    expect(parseComposition('[]')).toEqual({ text: '', references: [], elements: [] });
    expect(parseComposition('{"text":42}')).toEqual({ text: '', references: [], elements: [] });
  });
});

describe('serializePrompt', () => {
  it('is the typed text when nothing was picked', () => {
    expect(serializePrompt({ text: 'do the thing', references: [], elements: [] })).toBe(
      'do the thing',
    );
  });

  it('appends a pick the user never inserted, so the chips do not lie', () => {
    const prompt = serializePrompt({ text: 'fix this', references: [REFERENCE], elements: [] });

    expect(prompt).toContain('fix this');
    expect(prompt).toContain('Context picked in the workspace');
    expect(prompt).toContain('src/main.ts:10-14');
  });

  it('does not append a pick that is already in the text', () => {
    const text = `look at ${referenceText(REFERENCE)}`;
    const prompt = serializePrompt({ text, references: [REFERENCE], elements: [] });

    expect(prompt).toBe(text);
    expect(prompt).not.toContain('Context picked in the workspace');
  });

  it('is empty when there is nothing to say, so an empty draft cannot be launched', () => {
    expect(serializePrompt({ text: '   ', references: [], elements: [] })).toBe('');
  });
});
