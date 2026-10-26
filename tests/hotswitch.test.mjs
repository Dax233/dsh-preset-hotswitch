import assert from 'node:assert/strict';
import test from 'node:test';

import { apply, inject, name } from '../lib/index.js';

/**
 * Build a live-Agent stub with a recording session log.
 * @param {string} id session id
 * @returns {Record<string, any>} agent stub
 */
function agentStub(id = 'session-test') {
  const appended = [];
  const agent = {
    id,
    ctx: { scoped: true },
    appended,
    session: {
      header: { id },
      /** @param {string} type session event type @param {unknown} data event payload */
      append(type, data) {
        appended.push({ type, data });
      },
    },
  };
  return agent;
}

/**
 * Mount the plugin over a stub context and return the single registered tool.
 * @param {Record<string, any>} options registry/agent behaviour overrides
 * @returns {{ tool: Record<string, any>, calls: Record<string, any[]>, target: Record<string, any> }}
 */
function mount(options = {}) {
  const {
    initiator,
    current = 'standard',
    presets = ['standard', 'ptc', 'minimal', 'cordis'],
    list,
    recompose,
    initiatorThrows = false,
  } = options;
  const registered = [];
  const calls = { list: 0, recompose: [] };
  const target = agentStub();
  const ctx = {
    agentPresets: {
      composedPreset(agentCtx) {
        return agentCtx === target.ctx ? current : undefined;
      },
      async list() {
        calls.list++;
        if (list !== undefined) return list();
        return presets.map((id) => ({ id }));
      },
      async recompose(agentCtx, id) {
        calls.recompose.push({ agentCtx, id });
        if (recompose !== undefined) return recompose(agentCtx, id);
        return { id };
      },
    },
    agents: {
      get(id) {
        if (id === target.id) return target;
        if (initiator !== undefined && id === initiator.id) return initiator;
        return undefined;
      },
      currentInitiator() {
        if (initiatorThrows) throw new Error('initiator scope is closing');
        return initiator;
      },
    },
    tools: {
      register(definition) {
        registered.push(definition);
        return () => {};
      },
    },
    effect(callback) {
      return callback();
    },
  };
  apply(ctx);
  assert.equal(registered.length, 1, 'exactly one tool is registered');
  return { tool: registered[0], calls, target };
}

test('identity and dependency contract', () => {
  assert.equal(name, 'preset-hotswitch');
  assert.deepEqual(inject, ['tools', 'agents', 'agentPresets']);
  const { tool } = mount();
  assert.equal(tool.name, 'switch_session_preset');
  assert.equal(tool.parameters.type, 'object');
  assert.equal(tool.parameters.properties.preset.type, 'string');
  assert.deepEqual(tool.parameters.required, []);
  assert.match(tool.description, /recompose/);
  assert.match(tool.description, /Omit preset/);
});

test('omitting preset reports the binding without switching', async () => {
  const { tool, calls, target } = mount();
  const value = await tool.execute({}, { agent: target });
  assert.equal(value.ok, true);
  assert.deepEqual(JSON.parse(value.text), {
    session: 'session-test',
    current: 'standard',
    presets: ['standard', 'ptc', 'minimal', 'cordis'],
  });
  assert.equal(calls.recompose.length, 0, 'a read-only call never rebinds');
  assert.deepEqual(target.appended, [], 'a read-only call never records a switch');
  assert.deepEqual(tool.output.render({}, value), [{ type: 'text', text: value.text }]);
});

test('switching rebinds the calling agent and records the selection', async () => {
  const { tool, calls, target } = mount();
  const value = await tool.execute({ preset: 'cordis' }, { agent: target });
  assert.equal(value.ok, true);
  assert.deepEqual(calls.recompose, [{ agentCtx: target.ctx, id: 'cordis' }]);
  assert.deepEqual(target.appended, [
    { type: 'agent-preset/selected', data: { agentPreset: 'cordis' } },
  ]);
  assert.match(value.text, /switched session session-test: standard -> cordis/);
  assert.match(value.text, /next request/);
});

test('the returned binding id is what gets recorded', async () => {
  const { tool, target } = mount({ recompose: () => ({ id: 'minimal' }) });
  const value = await tool.execute({ preset: 'minimal' }, { agent: target });
  assert.equal(value.ok, true);
  assert.deepEqual(target.appended, [
    { type: 'agent-preset/selected', data: { agentPreset: 'minimal' } },
  ]);
  assert.match(value.text, /-> minimal/);
});

