const test = require('node:test');
const assert = require('node:assert/strict');
const { runAgentLoop } = require('../../../runtime/agent/agent-loop');
const { countPromptTokens } = require('../../../runtime/agent/context-budget-manager');
const { ToolRegistry } = require('../../../runtime/agent/tool-registry');
const { createVaultReadTool } = require('../../../runtime/agent/tools/vault-read');

function scriptedProvider(contextWindow, calls, inspect) {
  let turn = 0;
  return {
    spec: { defaultModel: 'test', models: [{ id: 'test', contextWindow }] },
    userConfig: { model: 'test' },
    async *createMessage(input) {
      if (inspect) await inspect(input, turn, this);
      yield { type: 'message_start', message: {} };
      const tools = calls[turn++] || [];
      for (let i = 0; i < tools.length; i++) {
        yield { type: 'content_block_start', index: i, content_block: { type: 'tool_use', ...tools[i] } };
        yield { type: 'content_block_stop', index: i };
      }
      if (!tools.length) {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Read completed.' } };
        yield { type: 'content_block_stop', index: 0 };
      }
      yield { type: 'message_delta', delta: { stop_reason: tools.length ? 'tool_use' : 'end_turn' } };
      yield { type: 'message_stop' };
    },
  };
}
function call(id, path) { return { id, name: 'vault_read', input: { path } }; }
async function run(provider, sources, output = 32768) {
  const registry = new ToolRegistry();
  registry.register(createVaultReadTool({ vault: { getFileByPath: path => ({ path }), cachedRead: async file => sources[file.path] } }));
  const events = [];
  for await (const event of runAgentLoop({ provider, registry, messages: [{ role: 'user', content: [{ type: 'text', text: 'Read the specified files.' }] }], maxTokensPerTurn: output })) events.push(event);
  return events;
}

test('the real loop gives a 1M model enough read budget for a complete 80KB document', async () => {
  const source = '证据🙂'.repeat(8000) + 'END_MARKER';
  const provider = scriptedProvider(1_000_000, [[call('r1', 'A.md')]], (input, turn) => {
    if (turn === 1) assert.equal(input.messages.at(-1).content[0].content, source);
  });
  const events = await run(provider, { 'A.md': source });
  assert.equal(events.at(-1).type, 'done', JSON.stringify({ type: events.at(-1).type, reason: events.at(-1).reason, error: events.at(-1).error }));
  assert.equal(events.filter(e => e.type === 'tool_finish').length, 1);
  assert.equal(events.find(e => e.type === 'tool_finish').content, source);
});

test('concurrent large reads share the remaining window including result envelopes', async () => {
  let checked = false;
  const source = '证据🙂'.repeat(8000);
  const provider = scriptedProvider(10000, [[call('a', 'A.md'), call('b', 'B.md')]], async (input, turn, instance) => {
    if (turn !== 1) return;
    const results = input.messages.at(-1).content;
    assert.equal(results.length, 2);
    assert.ok(results.every(r => /content truncated; next byte offset/.test(r.content)));
    const tokens = await countPromptTokens(instance, input.system, input.tools, input.messages);
    assert.ok(tokens + input.maxTokens + 1024 <= 10000);
    checked = true;
  });
  const events = await run(provider, { 'A.md': source, 'B.md': source }, 2000);
  assert.equal(events.at(-1).type, 'done', JSON.stringify({ type: events.at(-1).type, reason: events.at(-1).reason, error: events.at(-1).error }));
  assert.equal(checked, true);
});

test('an exact repeat retains its first full result and sends only a reference for the duplicate', async () => {
  const source = 'Unique evidence. '.repeat(3000);
  const provider = scriptedProvider(1_000_000, [[call('first', 'A.md')], [call('second', 'A.md')]], (input, turn) => {
    if (turn !== 2) return;
    const results = input.messages.flatMap(m => m.content).filter(b => b.type === 'tool_result');
    assert.equal(results[0].content, source);
    assert.match(results[1].content, /canonical_tool_use_id=first/);
    assert.ok(results[1].content.length < 300);
  });
  const events = await run(provider, { 'A.md': source });
  assert.equal(events.at(-1).type, 'done', JSON.stringify({ type: events.at(-1).type, reason: events.at(-1).reason, error: events.at(-1).error }));
  assert.ok(events.some(e => e.type === 'context_usage' && e.compacted));
});
