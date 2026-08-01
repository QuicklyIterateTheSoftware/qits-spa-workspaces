import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Async } from './async';
import { IDLE, LOADING, ready, type Loadable } from './loadable';

@Component({
  selector: 'app-async-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Async],
  template: `<app-async [state]="state()" errorLabel="Could not load the page" />`,
})
class AsyncHost {
  readonly state = signal<Loadable<unknown>>(IDLE);
}

const failure = (message: string): Loadable<never> => ({ kind: 'error', status: 502, message });

/**
 * The shared waiting/failed strip.
 *
 * The assertion that matters is the punctuation, and it is not cosmetic pedantry: the messages come
 * from two sources with different habits — bare fragments from `describeError`, whole sentences
 * from a service's `{"message": …}` envelope — and the template used to end the line with a literal
 * full stop regardless, so every written message rendered "..". One place ends the sentence now,
 * and the test is what keeps the stop from being typed back into the template.
 */
describe('Async', () => {
  const render = (state: Loadable<unknown>) => {
    const fixture = TestBed.createComponent(AsyncHost);
    fixture.componentInstance.state.set(state);
    fixture.detectChanges();
    return ((fixture.nativeElement as HTMLElement).textContent ?? '').trim();
  };

  it('draws nothing at all when there is nothing to wait for or explain', () => {
    expect(render(IDLE)).toBe('');
    expect(render(ready([]))).toBe('');
  });

  it('announces the wait to a screen reader while loading', () => {
    expect(render(LOADING)).toContain('Loading');
  });

  it('ends a bare fragment with a full stop', () => {
    expect(render(failure('the service is unreachable'))).toContain(
      'Could not load the page — the service is unreachable.',
    );
  });

  it('does not add a second full stop to a message that already ends', () => {
    const text = render(failure('502 The container is not running.'));
    expect(text).toContain('502 The container is not running.');
    expect(text).not.toContain('..');
  });

  it('leaves an ellipsis, a question and an exclamation as the writer ended them', () => {
    expect(render(failure('who?'))).not.toContain('?.');
    expect(render(failure('gone!'))).not.toContain('!.');
    expect(render(failure('still starting…'))).not.toContain('….');
  });

  it('offers a way back out of the failure', () => {
    const fixture = TestBed.createComponent(AsyncHost);
    fixture.componentInstance.state.set(failure('502'));
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('Retry');
    expect(element.querySelector('[role="alert"]')).not.toBeNull();
  });
});
