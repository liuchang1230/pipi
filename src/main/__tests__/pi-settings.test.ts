// The keys the app manages in pi's OWN settings.json (ADR 0013): the official
// packages it needs present, and the user's sub-agent model pin. What matters is
// that both are honest and small: one idempotent entry each (pi's package manager
// installs a configured-but-missing package while it resolves settings; the
// official pi-subagents package resolves a child's model from
// `subagents.agentOverrides.<role>.model`), a file we never clobber when it is
// unreadable, and a remote clause that cannot fail the sync that carries it.
//
// The pin is also the replacement for the retired env mechanism: PI_MODEL /
// PI_PROVIDER fed only the hand-written delegation engine, so what the app writes
// here is the whole feature now — including "clearing it puts the roles back to
// following the session model".
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  OFFICIAL_AGENT_PACKAGES,
  SUBAGENT_ROLES,
  buildOfficialPackagesClause,
  ensureOfficialPackages,
  ensureSubagentModel,
  mergePackageSources,
  mergeSubagentOverrides,
} from "../pi-settings";
import { readFileSync as readSettingsFile } from "node:fs";
import { resetJsonStoreForTests } from "../json-store";

const dirs: string[] = [];
const tempHome = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "pi-settings-"));
  dirs.push(dir);
  return dir;
};
const readSettings = (home: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(home, "settings.json"), "utf8")) as Record<string, unknown>;

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
  resetJsonStoreForTests();
});

describe("mergePackageSources", () => {
  it("adds the official sources to a file that has no packages key", () => {
    const { settings, added } = mergePackageSources({ theme: "dark" }, OFFICIAL_AGENT_PACKAGES);
    expect(added).toEqual([...OFFICIAL_AGENT_PACKAGES]);
    expect(settings).toEqual({ theme: "dark", packages: [...OFFICIAL_AGENT_PACKAGES] });
  });

  it("keeps what the user already had, in their order, and adds nothing twice", () => {
    const mine = ["npm:pi-rewind@0.5.0", "npm:pi-subagents"];
    const { settings, added } = mergePackageSources({ packages: mine }, OFFICIAL_AGENT_PACKAGES);
    expect(added).toEqual([]);
    expect(settings.packages).toEqual(mine);
  });

  it("does not touch a packages value we cannot read as a list", () => {
    // `packages: "npm:something-else"` is nonsense pi cannot load either, but it
    // is THEIR nonsense: spreading that string into `packages` would silently
    // replace their file with one entry per character.
    const { settings, added } = mergePackageSources({ packages: "npm:something-else" }, OFFICIAL_AGENT_PACKAGES);
    expect(added).toEqual([]);
    expect(settings).toEqual({ packages: "npm:something-else" });
  });
});

describe("ensureOfficialPackages", () => {
  it("creates the settings file on a fresh agent home", () => {
    const home = tempHome();
    expect(ensureOfficialPackages(home)).toEqual([...OFFICIAL_AGENT_PACKAGES]);
    expect(readSettings(home)).toEqual({ packages: [...OFFICIAL_AGENT_PACKAGES] });
  });

  it("keeps every other key and is a no-op on the second run", () => {
    const home = tempHome();
    writeFileSync(
      join(home, "settings.json"),
      JSON.stringify({ model: "x/y", packages: ["npm:pi-rewind@0.5.0"], theme: "dark" }, null, 2),
      "utf8",
    );
    expect(ensureOfficialPackages(home)).toEqual([...OFFICIAL_AGENT_PACKAGES]);
    const after = readSettings(home);
    expect(after).toEqual({
      model: "x/y",
      packages: ["npm:pi-rewind@0.5.0", ...OFFICIAL_AGENT_PACKAGES],
      theme: "dark",
    });
    // Idempotent: the second startup must not rewrite the file at all.
    const bytes = readFileSync(join(home, "settings.json"), "utf8");
    expect(ensureOfficialPackages(home)).toEqual([]);
    expect(readFileSync(join(home, "settings.json"), "utf8")).toBe(bytes);
  });

  it("leaves an unparseable settings.json alone instead of overwriting it", () => {
    const home = tempHome();
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "settings.json"), "{ this is not json", "utf8");
    expect(ensureOfficialPackages(home)).toEqual([]);
    // The bytes are kept as a .corrupt-* sibling (json-store's contract), and
    // no fresh settings.json is written in their place.
    expect(existsSync(join(home, "settings.json"))).toBe(false);
    const kept = readdirSync(home).filter((f) => f.startsWith("settings.json.corrupt-"));
    expect(kept).toHaveLength(1);
    expect(readFileSync(join(home, kept[0]!), "utf8")).toBe("{ this is not json");
    // Still refused on retry — a corrupt file must not be silently replaced.
    expect(ensureOfficialPackages(home)).toEqual([]);
  });

  it("ignores a packages key of the wrong shape without rewriting the file", () => {
    const home = tempHome();
    const weird = JSON.stringify({ packages: "npm:something-else" }, null, 2);
    writeFileSync(join(home, "settings.json"), weird, "utf8");
    expect(ensureOfficialPackages(home)).toEqual([]);
    expect(readFileSync(join(home, "settings.json"), "utf8")).toBe(weird);
  });
});

