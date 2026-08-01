import { Injectable, inject } from '@angular/core';
import type { AgentType } from './commands-api';
import { WorkspaceDaemonApi } from './workspace-daemon-api';

/**
 * The rest of the daemon's coding-agent surface — the parts a launch is not.
 *
 * Written by hand from `daemons/qits-workspace-daemon/docs/openapi.yml`, like every other client
 * here. `POST /agents` lives on {@link ./commands-api#CommandsApi} because a coding agent **is** a
 * command and answers the command envelope; what is left is the three reads the Agents tab is built
 * on — the harnesses, the session lineage and the plugin store — plus the one install verb.
 */

/** The harnesses this container can launch, and the one a fresh launch takes by default. */
export interface AvailableAgentsDto {
  readonly agents: readonly AgentType[];
  readonly defaultAgent: AgentType;
}

/**
 * One side-chain a session's `Task` calls spawned.
 *
 * `agentType` and `description` are agent-produced free text — clamped by the daemon and either may
 * be absent — so they are rendered as words the agent chose, never matched against a vocabulary.
 */
export interface AgentSubagentDto {
  readonly agentId: string;
  readonly messageCount: number;
  readonly agentType?: string;
  readonly description?: string;
  readonly firstTimestamp?: string;
}

/**
 * One session in the lineage.
 *
 * **This is a tree, not a list.** `children` recurses to arbitrary depth along `forkedFromSessionId`
 * edges, and `subagents` is a flat list one level deeper.
 *
 * Two absences carry meaning and must not be defaulted away. **`messageCount` omitted means "not
 * swept yet"**, which is a different screen from a swept zero: the count is filled in by the
 * transcript sweep when the run exits. And `subagents` is populated **only after that sweep**, so a
 * live session shows its main thread and gains its side-chains when it ends — which the UI says out
 * loud rather than looking broken.
 */
export interface AgentSessionNodeDto {
  readonly sessionId: string;
  readonly firstRecordedAt?: string;
  readonly forkedFromSessionId?: string;
  readonly messageCount?: number;
  /** The most recent command that drove this session — the daemon's own re-attach target. */
  readonly newestCommandId?: string;
  readonly subagents: readonly AgentSubagentDto[];
  readonly children: readonly AgentSessionNodeDto[];
}

interface AgentSessionTreeResponse {
  readonly sessions: readonly AgentSessionNodeDto[];
}

/**
 * One plugin the shared credential volume records.
 *
 * `pluginId` is the **marketplace-qualified** form (`<id>@claude-plugins-official`), as the volume
 * writes it. The install verb takes the **bare** id and appends the suffix itself, so the qualified
 * form is refused there — see {@link barePluginId}.
 *
 * `enabled: false` is installed-but-switched-off, which is distinct from absent and is drawn as such.
 */
export interface InstalledPluginDto {
  readonly pluginId: string;
  readonly enabled: boolean;
}

interface PluginListResponse {
  readonly installed: readonly InstalledPluginDto[];
}

/**
 * What the install path will accept: the bare id, lowercase, dashes, up to 64 characters.
 *
 * The daemon pattern-matches this before the value reaches a shell, because it crosses from an
 * untrusted caller into an argv. This client checks the same shape first — not as a second line of
 * defence, but so a malformed id is a sentence here rather than a 400 from a request that should
 * never have left.
 */
const BARE_PLUGIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The marketplace the daemon installs from, and the suffix it appends to a bare id. */
export const PLUGIN_MARKETPLACE = 'claude-plugins-official';

/** Strip the marketplace suffix a listing reports, leaving the id the install verb takes. */
export function barePluginId(pluginId: string): string {
  const at = pluginId.indexOf('@');
  return at === -1 ? pluginId : pluginId.slice(0, at);
}

@Injectable({ providedIn: 'root' })
export class AgentsApi {
  private readonly daemon = inject(WorkspaceDaemonApi);

  /**
   * The harnesses and the resolved default.
   *
   * Fetched **once per page**: it is resolved from the checkout's `.qits-config.yml` falling through
   * to the daemon's own configuration, and neither changes under a running container. A resumed
   * session keeps its original harness, so this only ever drives a *fresh* launch's picker.
   */
  async available(workspaceRowId: number): Promise<AvailableAgentsDto> {
    return this.daemon.get<AvailableAgentsDto>(workspaceRowId, '/agents/available');
  }

  /**
   * The session lineage, roots first.
   *
   * The index is in-memory and dies with the container; the transcripts themselves do not, because
   * the harness writes them to a volume shared across workspaces. What a recreate loses is the
   * *index* — which is exactly why a resume across containers is refused rather than attempted.
   */
  async sessions(workspaceRowId: number): Promise<readonly AgentSessionNodeDto[]> {
    const answer = await this.daemon.get<AgentSessionTreeResponse>(
      workspaceRowId,
      '/agent-sessions',
    );
    return answer.sessions ?? [];
  }

  /**
   * What is installed on the shared credential volume.
   *
   * Read from the volume's `settings.json` rather than by shelling the CLI, so a volume with nothing
   * ever installed answers an empty list rather than an error. **The store is global to the shared
   * agent home**, so this answer is the same in every workspace — which is why the panel says so.
   */
  async plugins(workspaceRowId: number): Promise<readonly InstalledPluginDto[]> {
    const answer = await this.daemon.get<PluginListResponse>(workspaceRowId, '/agent-plugins');
    return answer.installed ?? [];
  }

  /**
   * Install one plugin, and answer the **refreshed installed set**.
   *
   * The response is the same envelope the listing uses, deliberately, so a client needs no follow-up
   * read to see the result of what it just did — and this one does not make one.
   *
   * `pluginId` may arrive in either form; the qualified suffix is stripped here, because the daemon
   * appends it and refuses the qualified form. Claude Code only: asking under another harness is a
   * 400 in the daemon's own words, which the caller renders.
   */
  async install(workspaceRowId: number, pluginId: string): Promise<readonly InstalledPluginDto[]> {
    const bare = barePluginId(pluginId);
    if (!BARE_PLUGIN_ID.test(bare)) {
      throw new Error(`“${pluginId}” is not a plugin id this marketplace can name.`);
    }
    const answer = await this.daemon.post<PluginListResponse>(
      workspaceRowId,
      `/agent-plugins/${encodeURIComponent(bare)}/install`,
    );
    return answer.installed ?? [];
  }
}
