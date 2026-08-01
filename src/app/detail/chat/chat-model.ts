/**
 * The conversation, built from the socket's lines. Pure functions and no Angular, because this is
 * the part worth testing exhaustively and none of it needs a DOM.
 *
 * The wire is one JSON object per line: the harness's own `stream-json` events passed through (Kimi's
 * ACP events are normalized into the same envelope before they get here), plus three synthetic lines
 * qits adds — the user echo, the sub-agent anchor, and the closed notice.
 */

/** How much of a tool result is worth reading before it stops being information. */
export const TOOL_RESULT_LIMIT = 4000;

/** One rendered thing in the conversation. */
export type ChatItem =
  | { readonly kind: 'user'; readonly text: string }
  | { readonly kind: 'assistant'; readonly text: string }
  | { readonly kind: 'thinking'; readonly text: string }
  | {
      readonly kind: 'tool-call';
      readonly toolUseId: string;
      readonly name: string;
      readonly input: string;
    }
  | {
      readonly kind: 'tool-result';
      readonly toolUseId: string;
      readonly text: string;
      readonly truncatedFrom: number | null;
      readonly isError: boolean;
    }
  | { readonly kind: 'error'; readonly text: string }
  | {
      readonly kind: 'side-chain';
      readonly agentType: string | null;
      readonly description: string | null;
      readonly anchored: boolean;
      readonly items: readonly ChatItem[];
    };

/** What a replay adds up to. */
export interface Conversation {
  readonly items: readonly ChatItem[];
  /** The server said this command is no longer running. Not a failure — a fact about the process. */
  readonly closed: boolean;
  /** Side-chains that arrived with no matching tool call, and were appended rather than dropped. */
  readonly orphanSideChains: number;
}

/** A conversation with nothing in it. */
export const EMPTY_CONVERSATION: Conversation = {
  items: [],
  closed: false,
  orphanSideChains: 0,
};

interface SideChain {
  readonly toolUseId: string | null;
  readonly agentType: string | null;
  readonly description: string | null;
  readonly items: ChatItem[];
}

/**
 * Turn a replay into a conversation.
 *
 * ## The user's turn comes from the server, in either of two shapes
 *
 * The daemon emits a synthetic `{"type":"user","text":…}` for every message sent, and that echo is
 * what the live view renders — **never an optimistic local bubble**, which is what guarantees the
 * live view and a later replay show the same things in the same order. But a replay is stitched
 * from the *transcript* too, and there a user turn is the harness's own message-shaped
 * `{"type":"user","message":{"content":[{"type":"text",…}]}}`. Both are the user speaking, so both
 * render as one. The daemon cuts the seam between the two halves and drops the echoes the
 * transcript already covers, so there is no double turn to guard against here.
 *
 * A message-shaped `user` frame also carries `tool_result` blocks, which are the harness reporting
 * back to itself rather than a person typing.
 *
 * ## Sub-agent side-chains are re-anchored, not left where they arrive
 *
 * A side-chain is announced by a `qits_agent_meta` line and everything after it belongs to that
 * side-chain until the next anchor or the end of the stream — because the exit sweep imports the
 * whole main session first and *then* appends each side-chain behind its anchor. So on the wire they
 * are at the end; on screen they belong under the `Task` call that spawned them, which is what
 * `toolUseId` names.
 *
 * **A side-chain whose anchor is missing appends at the end rather than being dropped.** It happens:
 * the tool call can be older than the 256 KB ring and outside the imported transcript. Losing the
 * work an agent did because its call is out of view would be worse than showing it unplaced.
 *
 * ## What is not rendered
 *
 * A *successful* `result` event is dropped — it is redundant with the assistant's own closing text,
 * and rendering it puts a summary of what you just read under what you just read. A *failed* one is
 * kept as an error line, because nothing else in the stream says the run went wrong. That predicate
 * — `is_error`, or `subtype == "error"` — is the same one the daemon uses to decide which result
 * lines survive a replay at all, so the two sides agree by construction.
 *
 * `system` events (the init banner, rate-limit notices) carry nothing a person asked for.
 */
export function buildConversation(lines: readonly string[]): Conversation {
  const main: ChatItem[] = [];
  const sideChains: SideChain[] = [];
  const seenUuids = new Set<string>();
  let current: SideChain | null = null;
  let closed = false;

  for (const line of lines) {
    const frame = parse(line);
    if (!frame) {
      continue;
    }

    // The daemon promises every event replays exactly once. This is belt and braces for the one
    // path its own comment calls best-effort — a stitch that found no shared uuid — and it costs a
    // set.
    const uuid = typeof frame['uuid'] === 'string' ? frame['uuid'] : null;
    if (uuid) {
      if (seenUuids.has(uuid)) {
        continue;
      }
      seenUuids.add(uuid);
    }

    const type = frame['type'];

    if (type === 'qits_agent_meta') {
      current = {
        toolUseId: stringOrNull(frame['toolUseId']),
        agentType: stringOrNull(frame['agentType']),
        description: stringOrNull(frame['description']),
        items: [],
      };
      sideChains.push(current);
      continue;
    }

    if (type === 'session_closed') {
      closed = true;
      continue;
    }

    const into = current ? current.items : main;
    for (const item of itemsOf(frame)) {
      into.push(item);
    }
  }

  return place(main, sideChains, closed);
}

