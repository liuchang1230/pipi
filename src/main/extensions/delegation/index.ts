/**
 * Delegation tools — one engine, three declarations.
 *
 * `reviewer`, `scout` and `analyst` used to be three extensions of ~870 lines
 * each, identical apart from five declarative items; the shared ~820-line
 * engine was copied three times. They are now one extension registering three
 * tools over one engine, with the five differing items in `declarations.ts`.
 *
 * Modes (per tool):
 *   - Single:   { task: "..." }
 *   - Parallel: { tasks: [{ task: "..." }, ...] }  (max 8, 4 concurrent)
 *
 * Every spawned process is ephemeral (--no-session) and read-only; writes
 * always happen in the main conversation. A `before_agent_start` hook appends
 * the guidance of each *active* declaration to the main agent's system prompt,
 * so the main agent knows when a second pass is worth its latency.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DECLARATIONS } from "./declarations.ts";
import { registerDelegationTool } from "./engine.ts";
import { makeRenderer } from "./render.ts";

export default function (pi: ExtensionAPI) {
	// Inject delegation guidance into the main agent's system prompt: one block
	// per declaration whose tool is active, in declaration order. A tool that is
	// not selected must not advertise itself in the prompt.
	pi.on("before_agent_start", async (event) => {
		const { systemPrompt, systemPromptOptions } = event;
		const selected = systemPromptOptions?.selectedTools;
		const blocks = DECLARATIONS.filter(
			(d) => !Array.isArray(selected) || selected.includes(d.name),
		).map((d) => d.guidance);
		if (blocks.length === 0) return { systemPrompt };
		return { systemPrompt: `${systemPrompt}\n\n${blocks.join("\n\n")}` };
	});

	for (const d of DECLARATIONS) {
		registerDelegationTool(pi, d, makeRenderer(d));
	}
}
