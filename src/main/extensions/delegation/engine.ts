/**
 * The delegation engine — one copy of what used to be three.
 *
 * Spawns a separate `pi` process (ephemeral, --no-session) per task, giving each
 * one an isolated context window, and turns its JSON event stream into results.
 * Nothing in this file knows which tool called it: names, labels and prose all
 * come from the declaration it is handed.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	getAgentDir,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, type AgentScope, discoverAgents } from "./agents.ts";
import {
	MAX_CONCURRENCY,
	MAX_PARALLEL_TASKS,
	paramDescriptions,
	toolDescription,
	type DelegationDeclaration,
} from "./declarations.ts";
import type { DelegationRenderer } from "./render.ts";

// MAX_PARALLEL_TASKS and MAX_CONCURRENCY are imported from declarations.ts:
// the tool description quotes them, so they have exactly one definition.
const COLLAPSED_ITEM_COUNT = 10;
const OUTPUT_CAP = 16 * 1024;

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SingleResult {
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

interface DelegationDetails {
	mode: "single" | "parallel";
	agentScope: AgentScope;
	projectAgentsDir: string | null;
	results: SingleResult[];
}

function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function getResultOutput(result: SingleResult): string {
	if (isFailedResult(result)) {
		return result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)";
	}
	return getFinalOutput(result.messages) || "(no output)";
}

function isConnectionErrorResult(result: SingleResult): boolean {
	const text = [result.stderr, result.errorMessage, getFinalOutput(result.messages)].filter(Boolean).join("\n").toLowerCase();
	return (
		text.includes("connection error") ||
		text.includes("econn") ||
		text.includes("fetch failed") ||
		text.includes("socket") ||
		text.includes("timeout")
	);
}

function capOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= OUTPUT_CAP) return output;

	let truncated = output.slice(0, OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, any> };

function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function writePromptToTempFile(prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-delegation-"));
	const filePath = path.join(tmpDir, "prompt.md");
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

type OnUpdateCallback = (partial: AgentToolResult<DelegationDetails>) => void;

async function runSingleAgent(
	d: DelegationDeclaration,
	defaultCwd: string,
	agents: AgentConfig[],
	task: string,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
	makeDetails: (results: SingleResult[]) => DelegationDetails,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === d.name);

	if (!agent) {
		const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
		return {
			task,
			exitCode: 1,
			messages: [],
			stderr: `No "${d.name}" agent found. Available agents: ${available}.`,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		};
	}

	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	const inheritedModel = process.env.PI_MODEL?.trim();
	const inheritedProvider = process.env.PI_PROVIDER?.trim();
	if (agent.model) {
		args.push("--model", agent.model);
	} else if (inheritedModel) {
		if (inheritedProvider) args.push("--provider", inheritedProvider);
		args.push("--model", inheritedModel);
	}
	if (agent.thinking) args.push("--thinking", agent.thinking);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SingleResult = {
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		model: agent.model ?? process.env.PI_MODEL,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: makeDetails([currentResult]),
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd: cwd ?? defaultCwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}

				if (event.type === "message_end" && event.message) {
					const msg = event.message as Message;
					currentResult.messages.push(msg);

					if (msg.role === "assistant") {
						currentResult.usage.turns++;
						const usage = msg.usage;
						if (usage) {
							currentResult.usage.input += usage.input || 0;
							currentResult.usage.output += usage.output || 0;
							currentResult.usage.cacheRead += usage.cacheRead || 0;
							currentResult.usage.cacheWrite += usage.cacheWrite || 0;
							currentResult.usage.cost += usage.cost?.total || 0;
							currentResult.usage.contextTokens += usage.totalTokens || 0;
						}
						if (!currentResult.model && msg.model) currentResult.model = msg.model;
						if (msg.stopReason) currentResult.stopReason = msg.stopReason;
						if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
					}
					emitUpdate();
				}

				if (event.type === "tool_result_end" && event.message) {
					currentResult.messages.push(event.message as Message);
					emitUpdate();
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr.on("data", (data) => {
				currentResult.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolve(code ?? 0);
			});

			proc.on("error", () => {
				resolve(1);
			});

			if (signal) {
				const killProc = () => {
					wasAborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, 5000);
				};
				if (signal.aborted) killProc();
				else signal.addEventListener("abort", killProc, { once: true });
			}
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error(`${d.label} was aborted`);

		if (isConnectionErrorResult(currentResult) && (agent.model || agent.thinking || process.env.PI_MODEL)) {
			const retryResult = await runSingleAgent(
				d,
				defaultCwd,
				[{ ...agent, model: undefined, thinking: undefined }],
				task,
				cwd,
				signal,
				onUpdate,
				makeDetails,
			);
			retryResult.stderr = [
				`Retried with default model after configured model failed (${agent.model ?? process.env.PI_MODEL ?? "default"}).`,
				currentResult.stderr ? `Initial stderr: ${currentResult.stderr.trim()}` : undefined,
				currentResult.errorMessage ? `Initial error: ${currentResult.errorMessage}` : undefined,
				retryResult.stderr,
			]
				.filter(Boolean)
				.join("\n");
			return retryResult;
		}

		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}

/** The parameter schema, built from the declarations' text. */
function delegationParams(d: DelegationDeclaration) {
	const p = paramDescriptions(d);
	const TaskItem = Type.Object({
		task: Type.String({ description: p.task }),
		cwd: Type.Optional(Type.String({ description: p.cwdItem })),
	});
	const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
		description: p.agentScope,
		default: "user",
	});
	return Type.Object({
		task: Type.Optional(Type.String({ description: p.taskSingle })),
		tasks: Type.Optional(Type.Array(TaskItem, { description: p.tasks })),
		cwd: Type.Optional(Type.String({ description: p.cwdSingle })),
		agentScope: Type.Optional(AgentScopeSchema),
		confirmProjectAgents: Type.Optional(
			Type.Boolean({ description: p.confirm, default: true }),
		),
	});
}

