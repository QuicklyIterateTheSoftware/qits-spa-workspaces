import { Injectable, inject } from '@angular/core';
import { WorkspaceDaemonApi } from './workspace-daemon-api';

/**
 * The daemon's command and coding-agent surface, hand-written from
 * `daemons/qits-workspace-daemon/docs/openapi.yml`.
 *
 * One client for both because **a coding agent is a command**: `POST /agents` answers the same
 * `{command: …}` envelope `POST /commands` does, and the document says so explicitly so that one
 * decoder serves both. Splitting them would buy two decoders for one shape.
 *
 * These types are what the whole agent surface is built on — the Chat tab here, the run history and
 * the session tree later — so they are written from the contract rather than from what Chat happens
 * to read today.
 */

/** Whether a command is still going, and how it stopped if not. */
export type CommandStatus = 'RUNNING' | 'EXITED' | 'TERMINATED' | 'INTERRUPTED';

/**
 * What the frontend routes its view on.
 *
 * `TERMINAL` is an interactive PTY, `CHAT` is a coding-agent session over line-delimited JSON on
 * pipes, and `SERVICE` is carried because it is part of the shape — this surface does not launch
 * services, `/services` does.
 */
export type CommandKind = 'TERMINAL' | 'CHAT' | 'SERVICE';

/** Which harness ran, or is to run. */
export type AgentType = 'CLAUDE' | 'KIMI';

/**
 * Which MCP servers a launch is wired to.
 *
 * `ACTIONS` fails with an explanation today — no service in the split serves that server — so
 * `REPOSITORY` is the only value this client sends.
 */
export type AgentMcpScope = 'ACTIONS' | 'REPOSITORY';

/** `CHAT` is the stream-json conversation over pipes; `INTERACTIVE` is the full agent TUI on a PTY. */
export type AgentLaunchMode = 'CHAT' | 'INTERACTIVE';

/** How a session entered a command's lineage. */
export type AgentSessionSource = 'PINNED' | 'RESUMED' | 'FORKED' | 'SWITCHED' | 'REPORTED';

/** One session a command drove. In `Command.agentSessions` the **last** entry is the current one. */
export interface AgentSessionRefDto {
  readonly sessionId: string;
  readonly source: AgentSessionSource;
  readonly forkedFromSessionId?: string;
  readonly transcriptPath?: string;
  readonly recordedAt: string;
}

/**
 * One run inside the container.
 *
 * `repoId`, `workspaceId` and `shortCommitHash` are synthesized by the daemon: they are on the
 * host's DTO but ambient inside the container, and the daemon reproduces them so the host's shape
 * reconstructs unchanged.
 *
 * The optional fields are optional for one reason each: `finishedAt` and `exitCode` are absent while
 * running, `actionId` is absent for a run with no declared action behind it, and the commit pair is
 * absent when the checkout's HEAD was unknown at launch.
 */
export interface CommandDto {
  readonly id: string;
  readonly repoId: string;
  readonly workspaceId: string;
  readonly branch: string;
  readonly actionName: string;
  readonly actionId?: string;
  readonly status: CommandStatus;
  readonly interactive: boolean;
  readonly kind: CommandKind;
  readonly launchedAt: string;
  readonly finishedAt?: string;
  readonly exitCode?: number;
  readonly commitHash?: string;
  readonly shortCommitHash?: string;
  readonly agentSessions: readonly AgentSessionRefDto[];
}

/** The single-command envelope both `POST /commands` and `POST /agents` answer with. */
interface CommandEnvelope {
  readonly command: CommandDto;
}

/** The list envelope: newest first, each row keeping the `{command: …}` wrapper. */
interface CommandListResponse {
  readonly entries: readonly CommandEnvelope[];
}

/**
 * What a launch asks for.
 *
 * **`deliverTaskPrompt` is never set true by this client.** It seeds the session with an instruction
 * to fetch the prompt through an MCP tool called `taskPrompt`, and that tool is not implemented
 * anywhere on the platform — the agent would be told to call something that does not exist. The
 * composed prompt rides `initialContext` instead, which works today and covers everything except
 * images.
 */
export interface LaunchAgentRequest {
  readonly scope: AgentMcpScope;
  readonly mode: AgentLaunchMode;
  readonly agentType?: AgentType;
  readonly initialContext?: string;
  readonly resumeSessionId?: string;
  readonly fork?: boolean;
  readonly deliverTaskPrompt?: boolean;
}

/** What `POST /prompt-refinements` answers. */
interface RefinementResponse {
  readonly prompt: string;
}

@Injectable({ providedIn: 'root' })
export class CommandsApi {
  private readonly daemon = inject(WorkspaceDaemonApi);

  /**
   * Every command this container has run, newest first.
   *
   * Unfiltered on purpose. One entry is shared by the Chat tab, the Actions history, the session
   * tree and the embedded session, and the discipline that makes that sharing work is identical key
   * *and* identical result shape — a `?status=RUNNING` read here would be a second, narrower cache
   * of the same thing, and the two would silently stop being one.
   *
   * The store is in-memory and per container: a recreate starts it empty and a stopped container has
   * none at all. There is no host-side fallback, so "the container is stopped" is a state to render,
   * not an empty list.
   */
  async commands(workspaceRowId: number): Promise<readonly CommandDto[]> {
    const answer = await this.daemon.get<CommandListResponse>(workspaceRowId, '/commands');
    return (answer.entries ?? []).map((entry) => entry.command);
  }

  /**
   * Signal a running command's process group, and answer it in its post-terminate state.
   *
   * Distinct from *closing a socket*, which only detaches and leaves the process running — the whole
   * reason a tab switch is free.
   */
  async terminate(workspaceRowId: number, commandId: string): Promise<CommandDto> {
    const answer = await this.daemon.post<CommandEnvelope>(
      workspaceRowId,
      `/commands/${encodeURIComponent(commandId)}/terminate`,
    );
    return answer.command;
  }

  /** Launch a coding agent. The answer is the command to attach a socket to. */
  async launchAgent(workspaceRowId: number, request: LaunchAgentRequest): Promise<CommandDto> {
    const answer = await this.daemon.post<CommandEnvelope>(workspaceRowId, '/agents', request);
    return answer.command;
  }

  /**
   * Rewrite a rough transcript into a task prompt: one model call over the harness already installed
   * in this container.
   *
   * The `preamble` is the workspace's stated goal and has **no source inside the container** — it is
   * host-side metadata — so the caller reads it off the workspace row and passes it here. A blank
   * transcript is a 400 rather than an empty answer.
   */
  async refinePrompt(
    workspaceRowId: number,
    transcript: string,
    preamble: string | null,
  ): Promise<string> {
    const body: Record<string, string> = { transcript };
    if (preamble) {
      body['preamble'] = preamble;
    }
    const answer = await this.daemon.post<RefinementResponse>(
      workspaceRowId,
      '/prompt-refinements',
      body,
    );
    return answer.prompt;
  }
}
