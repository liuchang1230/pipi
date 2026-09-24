// The amplifier that could delete every project: `readProjects()` returned []
// for a damaged file, and the next write persisted that empty list. This test
// pins the fix — the damaged bytes are preserved, the write is refused, and the
// data is recoverable.
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetJsonStoreForTests } from "../json-store";

let userData = "";
vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => (name === "home" ? userData : userData),
    getAppPath: () => "C:\\fake\\app",
  },
}));

const { addLocalProject, listProjects, verifyConfigFiles } = await import("../projects");

const projectsFile = () => join(userData, "projects.json");
const goodProjects = [
  { id: "p1", type: "local", name: "P1", cwd: "C:\\work\\p1", createdAt: 1 },
  { id: "p2", type: "local", name: "P2", cwd: "C:\\work\\p2", createdAt: 2 },
];

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), "pipi-projects-"));
  resetJsonStoreForTests();
});
afterEach(() => {
  resetJsonStoreForTests();
  rmSync(userData, { recursive: true, force: true });
});

describe("config corruption", () => {
  it("reads a healthy file", () => {
    writeFileSync(projectsFile(), JSON.stringify(goodProjects));
    expect(listProjects().map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("does not wipe existing projects when the file is corrupt and a project is added", () => {
    writeFileSync(projectsFile(), JSON.stringify(goodProjects));
    expect(listProjects()).toHaveLength(2);

    // Something truncated the file (crash / power loss / scanner).
    writeFileSync(projectsFile(), '[{"id":"p1","type":"local"');
    expect(listProjects()).toEqual([]);

    // The user now adds a project. Before the fix this wrote [] + the new entry,
    // i.e. p1/p2 were gone forever.
    expect(() => addLocalProject("C:\\work\\p3")).toThrow(/损坏/);

    const backups = readdirSync(userData).filter((f) => f.includes("projects.json.corrupt-"));
    expect(backups).toHaveLength(1);
    // The damaged-but-recoverable bytes are still on disk verbatim.
    expect(readFileSync(join(userData, backups[0]!), "utf8")).toBe('[{"id":"p1","type":"local"');
    // The refused write left NO projects.json behind: were the guard missing, the
    // file would hold a fresh list containing only p3.
    expect(existsSync(projectsFile())).toBe(false);
  });

  it("recovers for reading as soon as the user restores the file", () => {
    writeFileSync(projectsFile(), "}}}");
    expect(listProjects()).toEqual([]);
    expect(() => addLocalProject("C:\\work\\p3")).toThrow();

    // The user restores a good file (from the .corrupt copy they repaired).
    writeFileSync(projectsFile(), JSON.stringify(goodProjects));
    expect(listProjects().map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("finds a damaged config at STARTUP, before any user action can trip it", () => {
    writeFileSync(projectsFile(), "not json");
    verifyConfigFiles();
    expect(readdirSync(userData).some((f) => f.includes(".corrupt-"))).toBe(true);
  });

  it("keeps a .bak of the previous content on a normal write", () => {
    writeFileSync(projectsFile(), JSON.stringify(goodProjects));
    addLocalProject("C:\\work\\p3");
    expect(listProjects()).toHaveLength(3);
    expect(JSON.parse(readFileSync(join(userData, "projects.json.bak"), "utf8"))).toHaveLength(2);
  });
});