/** Registers this declaration's tool on the shared engine. */
export function registerDelegationTool(
	pi: ExtensionAPI,
	d: DelegationDeclaration,
	render: DelegationRenderer,
): void {
	pi.registerTool({
		name: d.name,
		label: d.label,
		description: toolDescription(d, path.join(getAgentDir(), "agents"), CONFIG_DIR_NAME),
		parameters: delegationParams(d),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const agentScope: AgentScope = params.agentScope ?? "user";
			const discovery = discoverAgents(ctx.cwd, agentScope);
			const agents = discovery.agents;
			const confirmProjectAgents = params.confirmProjectAgents ?? true;

			const hasTasks = (params.tasks?.length ?? 0) > 0;
			const hasSingle = Boolean(params.task);
			const makeDetails =
				(mode: "single" | "parallel") =>
				(results: SingleResult[]): DelegationDetails => ({
					mode,
					agentScope,
					projectAgentsDir: discovery.projectAgentsDir,
					results,
				});

			if (hasTasks === hasSingle) {
				const available = agents.map((a) => `${a.name} (${a.source})`).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Invalid parameters. Provide exactly one of: task (single) or tasks (parallel).\nAvailable agents: ${available}`,
						},
					],
					details: makeDetails("single")([]),
				};
			}

			// Confirmation gate for project-local agents.
			if ((agentScope === "project" || agentScope === "both") && confirmProjectAgents && ctx.hasUI) {
				const found = agents.find((a) => a.name === d.name);
				if (found?.source === "project") {
					const dir = discovery.projectAgentsDir ?? "(unknown)";
					const ok = await ctx.ui.confirm(
						`Run project-local ${d.name}?`,
						`Agent: ${d.name}\nSource: ${dir}\n\nProject agents are repo-controlled. Only continue for trusted repositories.`,
					);
					if (!ok)
						return {
							content: [{ type: "text", text: `Canceled: project-local ${d.name} not approved.` }],
							details: makeDetails(hasTasks ? "parallel" : "single")([]),
						};
				}
			}

			if (params.tasks && params.tasks.length > 0) {
				if (params.tasks.length > MAX_PARALLEL_TASKS)
					return {
						content: [
							{
								type: "text",
								text: `Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
							},
						],
						details: makeDetails("parallel")([]),
					};

				const allResults: SingleResult[] = new Array(params.tasks.length);
				for (let i = 0; i < params.tasks.length; i++) {
					allResults[i] = {
						task: params.tasks[i].task,
						exitCode: -1, // -1 = still running
						messages: [],
						stderr: "",
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
					};
				}

				const emitParallelUpdate = () => {
					if (onUpdate) {
						const running = allResults.filter((r) => r.exitCode === -1).length;
						const done = allResults.filter((r) => r.exitCode !== -1).length;
						onUpdate({
							content: [
								{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` },
							],
							details: makeDetails("parallel")([...allResults]),
						});
					}
				};

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (t, index) => {
					const result = await runSingleAgent(
						d,
						ctx.cwd,
						agents,
						t.task,
						t.cwd,
						signal,
						(partial) => {
							if (partial.details?.results[0]) {
								allResults[index] = partial.details.results[0];
								emitParallelUpdate();
							}
						},
						makeDetails("parallel"),
					);
					allResults[index] = result;
					emitParallelUpdate();
					return result;
				});

				const successCount = results.filter((r) => !isFailedResult(r)).length;
				const summaries = results.map((r) => {
					const output = capOutput(getResultOutput(r));
					const status = isFailedResult(r)
						? `failed${r.stopReason && r.stopReason !== "end" ? ` (${r.stopReason})` : ""}`
						: "completed";
					return `### [${d.name}] ${status}\n\n${output}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: makeDetails("parallel")(results),
				};
			}

			// Single mode
			const result = await runSingleAgent(
				d,
				ctx.cwd,
				agents,
				params.task!,
				params.cwd,
				signal,
				onUpdate,
				makeDetails("single"),
			);
			if (isFailedResult(result)) {
				const errorMsg = getResultOutput(result);
				return {
					content: [{ type: "text", text: `${d.label} ${result.stopReason || "failed"}: ${errorMsg}` }],
					details: makeDetails("single")([result]),
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: capOutput(getFinalOutput(result.messages)) || "(no output)" }],
				details: makeDetails("single")([result]),
			};
		},
		...render,
	});
}
