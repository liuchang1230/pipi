import { describe, expect, it } from "vitest";
import {
  buildMirrorScript,
  parseRemoteDeps,
  planMirror,
  readLocalPackages,
  specToSource,
  type MirrorSpec,
  type RemotePkg,
} from "../package-mirror";
import { DEFAULT_PACKAGE_MIRROR_SETTINGS, normalizePackageMirror } from "../../shared/package-mirror";

describe("specToSource", () => {
  it("formats the exact pi-install source form", () => {
    expect(specToSource({ name: "pi-rewind", version: "0.5.0" })).toBe("npm:pi-rewind@0.5.0");
    expect(specToSource({ name: "@juicesharp/rpiv-ask-user-question", version: "2.12.0" })).toBe(
      "npm:@juicesharp/rpiv-ask-user-question@2.12.0",
    );
  });
});

describe("readLocalPackages", () => {
  it("names from settings.json × versions from npm/package.json (the real shape: pi install records no versions)", () => {
    const specs = readLocalPackages(join2(base, "a"));
    expect(specs).toEqual([
      { name: "pi-rewind", version: "0.5.0" },
      { name: "pi-web-access", version: "0.37.0" },
    ]);
  });

  it("returns empty for a missing dir or unparseable file (never a license to wipe the remote)", () => {
    expect(readLocalPackages(join2(base, "missing"))).toEqual([]);
    expect(readLocalPackages(join2(base, "broken"))).toEqual([]);
    expect(readLocalPackages(join2(base, "empty"))).toEqual([]);
  });
});

describe("parseRemoteDeps", () => {
  it("reads the dependencies block out of shell-noisy output", () => {
    const noisy = `some motd\n{"name":"pi-extensions","dependencies":{"pi-rewind":"^0.5.0"}}\ntrailing`;
    expect(parseRemoteDeps(noisy)).toEqual([{ name: "pi-rewind", range: "^0.5.0" }]);
  });

  it("returns empty when nothing parseable is present (probe came back empty)", () => {
    expect(parseRemoteDeps("")).toEqual([]);
    expect(parseRemoteDeps("no json here")).toEqual([]);
    expect(parseRemoteDeps("{broken")).toEqual([]);
  });
});

describe("planMirror", () => {
  const wanted: MirrorSpec[] = [
    { name: "pi-rewind", version: "0.5.0" },
    { name: "pi-web-access", version: "0.37.0" },
    { name: "pi-subagents", version: "0.76.1" },
  ];

  it("installs everything when the remote has nothing", () => {
    const plan = planMirror(wanted, []);
    expect(plan.install.map((s) => s.name).sort()).toEqual(["pi-rewind", "pi-subagents", "pi-web-access"]);
    expect(plan.remove).toEqual([]);
  });

  it("treats range prefixes as agreement — a converged remote is a no-op", () => {
    const installed: RemotePkg[] = [
      { name: "pi-rewind", range: "^0.5.0" },
      { name: "pi-web-access", range: "0.37.0" },
      { name: "pi-subagents", range: "~0.76.1" },
    ];
    expect(planMirror(wanted, installed)).toEqual({ install: [], remove: [] });
  });

  it("upgrades when the pinned major differs, removes packages the local machine dropped", () => {
    const installed: RemotePkg[] = [
      { name: "pi-rewind", range: "^0.4.0" }, // older → reinstall
      { name: "pi-web-access", range: "0.37.0" }, // agree → keep
      { name: "context-mode", range: "^1.0.162" }, // dropped locally → remove
    ];
    const plan = planMirror(wanted, installed);
    expect(plan.install.map((s) => s.name)).toEqual(["pi-rewind", "pi-subagents"]);
    expect(plan.remove).toEqual(["context-mode"]);
  });

  it("matches scoped names case-insensitively", () => {
    const plan = planMirror([{ name: "@JuiceSharp/rpiv-ask-user-question", version: "2.12.0" }], [
      { name: "@juicesharp/rpiv-ask-user-question", range: "^2.12.0" },
    ]);
    expect(plan).toEqual({ install: [], remove: [] });
  });
});

describe("buildMirrorScript", () => {
  it("removes first, installs second, ends with the sentinel", () => {
    const script = buildMirrorScript({
      install: [{ name: "pi-rewind", version: "0.5.0" }],
      remove: ["context-mode"],
    });
    const lines = script.split("\n");
    expect(lines[0]).toContain("pi remove npm:context-mode");
    expect(lines[0]).toContain("|| true");
    // One line: direct install || npmmirror fallback (China servers).
    expect(lines[1]).toContain("pi install npm:pi-rewind@0.5.0 || pi install npm:pi-rewind@0.5.0 --registry=https://registry.npmmirror.com");
    expect(lines[2]).toBe("echo PIPI_MIRROR_DONE");
  });

  it("is empty when the plan is a no-op", () => {
    expect(buildMirrorScript({ install: [], remove: [] })).toBe("");
  });

  it("never contains a single quote (it may ride inside bash -ic)", () => {
    const script = buildMirrorScript({
      install: [{ name: "pi-rewind", version: "0.5.0" }],
      remove: ["x"],
    });
    expect(script).not.toContain("'");
  });
});

describe("normalizePackageMirror (shared)", () => {
  it("defaults to off and accepts only explicit true", () => {
    expect(DEFAULT_PACKAGE_MIRROR_SETTINGS).toEqual({ enabled: false });
    expect(normalizePackageMirror(undefined)).toEqual({ enabled: false });
    expect(normalizePackageMirror({ enabled: "yes" })).toEqual({ enabled: false });
    expect(normalizePackageMirror({ enabled: true })).toEqual({ enabled: true });
    expect(normalizePackageMirror(true)).toEqual({ enabled: true });
  });
});

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as join2 } from "node:path";

// Fixture dirs built once per run — readLocalPackages takes an agentDir param
// precisely so this test never depends on the machine's real ~/.pi/agent.
const base = mkdtempSync(`${tmpdir()}/pipi-pkg-mirror-`);
mkdirSync(join2(base, "a", "npm"), { recursive: true });
writeFileSync(
  join2(base, "a", "settings.json"),
  // The real shape: `pi install` records `npm:name` WITHOUT a version; the
  // installed version lives in npm/package.json's dependencies (with ^/~).
  JSON.stringify({ packages: ["npm:pi-rewind", "npm:pi-web-access", "npm:context-mode", "git:github.com/x/y"] }),
);
writeFileSync(
  join2(base, "a", "npm", "package.json"),
  JSON.stringify({ dependencies: { "pi-rewind": "^0.5.0", "pi-web-access": "0.37.0" } }),
);
mkdirSync(join2(base, "broken"), { recursive: true });
writeFileSync(join2(base, "broken", "settings.json"), "{nope");
mkdirSync(join2(base, "empty"), { recursive: true });
writeFileSync(join2(base, "empty", "settings.json"), JSON.stringify({}));
process.on("exit", () => rmSync(base, { recursive: true, force: true }));
