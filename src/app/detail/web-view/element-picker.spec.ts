import type { ComponentMapDto } from '../../api/component-map-api';
import { ElementPicker, attributionFor, selectorFor, type FramePick } from './element-picker';

const MAP: ComponentMapDto = {
  framework: 'angular',
  components: [
    {
      className: 'GreetingComponent',
      componentFile: 'webui/src/app/greeting.ts',
      templateFile: 'webui/src/app/greeting.html',
      styleFiles: ['webui/src/app/greeting.css'],
      selectors: [{ element: 'app-greeting' }],
    },
    {
      className: 'HighlightDirective',
      componentFile: 'webui/src/app/highlight.ts',
      styleFiles: [],
      selectors: [{ attribute: 'appHighlight' }],
    },
  ],
};

/** A document standing in for the framed app. Same origin is the whole precondition. */
function framed(html: string): Document {
  const document = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  return document;
}

/**
 * The element picker.
 *
 * The behaviours worth pinning are the ones that make the frame **usable while it is armed**: a
 * plain pick is one-shot, shift keeps picking, and attribution walks *up* — a click lands on the
 * deepest node under the cursor, and the useful answer is the nearest ancestor that has a source
 * file. Attribution that cannot be made is skipped rather than guessed, because the map is a fact
 * about the tree as it was when the picker was armed.
 */
describe('the element picker', () => {
  describe('the selector', () => {
    it('takes an id outright, because it is the shortest true answer', () => {
      const document = framed('<div id="root"><span>hi</span></div>');
      expect(selectorFor(document.querySelector('#root')!)).toBe('#root');
    });

    it('builds a positional path when there is no id', () => {
      const document = framed('<div><p>one</p><p><em>two</em></p></div>');
      const selector = selectorFor(document.querySelector('em')!);
      expect(selector).toContain('em:nth-child(1)');
      expect(document.querySelector(selector)).toBe(document.querySelector('em'));
    });

    it('stops at the nearest id rather than walking to the body', () => {
      const document = framed('<main id="app"><ul><li>a</li><li>b</li></ul></main>');
      const selector = selectorFor(document.querySelectorAll('li')[1]);
      expect(selector.startsWith('#app')).toBe(true);
      expect(document.querySelector(selector)).toBe(document.querySelectorAll('li')[1]);
    });
  });

  describe('the attribution', () => {
    it('walks up to the component that owns the clicked node', () => {
      const document = framed('<app-greeting><button><span>Go</span></button></app-greeting>');
      const found = attributionFor(document.querySelector('span')!, MAP);
      expect(found?.className).toBe('GreetingComponent');
      expect(found?.sourceFiles).toEqual([
        'webui/src/app/greeting.ts',
        'webui/src/app/greeting.html',
        'webui/src/app/greeting.css',
      ]);
    });

    it('matches an attribute selector as well as an element one', () => {
      const document = framed('<div appHighlight><span>text</span></div>');
      expect(attributionFor(document.querySelector('span')!, MAP)?.className).toBe(
        'HighlightDirective',
      );
    });

    it('skips attribution rather than guessing when the map does not know the tree', () => {
      const document = framed('<div><span>text</span></div>');
      expect(attributionFor(document.querySelector('span')!, MAP)).toBeNull();
      expect(attributionFor(document.querySelector('span')!, null)).toBeNull();
    });
  });

  describe('the picking', () => {
    let picks: FramePick[];
    let picker: ElementPicker;
    let document: Document;

    beforeEach(() => {
      picks = [];
      document = framed('<app-greeting><button id="go">Go</button></app-greeting>');
      picker = new ElementPicker({
        route: () => '/orders/17',
        map: () => MAP,
        picked: (pick) => picks.push(pick),
      });
      picker.attach(document);
    });

    afterEach(() => picker.detach());

    const click = (selector: string, shiftKey = false) =>
      document
        .querySelector(selector)!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey, cancelable: true }));

    it('captures nothing until it is armed, so the app stays usable', () => {
      click('#go');
      expect(picks).toEqual([]);
    });

    it('captures the element, its route and its component when armed', () => {
      picker.arm(true);
      click('#go');
      expect(picks).toHaveLength(1);
      expect(picks[0].tag).toBe('button');
      expect(picks[0].selector).toBe('#go');
      expect(picks[0].textPreview).toBe('Go');
      expect(picks[0].route).toBe('/orders/17');
      expect(picks[0].componentName).toBe('GreetingComponent');
      expect(picks[0].keepPicking).toBe(false);
    });

    it('reports that shift means keep picking', () => {
      picker.arm(true);
      click('#go', true);
      expect(picks[0].keepPicking).toBe(true);
    });

    it('swallows the click so the framed app does not act on it', () => {
      picker.arm(true);
      const event = new MouseEvent('click', { bubbles: true, cancelable: true });
      document.querySelector('#go')!.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });

    it('marks what the store holds, and unmarks what it drops', () => {
      // The mark is read back off the attribute rather than the style: the style is the framed
      // app's to overwrite, and jsdom does not round-trip the `outline` shorthand anyway.
      picker.mark(['#go']);
      const button = document.querySelector<HTMLElement>('#go')!;
      expect(button.dataset['qitsPicked']).toBe('true');

      picker.mark([]);
      expect(button.dataset['qitsPicked']).toBeUndefined();
    });

    it('survives a selector the framed document cannot parse', () => {
      expect(() => picker.mark(['>>> not a selector'])).not.toThrow();
    });
  });
});
