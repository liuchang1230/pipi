/**
 * The three delegation tools, as data — the whole text surface in one place.
 *
 * Everything the model can read about a delegation tool is built here: the tool
 * description, the parameter descriptions, and the guidance block appended to
 * the main agent's system prompt. This file has NO imports on purpose: the text
 * surface is testable from plain node, with no pi/typebox stubbing.
 *
 * The engine (engine.ts) and the TUI rendering (render.ts) hold the other half
 * and contain no tool name, label or prose of their own — every string they show
 * comes from a declaration below, via makeRenderer(decl) and
 * registerDelegationTool(pi, decl, render).
 *
 * Checked against the three pre-merge extensions: toolDescription(),
 * paramDescriptions() and the guidance of all three reproduce their old text
 * byte for byte (see the golden check, 9 strings x 3 tools).
 */

/** Parallel-mode limits. Declared here because the tool description quotes them,
 *  so the description cannot drift from what the engine actually does. */
export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;

export interface DelegationDeclaration {
  /** Tool name, and the agent name looked up in agents/*.md. */
  name: string;
  /** Sentence-initial form of {@link name} (e.g. "Reviewer"). */
  label: string;
  /** Fills the parameter descriptions: "Read-only <noun> task". */
  taskNoun: string;
  /** The two description sentences that genuinely differ per tool. */
  lead: [string, string];
  /** Appended to the main agent's system prompt while this tool is active. */
  guidance: string;
}

/** Native plural, lower case: "reviewers", "scouts", "analysts". */
export function pluralOf(d: DelegationDeclaration): string {
  return `${d.label.toLowerCase()}s`;
}

/** Upper-cases the first letter; the shared template starts a sentence. */
function sentenceCase(s: string): string {
  return s[0].toUpperCase() + s.slice(1);
}

/** The five sentences the model reads as this tool's description.
 *  agentDir feeds the documented default scope; configDirName is ".pi". */
export function toolDescription(
  d: DelegationDeclaration,
  agentDir: string,
  configDirName: string,
): string {
  return [
    d.lead[0],
    d.lead[1],
    `Modes: single ({task}) or parallel ({tasks} array, max ${MAX_PARALLEL_TASKS}, ${MAX_CONCURRENCY} concurrent).`,
    `${sentenceCase(pluralOf(d))} are read-only; all writes happen in the main conversation. Default agent scope is "user" (from ${agentDir}).`,
    `To use a project-local ${d.name} in ${configDirName}/agents, set agentScope: "both" (or "project").`,
  ].join(" ");
}

/** Parameter description, single mode and parallel-item mode. */
export function taskParam(d: DelegationDeclaration): string {
  return `Read-only ${d.taskNoun} task`;
}

export function taskParamSingle(d: DelegationDeclaration): string {
  return `Read-only ${d.taskNoun} task (single mode)`;
}

/** Every parameter description, in one place. The scope prompt is shared. */
export function paramDescriptions(d: DelegationDeclaration) {
  return {
    task: taskParam(d),
    taskSingle: taskParamSingle(d),
    tasks: `Array of {task} for parallel ${pluralOf(d)} (max ${MAX_PARALLEL_TASKS})`,
    cwdItem: `Working directory for the ${d.name} process`,
    cwdSingle: `Working directory for the ${d.name} process (single mode)`,
    confirm: `Prompt before running a project-local ${d.name}. Default: true.`,
    agentScope:
      'Which agent directories to use. Default: "user". Use "both" to include project-local agents.',
  } as const;
}

