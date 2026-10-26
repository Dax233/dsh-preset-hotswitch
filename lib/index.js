/**
 * dsh-preset-hotswitch — hot-switch the calling session's agent preset.
 *
 * The shipped registry exposes agentPresets.select() only while a session is
 * blank: once any turn started it rejects the selection as
 * `agent-preset/locked`. recompose() is the same public mount/rebind service
 * method without that admission check — its own contract says "Rebind a blank
 * Agent; the caller owns the blank-session check" — so a session that has
 * already started can still be rebound. The switch is then recorded as an
 * `agent-preset/selected` session event, which the registry's `agentPreset`
 * session projection replays on resume, so a restart keeps the new preset.
 *
 * This deliberately relies on the DSH 0.2.1 agentPresets contract. If a future
 * DSH release changes recompose() or the projection, the plugin can stop
 * working; it only calls public services, so the failure is reported back as a
 * normal tool error rather than corrupting the session.
 *
 * @module @local/dsh-preset-hotswitch
 */

/** Loader row name. */
export const name = 'preset-hotswitch';

/** The tool registry, the agent registry and the preset registry are required. */
export const inject = ['tools', 'agents', 'agentPresets'];

/**
 * Read a machine-readable error code from a registry failure.
 *
 * RemoteErrors carry `code`; a wrapped or causal error may carry it one level
 * down. The exact shape is deliberately treated as optional: the message is
 * always reported, the code only when one is found.
 *
 * @param {unknown} error failure raised by a registry or session service
 * @returns {string | undefined} error code, when present
 */
function errorCode(error) {
  if (error === null || typeof error !== 'object') return undefined;
  for (const candidate of [error.code, error.info?.code, error.cause?.code]) {
    if (typeof candidate === 'string' && candidate !== '') return candidate;
  }
  return undefined;
}

/**
 * Render a failure as one line of text, keeping the useful registry details.
 * @param {unknown} error failure raised by a registry or session service
 * @returns {string} `code: message`, plus available presets / reason when present
 */
function describeFailure(error) {
  const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
  const code = errorCode(error);
  const parts = [code === undefined ? message : `${code}: ${message}`];
  const details = error !== null && typeof error === 'object' ? error.details : undefined;
  if (details !== null && typeof details === 'object') {
    if (Array.isArray(details.available)) {
      const available = details.available.filter((id) => typeof id === 'string' && id !== '').slice(0, 12);
      if (available.length > 0) parts.push(`available presets: ${available.join(', ')}`);
    }
    if (typeof details.reason === 'string' && details.reason !== '') parts.push(`reason: ${details.reason}`);
  }
  return parts.join('; ');
}

/**
 * Whether `agent` is the exact live Agent registered under its id.
 * @param {{ get(id: string): any | undefined }} agentService live Agent registry
 * @param {unknown} agent candidate Agent
 * @returns {boolean} true when the registry currently holds this exact instance
 */
function isLiveAgent(agentService, agent) {
  if (agent === null || typeof agent !== 'object' || agent.ctx === undefined || agent.session === undefined) return false;
  try {
    return agentService.get(agent.id) === agent;
  } catch {
    return false;
  }
}

/**
 * The live Agent whose turn issued this tool call.
 *
 * A real tool call carries its Agent in the tool run context. The initiator
 * fallback covers same-process direct calls that carry no run-context agent
 * (for example another tool invoking this definition through the registry).
 * Both paths are checked against the live registry, and there is no "last
 * Agent" fallback on purpose: guessing would switch a different session than
 * the caller asked for.
 *
 * @param {{ get(id: string): any | undefined, currentInitiator(): any | undefined }} agentService live Agent registry
 * @param {unknown} exec tool run context
 * @returns {any | undefined} the calling Agent, when resolvable
 */
function callingAgent(agentService, exec) {
  const direct = exec !== null && typeof exec === 'object' ? exec.agent : undefined;
  if (isLiveAgent(agentService, direct)) return direct;
  let initiator;
  try {
    initiator = agentService.currentInitiator();
  } catch {
    return undefined;
  }
  if (isLiveAgent(agentService, initiator)) return initiator;
  return undefined;
}

/**
 * Whether a session is a delegated subagent, whose composition is inherited
 * from its delegating session and must not be rebound from inside.
 * @param {any} agent live Agent
 * @returns {boolean} true when the session header marks subagent lineage
 */
function isSubagent(agent) {
  let header;
  try {
    header = agent.session.header;
  } catch {
    return false;
  }
  return header !== null && typeof header === 'object'
    && (header.origin === 'subagent' || header.parentSession !== undefined);
}

/**
 * Register the `switch_session_preset` tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx plugin context
 */
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register({
    name: 'switch_session_preset',
    description: [
      'Switch the CALLING session to another agent preset (for example cordis, the Creator/创造 mode), even after its first turn.',
      'Calls the agentPresets.recompose() service method — documented as "rebind a blank Agent; the caller owns the blank-session check" — and deliberately skips that check, then records agent-preset/selected so the switch survives a restart.',
      'Experimental: depends on the DSH agentPresets contract and can stop working on a DSH upgrade. Tool composition and prompt sections change on the next request. Omit preset to read the current binding and the available preset ids.'
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        preset: {
          type: 'string',
          description: 'Target preset id. Omit to only report the current binding and the available preset ids.',
        },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
        },
        required: ['ok', 'text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const registry = ctx.agentPresets;
      const agent = callingAgent(ctx.agents, exec);
      if (agent === undefined) {
        return { ok: false, text: 'hotswitch: no live calling session could be resolved for this tool call' };
      }
      const rawPreset = args !== null && typeof args === 'object' ? args.preset : undefined;
      if (rawPreset !== undefined && (typeof rawPreset !== 'string' || rawPreset.trim() === '')) {
        return { ok: false, text: 'hotswitch: invalid preset: expected a non-empty string id' };
      }
      const current = (() => {
        try { return registry.composedPreset(agent.ctx) ?? null; } catch { return null; }
      })();
      const requested = typeof rawPreset === 'string' ? rawPreset.trim() : undefined;
      if (requested === undefined) {
        let presets;
        try {
          presets = await registry.list();
        } catch (error) {
          return { ok: false, text: 'hotswitch: cannot list agent presets: ' + describeFailure(error) };
        }
        return {
          ok: true,
          text: JSON.stringify({ session: agent.id, current, presets: presets.map((preset) => preset.id) }),
        };
      }
      if (isSubagent(agent)) {
        return {
          ok: false,
          text: 'hotswitch: refusing to switch session ' + agent.id + ': it is a subagent session, whose composition is inherited from the delegating session',
        };
      }
      if (requested === current) {
        return { ok: true, text: 'already on preset ' + requested + ' (session ' + agent.id + ')' };
      }
      let bound;
      try {
        bound = await registry.recompose(agent.ctx, requested);
      } catch (error) {
        return {
          ok: false,
          text: 'hotswitch: cannot switch session ' + agent.id + ' to ' + requested + ': ' + describeFailure(error),
        };
      }
      try {
        agent.session.append('agent-preset/selected', { agentPreset: bound.id });
      } catch (error) {
        return {
          ok: false,
          text: 'hotswitch: session ' + agent.id + ' now runs ' + bound.id + ', but recording the switch failed, so a restart will not keep it: ' + describeFailure(error),
        };
      }
      return {
        ok: true,
        text: 'switched session ' + agent.id + ': ' + String(current) + ' -> ' + bound.id + ' (effective on the next request)',
      };
    },
  }), 'preset-hotswitch.tool');
}
