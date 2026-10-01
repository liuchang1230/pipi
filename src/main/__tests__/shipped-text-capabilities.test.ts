// The shipped text may only promise what we also ship.
//
// `code-review` step 4 tells the model to run its two axes as ONE `reviewer`
// call carrying both briefs as `tasks`. That sentence is honest exactly while
// the delegation layer ships and really does run a `tasks` array in parallel —
// otherwise every user gets a step that cannot run, silently, in one context
// (which is the defect ADR 0005 fixed on the delivery side).
//
// The vendoring pipeline pins the wording: skills/manifest.json registers the
// sentence and scripts/vendor-skills.mjs throws when upstream moves it. These
// tests pin the other half — that the wording and the mechanism agree, because
// the manifest cannot see the bundle. They assert against the bytes the app
// writes to disk (SHIPPED_*), not against the source modules.
import { describe, expect, it } from "vitest";
import { SHIPPED_SKILL_FILES } from "../skill-sync";
import { SHIPPED_AGENT_FILES, SHIPPED_EXTENSION_FILES } from "../extension-sync";

const shipped = (files: { relPath: string; content: string }[], relPath: string): string => {
  const file = files.find((f) => f.relPath === relPath);
  expect(file, `${relPath} is not in the shipped bundle`).toBeDefined();
  return file!.content;
};

const CODE_REVIEW = "engineering/code-review/SKILL.md";

/** The capability layer's tool names — the only pi tool names we both own and
 *  ship. A mention of one of these in a shipped skill is a promise the app has
 *  to keep on every machine it installs pi onto. */
const DELEGATION_TOOLS = ["reviewer", "scout", "analyst"];

describe("the shipped text and the shipped mechanism agree", () => {
  it("no shipped skill names a delegation tool whose agent file is not shipped", () => {
    const agents = new Set(SHIPPED_AGENT_FILES.map((f) => f.relPath));
    const offenders: string[] = [];
    for (const file of SHIPPED_SKILL_FILES) {
      for (const tool of DELEGATION_TOOLS) {
        if (!new RegExp(`\\b${tool}\\b`).test(file.content)) continue;
        if (!agents.has(`${tool}.md`)) offenders.push(`${file.relPath} names \`${tool}\` but agents/${tool}.md is not shipped`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the reviewer tool the code-review skill names really takes a parallel tasks array", () => {
    const text = shipped(SHIPPED_SKILL_FILES, CODE_REVIEW);
    expect(text).toContain("reviewer");
    expect(text).toMatch(/`tasks`/);

    const declarations = shipped(SHIPPED_EXTENSION_FILES, "delegation/declarations.ts");
    expect(declarations).toContain('name: "reviewer"');
    const maxParallel = Number(/MAX_PARALLEL_TASKS = (\d+)/.exec(declarations)?.[1]);
    expect(maxParallel, "reviewer must be able to run both axes in one call").toBeGreaterThanOrEqual(2);
  });

  it("the code-review text says what to do when there is no sub-agent tool", () => {
    const text = shipped(SHIPPED_SKILL_FILES, CODE_REVIEW);
    // Vocabulary, not wording: the manifest patch is free to rephrase as long as
    // it keeps (a) naming the absence of the capability and (b) requiring the
    // report to disclose which mode ran. Sequential is not independent.
    const namesAbsence = /no such tool|not available|isn't available|without the `reviewer` tool/i;
    const requiresDisclosure = /say so|say which mode|state which mode|note this in the final report/i;
    expect(text).toMatch(namesAbsence);
    expect(text).toMatch(requiresDisclosure);
  });

  it("the always-loaded description does not promise the capability outright", () => {
    // A skill's description sits in context every turn, whether or not the skill
    // fires — so an unconditional claim there is the most expensive place to be
    // wrong. The mechanism and its fallback belong in the body.
    const description = /^description:\s*(.*)$/m.exec(shipped(SHIPPED_SKILL_FILES, CODE_REVIEW))?.[1] ?? "";
    expect(description).not.toBe("");
    expect(description.toLowerCase()).not.toContain("parallel sub-agent");
  });

  it("grilling's sub-agent instruction names the mechanism and the degrade", () => {
    const text = shipped(SHIPPED_SKILL_FILES, "productivity/grilling/SKILL.md");
    expect(text).toContain("scout");
    // The degrade: no sub-agent tool → look it up inline and DISCLOSE it, not
    // silently skip fact-finding or invent a tool that isn't there.
    expect(text).toMatch(/If no sub-agent tool exists/);
    expect(text).toMatch(/note in the round that you did so/);
  });
});
