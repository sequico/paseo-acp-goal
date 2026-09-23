import type {
  PluginBeforeRequests,
  PluginServerContext,
  PluginTurnOutcome,
} from "@getpaseo/plugin/server";
import type { AgentTimelineItem, HookAgent, PaseoApi } from "./host-types";

/**
 * The one place that knows the plugin host's shape.
 *
 * The plugin uses four hooks out of a catalogue of eleven. Declaring only those
 * four here keeps the loop free of the host's generic signatures, which is what
 * lets its tests drive it with plain functions instead of a fake framework.
 */

export interface TurnEndedEvent {
  agent: HookAgent;
  outcome: PluginTurnOutcome;
  timeline: readonly AgentTimelineItem[];
}

export interface ArchivedEvent {
  agent: HookAgent;
}

export interface HookContext {
  paseo: PaseoApi;
}

export type CreateRequest = PluginBeforeRequests["agent.create"];
export type SessionOpenRequest = PluginBeforeRequests["agent.session_open"];

export interface GoalLoopHost {
  onTurnEnded(handler: (event: TurnEndedEvent, context: HookContext) => void): () => void;
  onArchived(handler: (event: ArchivedEvent, context: HookContext) => void): () => void;
  /** Resolves to the request to change, or to `undefined` to leave it alone. */
  onCreate(handler: (request: CreateRequest) => Promise<CreateRequest | undefined>): () => void;
  onSessionOpen(handler: (request: SessionOpenRequest) => void): () => void;
}

export function pluginHost(server: PluginServerContext): GoalLoopHost {
  return {
    onTurnEnded: (handler) =>
      server.on("agent.turn_ended", (event, context) => {
        handler(
          { agent: event.agent, outcome: event.outcome, timeline: event.timeline },
          { paseo: context.paseo },
        );
      }),

    onArchived: (handler) =>
      server.on("agent.archived", (event, context) => {
        handler({ agent: event.agent }, { paseo: context.paseo });
      }),

    onCreate: (handler) =>
      server.before("agent.create", async ({ request }) => (await handler(request)) ?? undefined),

    onSessionOpen: (handler) =>
      server.before("agent.session_open", ({ request }) => {
        handler(request);
        return undefined;
      }),
  };
}
