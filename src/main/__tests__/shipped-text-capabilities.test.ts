// The shipped text may only promise what the app can deliver.
//
// `code-review` step 4 tells the model to run its two axes as ONE `reviewer`
// call carrying both briefs as `tasks`, and `grilling` names `scout`. Those are
// sub-agent runtimes, and after ADR 0013 the app no longer ships one: the
// hand-written delegation extension (extensions/delegation/*.ts, ADR 0005) is
// retired and replaced by the official `pi-subagents` package, which the app
// ENSURES in every agent home it provisions (pi-settings.ts).
//
// So the halves the app still owns are: the three agent BRIEFS
// (SHIPPED_AGENT_FILES — the text the tools load) and the ensure itself. These
// tests pin that split instead of the old "the shipped declarations really take
// a tasks array" claim, which described code we no longer maintain. The
// parallel-call schema now belongs to someone else's package: we cannot pin a
// foreign schema from our bundle, and pretending to would be the exact failure
// mode this file exists to prevent.
//
// The vendoring pipeline pins the wording: skills/manifest.json registers the
// sentence and scripts/vendor-skills.mjs throws when upstream moves it. These
// tests pin the other half — that the wording and the mechanism agree, because
// the manifest cannot see the bundle. They assert against the bytes the app
// writes to disk (SHIPPED_*), not against the source modules.
import { describe, expect, it } from "vitest";
import { SHIPPED_SKILL_FILES } from "../skill-sync";
import { SHIPPED_AGENT_FILES, SHIPPED_EXTENSION_FILES } from "../extension-sync";
import { OFFICIAL_AGENT_PACKAGES, buildOfficialPackagesClause } from "../pi-settings";

const shipped = (files: { relPath: string; content: string }[], relPath: string): string => {
  const file = files.find((f) => f.relPath === relPath);
  expect(file, `${relPath} is not in the shipped bundle`).toBeDefined();
  return file!.content;
};

const CODE_REVIEW = "engineering/code-review/SKILL.md";

/** The sub-agent names the shipped skills use, and the agent brief each has to
 *  resolve to. */
const SUBAGENT_NAMES = ["reviewer", "scout", "analyst"];

describe("the shipped text and the shipped mechanism agree", () => {
  it("a shipped skill only names sub-agents the app can actually run", () => {
    // After ADR 0013 the app does not ship the sub-agent TOOLS (the official
    // `pi-subagents` package is ensured instead) and ships only the brief that has
    // no upstream counterpart (`analyst`). What a shipped skill may name is
    // therefore: a role the official package provides, or the analyst brief we
    // ship — and it must keep its "what if there is no tool" wording (next test).
    const shippedBriefs = new Set(SHIPPED_AGENT_FILES.map((f) => f.relPath.replace(/\.md$/, "")));
    const packageRoles = new Set(["reviewer", "scout", "analyst"]);
    const offenders: string[] = [];
    for (const file of SHIPPED_SKILL_FILES) {
      for (const tool of SUBAGENT_NAMES) {
        if (!new RegExp(`\\b${tool}\\b`).test(file.content)) continue;
        if (!shippedBriefs.has(tool) && !packageRoles.has(tool)) {
          offenders.push(`${file.relPath} names \`${tool}\` which neither ships nor comes from the official package`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // No shipped extension claims to be the runtime any more (a leftover
    // delegation tree or model-sync extension is in RETIRED_FILES).
    expect(SHIPPED_EXTENSION_FILES.some((f) => f.relPath.startsWith("delegation/"))).toBe(false);
    expect(SHIPPED_EXTENSION_FILES.some((f) => f.relPath === "pipi-subagent-model.ts")).toBe(false);
    // reviewer/scout are deliberately NOT ours any more: shipping them shadowed
    // the package's maintained briefs — the duplication ADR 0013 removed.
    expect(SHIPPED_AGENT_FILES.map((f) => f.relPath)).toEqual(["analyst.md"]);
  });

  it("the sub-agent capability the code-review skill names is delivered on every machine", () => {
    const text = shipped(SHIPPED_SKILL_FILES, CODE_REVIEW);
    expect(text).toContain("reviewer");
    expect(text).toMatch(/`tasks`/);
    // Delivered by the official package: the app ensures it in every agent home it
    // provisions — locally one settings entry (pi installs it at startup), and on
    // WSL/remote the install trailer's clause.
    expect([...OFFICIAL_AGENT_PACKAGES]).toContain("npm:pi-subagents");
    expect(buildOfficialPackagesClause()).toContain("pi install npm:pi-subagents");
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