/** Put each side-chain under its anchoring tool call, or at the end when there is none. */
function place(main: ChatItem[], sideChains: readonly SideChain[], closed: boolean): Conversation {
  const items: ChatItem[] = [...main];
  let orphans = 0;

  for (const chain of sideChains) {
    const group: ChatItem = {
      kind: 'side-chain',
      agentType: chain.agentType,
      description: chain.description,
      anchored: false,
      items: chain.items,
    };
    const at = chain.toolUseId === null ? -1 : indexOfCall(items, chain.toolUseId);
    if (at < 0) {
      orphans += 1;
      items.push(group);
    } else {
      items.splice(at + 1, 0, { ...group, anchored: true });
    }
  }

  return { items, closed, orphanSideChains: orphans };
}

function indexOfCall(items: readonly ChatItem[], toolUseId: string): number {
  return items.findIndex((item) => item.kind === 'tool-call' && item.toolUseId === toolUseId);
}

/** One wire frame, as zero or more rendered items. */
function itemsOf(frame: Record<string, unknown>): readonly ChatItem[] {
  const type = frame['type'];

  if (type === 'user') {
    const text = frame['text'];
    if (typeof text === 'string') {
      return text.trim() ? [{ kind: 'user', text }] : [];
    }
    return blocksOf(frame).flatMap(userBlock);
  }

  if (type === 'assistant') {
    return blocksOf(frame).flatMap(assistantBlock);
  }

  if (type === 'result' && isFailure(frame)) {
    return [{ kind: 'error', text: resultText(frame) }];
  }

  return [];
}

function userBlock(block: Record<string, unknown>): readonly ChatItem[] {
  if (block['type'] === 'tool_result') {
    const raw = flatten(block['content']);
    const truncated = raw.length > TOOL_RESULT_LIMIT;
    return [
      {
        kind: 'tool-result',
        toolUseId: stringOrNull(block['tool_use_id']) ?? '',
        text: truncated ? raw.slice(0, TOOL_RESULT_LIMIT) : raw,
        truncatedFrom: truncated ? raw.length : null,
        isError: block['is_error'] === true,
      },
    ];
  }
  if (block['type'] === 'text') {
    const text = stringOrNull(block['text']) ?? '';
    return text.trim() ? [{ kind: 'user', text }] : [];
  }
  return [];
}

function assistantBlock(block: Record<string, unknown>): readonly ChatItem[] {
  switch (block['type']) {
    case 'text': {
      const text = stringOrNull(block['text']) ?? '';
      return text.trim() ? [{ kind: 'assistant', text }] : [];
    }
    case 'thinking': {
      const text = stringOrNull(block['thinking']) ?? '';
      return text.trim() ? [{ kind: 'thinking', text }] : [];
    }
    case 'tool_use':
      return [
        {
          kind: 'tool-call',
          toolUseId: stringOrNull(block['id']) ?? '',
          name: stringOrNull(block['name']) ?? 'tool',
          input: flatten(block['input']),
        },
      ];
    default:
      return [];
  }
}

/** `message.content[]`, whatever the frame does about it being absent or a bare string. */
function blocksOf(frame: Record<string, unknown>): readonly Record<string, unknown>[] {
  const message = frame['message'];
  if (typeof message !== 'object' || message === null) {
    return [];
  }
  const content = (message as Record<string, unknown>)['content'];
  if (typeof content === 'string') {
    return [{ type: 'text', text: content }];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  return content.filter(
    (block): block is Record<string, unknown> => typeof block === 'object' && block !== null,
  );
}

/**
 * Whether a `result` event reports a failure — the only kind worth rendering.
 *
 * Both spellings are checked because both occur: the harness sets `is_error` on some paths and a
 * `subtype` of `error…` on others, and the daemon's own filter reads exactly these two.
 */
function isFailure(frame: Record<string, unknown>): boolean {
  const subtype = frame['subtype'];
  return frame['is_error'] === true || (typeof subtype === 'string' && subtype.startsWith('error'));
}

function resultText(frame: Record<string, unknown>): string {
  const result = flatten(frame['result']);
  if (result.trim()) {
    return result;
  }
  const subtype = stringOrNull(frame['subtype']);
  return subtype ? `The run ended with ${subtype}.` : 'The run ended with an error.';
}

/**
 * Anything a block holds, as text.
 *
 * Tool inputs and tool results are free-form: a string, an array of content blocks, or an object.
 * A viewer that only handled strings would render `[object Object]` for half the tool calls on the
 * screen, so the fallback is the JSON rather than a guess about its shape.
 */
function flatten(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => flatten(isTextBlock(entry) ? entry['text'] : entry)).join('\n');
  }
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

function isTextBlock(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)['type'] === 'text'
  );
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** One line, or null when it is not a JSON object — a blank line, or noise on the pipe. */
function parse(line: string): Record<string, unknown> | null {
  if (!line.trim()) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A short label for a tool call, for the collapsed row. */
export function summarise(input: string, limit = 120): string {
  const oneLine = input.replace(/\s+/g, ' ').trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit)}…` : oneLine;
}
