// Channel dispatch for reading a session JSONL.
//
// Regression context: the connection probe and the SFTP lease once used
// different auth material, so the sidebar went green while every file read
// failed auth. The channel rule (and the password-vs-key choice inside it) must
// live in exactly one place so the session tree, the chat transcript and any
// future reader cannot drift apart.
import { describe, expect, it, vi } from "vitest";
import { createSessionFileReader, type SessionFileHost } from "../session-file-reader";

function makeHost(): SessionFileHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    readLocal: vi.fn(async (p: string) => {
      calls.push(`local:${p}`);
      return "local";
    }),
    readWsl: vi.fn(async (d: string, p: string) => {
      calls.push(`wsl:${d}:${p}`);
      return "wsl";
    }),
    readSftp: vi.fn(async (r: { host: string }, p: string) => {
      calls.push(`sftp:${r.host}:${p}`);
      return "sftp";
    }),
    readSsh: vi.fn(async (r: { host: string }, p: string) => {
      calls.push(`ssh:${r.host}:${p}`);
      return "ssh";
    }),
  };
}

describe("createSessionFileReader", () => {
  it("reads locally when the target has neither a distro nor a remote profile", async () => {
    const host = makeHost();
    expect(await createSessionFileReader(host)({}, "/p/s.jsonl")).toBe("local");
    expect(host.calls).toEqual(["local:/p/s.jsonl"]);
  });

  it("reads through WSL's UNC path for a distro target", async () => {
    const host = makeHost();
    expect(await createSessionFileReader(host)({ wslDistro: "Ubuntu" }, "/home/u/s.jsonl")).toBe("wsl");
    expect(host.calls).toEqual(["wsl:Ubuntu:/home/u/s.jsonl"]);
  });

  it("uses SFTP for a PASSWORD remote (a lease can be established)", async () => {
    const host = makeHost();
    const target = { remote: { host: "h", user: "u", password: "pw" } };
    expect(await createSessionFileReader(host)(target, "/root/s.jsonl")).toBe("sftp");
    expect(host.calls).toEqual(["sftp:h:/root/s.jsonl"]);
  });

  it("uses ssh for a KEY-AUTH remote (no SFTP lease exists)", async () => {
    const host = makeHost();
    const target = { remote: { host: "h", user: "u" } };
    expect(await createSessionFileReader(host)(target, "/root/s.jsonl")).toBe("ssh");
    expect(host.calls).toEqual(["ssh:h:/root/s.jsonl"]);
  });

  it("treats an EMPTY password as key auth (never attempts SFTP)", async () => {
    const host = makeHost();
    const target = { remote: { host: "h", user: "u", password: "" } };
    expect(await createSessionFileReader(host)(target, "/root/s.jsonl")).toBe("ssh");
    expect(host.readSftp).not.toHaveBeenCalled();
  });

  it("prefers WSL over the remote branch when both are somehow set", async () => {
    const host = makeHost();
    const target = { wslDistro: "Ubuntu", remote: { host: "h", user: "u", password: "pw" } };
    expect(await createSessionFileReader(host)(target, "/p")).toBe("wsl");
  });

  it("passes the remote profile through UNCHANGED (the lease identity must not be narrowed)", async () => {
    // The SFTP lease pool hashes host|user|port|path|agentDir, and auth needs
    // password. Rebuilding the object here would silently split leases (two
    // connections to one server) or drop the credential.
    const host = makeHost();
    const remote = { host: "h", user: "u", port: 2222, path: "/srv", agentDir: "~/.pi/agent", password: "pw" };
    await createSessionFileReader(host)({ remote }, "/p");
    expect(host.readSftp).toHaveBeenCalledWith(remote, "/p"); // same reference, no field loss
  });

  it("propagates a transport failure so the caller can fall back to RPC", async () => {
    const host = makeHost();
    host.readLocal = vi.fn(async () => {
      throw new Error("key-auth remote read failed");
    });
    await expect(createSessionFileReader(host)({}, "/p")).rejects.toThrow("key-auth remote read failed");
  });
});
