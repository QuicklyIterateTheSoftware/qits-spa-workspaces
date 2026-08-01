import { TOOL_RESULT_LIMIT, buildConversation, summarise } from './chat-model';

/** A line, as the wire carries it. */
const line = (value: unknown): string => JSON.stringify(value);

const assistant = (...blocks: unknown[]) =>
  line({ type: 'assistant', message: { role: 'assistant', content: blocks } });

const toolResult = (toolUseId: string, content: unknown, isError = false) =>
  line({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }],
    },
  });

/**
 * The conversation, from the wire up.
 *
 * The daemon passes the harness's own `stream-json` events through and adds three synthetic lines of
 * its own, so this is the one place where the contract and the screen actually meet. Every rule in
 * it was written down somewhere else first — the plan, the spec, or the daemon's own OpenAPI — and
 * each test below names which.
 */
describe('buildConversation', () => {
  it('renders the user turn from the server echo, in either shape it arrives in', () => {
    // Two shapes because a replay is stitched from two sources: the live ring carries the daemon's
    // synthetic flat echo, the imported transcript carries the harness's message-shaped turn. Both
    // are the user speaking.
    const conversation = buildConversation([
      line({ type: 'user', text: 'add a health check' }),
      line({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'and a test' }] } }),
    ]);

    expect(conversation.items).toEqual([
      { kind: 'user', text: 'add a health check' },
      { kind: 'user', text: 'and a test' },
    ]);
  });

  it('splits an assistant message into text, thinking and tool calls', () => {
    const conversation = buildConversation([
      assistant(
        { type: 'thinking', thinking: 'the endpoint is in App.java' },
        { type: 'text', text: 'Adding it now.' },
        { type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { path: 'App.java' } },
      ),
    ]);

    expect(conversation.items.map((item) => item.kind)).toEqual([
      'thinking',
      'assistant',
      'tool-call',
    ]);
    expect(conversation.items[2]).toMatchObject({ toolUseId: 'toolu_1', name: 'Edit' });
  });

  it('truncates a tool result and says how much it kept', () => {
    const long = 'x'.repeat(TOOL_RESULT_LIMIT + 500);
    const conversation = buildConversation([toolResult('toolu_1', long)]);

    expect(conversation.items[0]).toMatchObject({
      kind: 'tool-result',
      truncatedFrom: TOOL_RESULT_LIMIT + 500,
    });
    expect((conversation.items[0] as { text: string }).text).toHaveLength(TOOL_RESULT_LIMIT);
  });

  it('flattens a tool result that arrives as content blocks rather than a string', () => {
    const conversation = buildConversation([
      toolResult('toolu_1', [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }]),
    ]);

    expect(conversation.items[0]).toMatchObject({ text: 'first\nsecond', truncatedFrom: null });
  });

  it('renders a failed result and drops a successful one', () => {
    // Successful completions are redundant with the assistant's own closing text; failures are the
    // only thing in the stream that says the run went wrong. The predicate is the daemon's own.
    const conversation = buildConversation([
      line({ type: 'result', subtype: 'success', result: 'done', is_error: false }),
      line({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom' }),
    ]);

    expect(conversation.items).toEqual([{ kind: 'error', text: 'boom' }]);
  });

  it('treats an error subtype as a failure even without the is_error flag', () => {
    const conversation = buildConversation([line({ type: 'result', subtype: 'error_max_turns' })]);

    expect(conversation.items).toEqual([
      { kind: 'error', text: 'The run ended with error_max_turns.' },
    ]);
  });

  it('ignores system events, blank lines and anything that is not JSON', () => {
    const conversation = buildConversation([
      line({ type: 'system', subtype: 'init', tools: [] }),
      '',
      'not json at all',
      line([1, 2, 3]),
      assistant({ type: 'text', text: 'hello' }),
    ]);

    expect(conversation.items).toEqual([{ kind: 'assistant', text: 'hello' }]);
  });

  it('folds a side-chain under the tool call that spawned it, wherever it arrives', () => {
    // The exit sweep imports the whole main session first and appends each side-chain behind its
    // anchor, so on the wire they are at the end. On screen they belong under their Task call.
    const conversation = buildConversation([
      assistant({ type: 'tool_use', id: 'toolu_task', name: 'Task', input: {} }),
      assistant({ type: 'text', text: 'and now the summary' }),
      line({
        type: 'qits_agent_meta',
        agentId: 'a1',
        agentType: 'explorer',
        description: 'find the callers',
        toolUseId: 'toolu_task',
      }),
      assistant({ type: 'text', text: 'I looked at four files' }),
    ]);

    expect(conversation.items.map((item) => item.kind)).toEqual([
      'tool-call',
      'side-chain',
      'assistant',
    ]);
    expect(conversation.items[1]).toMatchObject({
      anchored: true,
      agentType: 'explorer',
      description: 'find the callers',
      items: [{ kind: 'assistant', text: 'I looked at four files' }],
    });
    expect(conversation.orphanSideChains).toBe(0);
  });

  it('appends a side-chain whose anchor is missing rather than dropping it', () => {
    // The Task call can be older than the 256 KB ring and outside the imported transcript. Losing an
    // agent's work because its call is out of view would be worse than showing it unplaced.
    const conversation = buildConversation([
      assistant({ type: 'text', text: 'main thread' }),
      line({ type: 'qits_agent_meta', agentId: 'a1', toolUseId: 'toolu_gone' }),
      assistant({ type: 'text', text: 'orphaned work' }),
    ]);

    expect(conversation.items.map((item) => item.kind)).toEqual(['assistant', 'side-chain']);
    expect(conversation.items[1]).toMatchObject({ anchored: false });
    expect(conversation.orphanSideChains).toBe(1);
  });

  it('closes one side-chain when the next anchor opens', () => {
    const conversation = buildConversation([
      assistant({ type: 'tool_use', id: 'one', name: 'Task', input: {} }),
      assistant({ type: 'tool_use', id: 'two', name: 'Task', input: {} }),
      line({ type: 'qits_agent_meta', toolUseId: 'one' }),
      assistant({ type: 'text', text: 'first chain' }),
      line({ type: 'qits_agent_meta', toolUseId: 'two' }),
      assistant({ type: 'text', text: 'second chain' }),
    ]);

    const chains = conversation.items.filter((item) => item.kind === 'side-chain');
    expect(chains).toHaveLength(2);
    expect(chains[0]).toMatchObject({ items: [{ kind: 'assistant', text: 'first chain' }] });
    expect(chains[1]).toMatchObject({ items: [{ kind: 'assistant', text: 'second chain' }] });
  });

  it('reports the closed envelope without rendering it as a message', () => {
    // A chat client parses rather than prints, so "no longer running" arrives as an envelope. It is
    // a fact about the process, not a failure, so it is not an error bubble.
    const conversation = buildConversation([
      assistant({ type: 'text', text: 'all done' }),
      line({ type: 'session_closed' }),
    ]);

    expect(conversation.closed).toBe(true);
    expect(conversation.items).toEqual([{ kind: 'assistant', text: 'all done' }]);
  });

  it('renders a line carrying a repeated uuid exactly once', () => {
    // The daemon promises every event replays exactly once, and its own comment calls the
    // no-shared-uuid stitch best-effort. This is the belt to that pair of braces.
    const repeated = line({
      type: 'assistant',
      uuid: 'u-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'once' }] },
    });

    expect(buildConversation([repeated, repeated]).items).toEqual([
      { kind: 'assistant', text: 'once' },
    ]);
  });

  it('drops empty text blocks so a stream of whitespace draws nothing', () => {
    expect(buildConversation([assistant({ type: 'text', text: '  ' })]).items).toEqual([]);
  });
});

describe('summarise', () => {
  it('collapses whitespace and cuts at the limit', () => {
    expect(summarise('a\n   b\tc')).toBe('a b c');
    expect(summarise('abcdefghij', 4)).toBe('abcd…');
  });
});