test('the current preset is a no-op', async () => {
  const { tool, calls, target } = mount();
  const value = await tool.execute({ preset: 'standard' }, { agent: target });
  assert.equal(value.ok, true);
  assert.match(value.text, /already on preset standard/);
  assert.equal(calls.recompose.length, 0);
  assert.deepEqual(target.appended, []);
});

test('falls back to the initiating agent when the run context carries none', async () => {
  const initiator = agentStub('session-initiator');
  const { tool, calls } = mount({ initiator });
  const value = await tool.execute({}, {});
  assert.equal(value.ok, true);
  assert.match(value.text, /session-initiator/);
  await tool.execute({ preset: 'minimal' }, {});
  assert.deepEqual(calls.recompose, [{ agentCtx: initiator.ctx, id: 'minimal' }]);
  assert.deepEqual(initiator.appended, [
    { type: 'agent-preset/selected', data: { agentPreset: 'minimal' } },
  ]);
});

test('a run-context agent that is no longer live is not used', async () => {
  const stale = agentStub('session-stale');
  const { tool, calls } = mount();
  const value = await tool.execute({ preset: 'cordis' }, { agent: stale });
  assert.equal(value.ok, false);
  assert.match(value.text, /no live calling session/);
  assert.equal(calls.recompose.length, 0);
});

test('an unavailable initiator scope fails instead of guessing', async () => {
  const { tool, calls } = mount({ initiatorThrows: true });
  const value = await tool.execute({ preset: 'cordis' }, {});
  assert.equal(value.ok, false);
  assert.match(value.text, /no live calling session/);
  assert.equal(calls.recompose.length, 0);
});

test('a non-string preset is rejected instead of treated as a read', async () => {
  const { tool, calls, target } = mount();
  const value = await tool.execute({ preset: 123 }, { agent: target });
  assert.equal(value.ok, false);
  assert.match(value.text, /invalid preset/);
  assert.equal(calls.list, 0);
  assert.equal(calls.recompose.length, 0);
});

test('subagent sessions are refused, but can still read their binding', async () => {
  const { tool, calls, target } = mount();
  target.session.header = { id: 'session-test', origin: 'subagent', parentSession: 'session-parent' };
  const report = await tool.execute({}, { agent: target });
  assert.equal(report.ok, true);
  assert.match(report.text, /"current":"standard"/);
  const value = await tool.execute({ preset: 'cordis' }, { agent: target });
  assert.equal(value.ok, false);
  assert.match(value.text, /subagent session/);
  assert.equal(calls.recompose.length, 0);
  assert.deepEqual(target.appended, []);
});

test('recompose failures are reported as a tool result, not thrown', async () => {
  const failure = Object.assign(new Error('Unknown agent preset: nope'), {
    code: 'agent-preset/not-found',
    details: { agentPreset: 'nope', available: ['standard', 'ptc', 'cordis'] },
  });
  const { tool, target } = mount({
    recompose() {
      throw failure;
    },
  });
  const value = await tool.execute({ preset: 'nope' }, { agent: target });
  assert.equal(value.ok, false);
  assert.match(value.text, /agent-preset\/not-found/);
  assert.match(value.text, /Unknown agent preset: nope/);
  assert.match(value.text, /available presets: standard, ptc, cordis/);
  assert.deepEqual(target.appended, [], 'nothing is recorded when the rebind fails');
});

test('listing failures are reported as a tool result', async () => {
  const { tool, target } = mount({
    list() {
      throw new Error('registry disposed');
    },
  });
  const value = await tool.execute({}, { agent: target });
  assert.equal(value.ok, false);
  assert.match(value.text, /cannot list agent presets/);
  assert.match(value.text, /registry disposed/);
});

test('a recording failure keeps the rebind but reports it is not persistent', async () => {
  const { tool, target } = mount();
  target.session.append = () => {
    throw new Error('session log closed');
  };
  const value = await tool.execute({ preset: 'ptc' }, { agent: target });
  assert.equal(value.ok, false);
  assert.match(value.text, /now runs ptc/);
  assert.match(value.text, /recording the switch failed/);
  assert.match(value.text, /session log closed/);
});
