import { ChangeDetectionStrategy, Component, forwardRef, input } from '@angular/core';
import { TOOL_RESULT_LIMIT, summarise, type ChatItem } from './chat-model';

/**
 * The conversation, drawn.
 *
 * Every item is a typed thing rather than a blob of markdown, because the six kinds want six
 * different amounts of attention: assistant text is the thing you read, thinking and tool traffic
 * are the thing you *can* read, and an error is the thing you cannot miss. Collapsed by default
 * where the content is machinery — a tool call, a tool result, a sub-agent's whole side-chain — and
 * open where it is the answer.
 *
 * Rendering is deliberately plain text. Markdown is a named fast-follow behind the same `@defer` the
 * code viewer's highlighter sits behind; a monospace pane that never lies about what the agent said
 * is the load-bearing ninety percent.
 */
@Component({
  selector: 'app-conversation',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // A side-chain's contents are the same six kinds, so the template renders itself. The forwardRef
  // is the only way to name a class inside its own decorator; the recursion terminates because the
  // parser hoists every anchor to the top level, so a side-chain never holds another one.
  imports: [forwardRef(() => Conversation)],
  template: `
    @for (item of items(); track $index) {
      @switch (item.kind) {
        @case ('user') {
          <article class="turn user">
            <p class="who">You</p>
            <pre>{{ item.text }}</pre>
          </article>
        }
        @case ('assistant') {
          <article class="turn agent">
            <pre>{{ item.text }}</pre>
          </article>
        }
        @case ('thinking') {
          <details class="fold thinking">
            <summary>Thinking</summary>
            <pre>{{ item.text }}</pre>
          </details>
        }
        @case ('tool-call') {
          <details class="fold tool">
            <summary>
              <span class="name">{{ item.name }}</span>
              <span class="hint">{{ brief(item.input) }}</span>
            </summary>
            <pre>{{ item.input }}</pre>
          </details>
        }
        @case ('tool-result') {
          <details class="fold result" [class.failed]="item.isError">
            <summary>{{ item.isError ? 'Tool failed' : 'Tool result' }}</summary>
            <pre>{{ item.text }}</pre>
            @if (item.truncatedFrom) {
              <p class="cut">
                Shown to {{ limit }} characters of {{ item.truncatedFrom }} — the rest is in the
                command's log.
              </p>
            }
          </details>
        }
        @case ('error') {
          <p class="failure" role="alert">⚠ {{ item.text }}</p>
        }
        @case ('side-chain') {
          <details class="fold chain" [class.unplaced]="!item.anchored">
            <summary>
              <span class="name">Sub-agent{{ item.agentType ? ': ' + item.agentType : '' }}</span>
              @if (item.description) {
                <span class="hint">{{ item.description }}</span>
              }
            </summary>
            @if (!item.anchored) {
              <p class="cut">
                The tool call that started this one is no longer in the conversation, so it is shown
                here rather than in its place.
              </p>
            }
            <app-conversation [items]="item.items" />
          </details>
        }
      }
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .turn {
      margin: 0.6rem 0;
    }
    .turn.user {
      border-left: 3px solid #4f46e5;
      padding-left: 0.65rem;
    }
    .turn.agent {
      border-left: 3px solid #e5e7eb;
      padding-left: 0.65rem;
    }
    .who {
      margin: 0 0 0.15rem;
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.03em;
      text-transform: uppercase;
      color: #4f46e5;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.85rem;
      line-height: 1.5;
      color: #1f2937;
    }
    .turn.agent pre {
      font-family: inherit;
      font-size: 0.92rem;
    }
    .fold {
      margin: 0.35rem 0;
      border: 1px solid #e5e7eb;
      border-radius: 0.35rem;
      background: #f9fafb;
      padding: 0.35rem 0.55rem;
    }
    .fold > summary {
      cursor: pointer;
      font-size: 0.82rem;
      color: #4b5563;
      display: flex;
      gap: 0.5rem;
      align-items: baseline;
    }
    .fold[open] > summary {
      margin-bottom: 0.4rem;
    }
    .name {
      font-weight: 600;
      color: #374151;
    }
    .hint {
      color: #6b7280;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.76rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .thinking {
      background: #fbfaff;
      border-color: #ddd6fe;
    }
    .result.failed {
      border-color: #fecaca;
      background: #fef2f2;
    }
    .chain {
      border-color: #d1d5db;
      background: #f3f4f6;
    }
    .chain.unplaced {
      border-style: dashed;
    }
    .cut {
      margin: 0.35rem 0 0;
      font-size: 0.76rem;
      color: #6b7280;
      font-style: italic;
    }
    .failure {
      margin: 0.5rem 0;
      padding: 0.4rem 0.6rem;
      border-radius: 0.35rem;
      background: #fef2f2;
      color: #b91c1c;
      font-size: 0.85rem;
    }
  `,
})
export class Conversation {
  readonly items = input.required<readonly ChatItem[]>();

  protected readonly limit = TOOL_RESULT_LIMIT;

  protected brief(input: string): string {
    return summarise(input);
  }
}