export const DECLARATIONS: DelegationDeclaration[] = [
  {
    name: "reviewer",
    label: "Reviewer",
    taskNoun: "review",
    lead: [
      "Delegate read-only code/diff review to an isolated reviewer subagent.",
      "The reviewer returns blocking issues, non-blocking suggestions, missing tests, evidence, and a risk summary.",
    ],
    guidance: `## Reviewer delegation (read-only code review)

You have a \`reviewer\` tool that delegates READ-ONLY code/diff review to an isolated subagent. Use it to buy an INDEPENDENT second pass on work whose SIZE makes a second pass worth minutes of latency.

The reviewer is a fresh process on the SAME model and endpoint as you, holding none of your context. It re-reads what you already read, one tool call at a time, so it is not a faster pair of eyes — it is a slower one that has to start over. Expect minutes, and expect the possibility of no output at all (aborted, or beside the point).

Delegate ONLY when the change is LARGE (roughly >300 changed lines or >5 files) AND you can write a task that needs no re-discovery — naming the files and line ranges, e.g. "review the diff of src/x.ts and src/y.ts for bugs and missed tests". Do not say "review the current diff" in a dirty worktree. For independent focuses pass a \`tasks\` array (max 8, 4 concurrent), knowing that parallel reviewers share the endpoint and all get slower.

For anything smaller, review it INLINE. Reading four hunks yourself takes about a minute and finds more than a reviewer can, because you have the context it lacks and can iterate.

Do NOT delegate when:
- The change is small enough to read in full yourself — which is most changes. Do it inline.
- The work is a judgement call about code you just wrote — your own read is the primary pass; a second opinion only pays off at scale.
- Explaining the design well enough for the task would take longer than the review — that explanation IS the review.
- You need to interact with the user (clarify, confirm) — reviewers run headless.
- The task needs writing/editing files — reviewers are read-only; ALL writes happen here in the main conversation.

The reviewer returns blocking issues, non-blocking suggestions, missing tests, evidence, and a risk summary. Treat it as independent critique: verify every specific claim against the real code before editing, then fix here. Never delegate and then skip reading the result; if it is slow, or comes back with nothing usable, do the review yourself instead of delegating again.`,
  },
  {
    name: "scout",
    label: "Scout",
    taskNoun: "reconnaissance",
    lead: [
      "Delegate read-only codebase reconnaissance to an isolated scout subagent.",
      "The scout returns a structured map (file paths + line ranges + key code + architecture) so your context stays clean.",
    ],
    guidance: `## Scout delegation (read-only reconnaissance)

You have a \`scout\` tool that delegates READ-ONLY codebase reconnaissance to an isolated subagent. Its purpose is to keep YOUR context window clean — not to be smarter than you.

Delegate when locating the answer would otherwise cost you many reads: roughly more than 10 files, or a search whose shape you cannot guess ("where does the remote session path get its agentDir?"). State the paths to search and what to return. For several independent searches pass a \`tasks\` array (max 8, 4 concurrent) — parallel scouts share your endpoint, so they all slow down, and so do you.

The scout is a fresh process on the SAME model and endpoint as you, with none of your context. It re-discovers what you may already know, so two or three greps you run yourself are almost always faster and cheaper than a scout.

Do NOT delegate when:
- You already know the file, or the lookup takes 1-2 grep/read calls — do it inline.
- You need file CONTENTS to decide something — a scout returns a map and you must re-read anyway.
- The codebase area is small — just read it.
- You need to interact with the user (clarify, confirm) — scouts run headless.
- The task needs writing/editing files — scouts are read-only; ALL writes happen here in the main conversation.

The scout returns a "map": file paths with line ranges, key types/functions, and a short architecture summary — not full file contents. After receiving the map, RE-READ the specific files you intend to edit (targeted reads with offset/limit), then edit them here. Never edit based on the map alone. If a scout is slow or returns nothing, do the search yourself rather than dispatching another.`,
  },
  {
    name: "analyst",
    label: "Analyst",
    taskNoun: "analysis",
    lead: [
      "Delegate read-only failure analysis to an isolated analyst subagent.",
      "The analyst returns root cause, evidence from log/code, likely fix, and non-causes.",
    ],
    guidance: `## Analyst delegation (read-only failure analysis)

You have an \`analyst\` tool that delegates READ-ONLY failure analysis to an isolated subagent. It reports root cause, evidence from logs and code, the likely fix, and non-causes.

Delegate when a failure is genuinely OPAQUE to you: you hold the log or the repro, but the cause lives in unfamiliar or wide code you have not read ("why does this remote tab's command list come back empty?"). Hand over the concrete evidence — log path and timestamps, the exact command, file paths — because the analyst starts with none of your context and re-reads from scratch on the SAME model and endpoint. Expect minutes, not seconds. A \`tasks\` array (max 8, 4 concurrent) covers several independent candidate causes, but they share the endpoint and all slow down.

If the trace you already hold points at the cause, reason it out inline instead of delegating at all.

Do NOT delegate when:
- The cause is visible from the trace you already hold — reason it out inline.
- The suspicious code is small or familiar — read it yourself; you will be faster and you can iterate.
- It is really a missing feature or a question for the user — analysts cannot ask.
- You need to interact with the user (clarify, confirm) — analysts run headless.
- The task needs writing/editing files — analysts are read-only; ALL writes happen here in the main conversation.

The analyst returns root cause, evidence, a likely fix, and non-causes. Verify every claim against the real code and log before acting, then make fixes here in the main conversation. If it is slow or comes back empty, analyse inline rather than delegating again.`,
  },
];