describe("buildOfficialPackagesClause (remote install trailer)", () => {
  it("installs only when the package is missing, only if pi exists, and never fails", () => {
    const clause = buildOfficialPackagesClause();
    for (const source of OFFICIAL_AGENT_PACKAGES) {
      const name = source.replace(/^npm:/, "");
      expect(clause).toContain(`test -d $HOME/.pi/agent/npm/node_modules/${name}`);
      expect(clause).toContain(`pi install ${source}`);
    }
    expect(clause).toContain("command -v pi");
    // The clause rides an install payload that is quote-sensitive and must be
    // unable to fail the sync that carries it.
    expect(clause).not.toMatch(/['"]/);
    expect(clause).toMatch(/\|\| true \)/);
    expect(clause.trim().split("\n")).toHaveLength(OFFICIAL_AGENT_PACKAGES.length);
  });

  it("follows an agentDir override", () => {
    expect(buildOfficialPackagesClause("/srv/pi")).toContain("test -d /srv/pi/npm/node_modules/pi-subagents");
  });
});

describe("mergeSubagentOverrides (the 「子代理模型」 pin)", () => {
  const pin = { provider: "sf", model: "m1" };

  it("writes one fully qualified model per role, into an empty file", () => {
    const { settings, changed } = mergeSubagentOverrides({}, pin);
    expect(changed).toBe(true);
    expect(settings).toEqual({
      subagents: {
        agentOverrides: {
          analyst: { model: "sf/m1" },
          reviewer: { model: "sf/m1" },
          scout: { model: "sf/m1" },
        },
      },
    });
  });

  it("writes a bare id when no provider is known (the registry resolves it)", () => {
    const { settings } = mergeSubagentOverrides({}, { model: "m2" });
    expect((settings.subagents as never as { agentOverrides: Record<string, { model: string }> }).agentOverrides.analyst.model).toBe("m2");
  });

  it("keeps everything the user has in that file — our keys and theirs", () => {
    const before = {
      theme: "pipi-light/pipi-dark",
      packages: ["npm:pi-rewind"],
      subagents: {
        defaultModel: "cheap",
        agentOverrides: {
          oracle: { model: "their-own" },
          reviewer: { thinking: "medium" },
        },
      },
    };
    const { settings } = mergeSubagentOverrides(before as Record<string, unknown>, pin);
    const subagents = settings.subagents as Record<string, unknown>;
    expect(settings.theme).toBe("pipi-light/pipi-dark");
    expect(settings.packages).toEqual(["npm:pi-rewind"]);
    expect(subagents.defaultModel).toBe("cheap");
    expect((subagents.agentOverrides as Record<string, unknown>).oracle).toEqual({ model: "their-own" });
    // Their extra field on a role we own survives; only `model` is ours.
    expect((subagents.agentOverrides as Record<string, unknown>).reviewer).toEqual({ thinking: "medium", model: "sf/m1" });
    expect(SUBAGENT_ROLES).toHaveLength(3);
  });

  it("is a no-op (no rewrite) when the pin already matches", () => {
    const once = mergeSubagentOverrides({}, pin).settings;
    const twice = mergeSubagentOverrides(once, pin);
    expect(twice.changed).toBe(false);
    expect(twice.settings).toBe(once);
  });

  it("clearing the pin removes exactly our three model fields and prunes the rest", () => {
    const pinned = mergeSubagentOverrides({ subagents: { defaultModel: "cheap" } }, pin).settings;
    const { settings, changed } = mergeSubagentOverrides(pinned, null);
    expect(changed).toBe(true);
    expect(settings).toEqual({ subagents: { defaultModel: "cheap" } });
    // With nothing else in there, the containers go too — an unpinned install
    // must look untouched.
    const empty = mergeSubagentOverrides(mergeSubagentOverrides({}, pin).settings, null);
    expect(empty.settings).toEqual({});
  });

  it("keeps a role's other fields when the pin is cleared", () => {
    const before = { subagents: { agentOverrides: { scout: { model: "sf/m1", thinking: "low" } } } };
    const { settings } = mergeSubagentOverrides(before, null);
    expect(settings).toEqual({ subagents: { agentOverrides: { scout: { thinking: "low" } } } });
  });

  it("leaves a subagents/agentOverrides value we cannot read as an object alone", () => {
    const weird = { subagents: "nope" };
    expect(mergeSubagentOverrides(weird as Record<string, unknown>, pin)).toEqual({ settings: weird, changed: false });
    const weirdOverrides = { subagents: { agentOverrides: 7 } };
    expect(mergeSubagentOverrides(weirdOverrides as Record<string, unknown>, pin)).toEqual({ settings: weirdOverrides, changed: false });
  });
});

describe("ensureSubagentModel", () => {
  it("writes the pin into a fresh settings file and clears it again", () => {
    const home = tempHome();
    expect(ensureSubagentModel({ provider: "sf", model: "m1" }, home)).toBe(true);
    const pinned = readSettingsFile(join(home, "settings.json"), "utf8");
    expect(JSON.parse(pinned).subagents.agentOverrides.reviewer.model).toBe("sf/m1");
    // Idempotent: the second startup must not rewrite the file.
    expect(ensureSubagentModel({ provider: "sf", model: "m1" }, home)).toBe(false);
    expect(readSettingsFile(join(home, "settings.json"), "utf8")).toBe(pinned);
    // Unpin → back to "follow the session model", containers pruned.
    expect(ensureSubagentModel(null, home)).toBe(true);
    expect(JSON.parse(readSettingsFile(join(home, "settings.json"), "utf8"))).toEqual({});
  });

  it("does not touch a file it cannot parse", () => {
    const home = tempHome();
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "settings.json"), "{ not json", "utf8");
    expect(ensureSubagentModel({ provider: "sf", model: "m1" }, home)).toBe(false);
    expect(existsSync(join(home, "settings.json"))).toBe(false);
  });
});
