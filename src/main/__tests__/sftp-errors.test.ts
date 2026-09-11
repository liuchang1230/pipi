// ssh2-sftp-client error classification — pure logic.
//
// A missing session dir is routine (pi creates it lazily), so the remote
// session listing must read it as an empty list exactly like the local
// SessionIndex does. The predicate must accept the real ssh2 shapes (numeric
// SFTP status 2 / ENOENT / the client's "<method>: <message>" wrapper) and
// reject everything else (auth, permission, network), which must stay hard
// errors.
import { describe, expect, it } from "vitest";
import { isSftpMissingPathError } from "../sftp-errors";

describe("isSftpMissingPathError", () => {
  it("accepts numeric SFTP status 2 (SSH_FX_NO_SUCH_FILE)", () => {
    const e = Object.assign(new Error("list: No such file /home/u/.pi/agent/sessions/--x--"), { code: 2 });
    expect(isSftpMissingPathError(e)).toBe(true);
  });

  it("accepts the string code form", () => {
    expect(isSftpMissingPathError(Object.assign(new Error("list: No such file"), { code: "2" }))).toBe(true);
  });

  it("accepts the client's ENOENT alias", () => {
    expect(isSftpMissingPathError(Object.assign(new Error("stat: no such file"), { code: "ENOENT" }))).toBe(true);
  });

  it("accepts a bare ssh2 message with no code", () => {
    expect(isSftpMissingPathError(new Error("list: No such file /x"))).toBe(true);
  });

  it("rejects permission errors", () => {
    const e = Object.assign(new Error("list: Permission denied /root/.pi"), { code: 3 });
    expect(isSftpMissingPathError(e)).toBe(false);
  });

  it("rejects a dead channel", () => {
    expect(isSftpMissingPathError(new Error("get: No SFTP connection available"))).toBe(false);
  });

  it("rejects network errors", () => {
    expect(isSftpMissingPathError(Object.assign(new Error("connect: Remote host refused connection"), { code: "ECONNREFUSED" }))).toBe(false);
  });

  it("rejects null/undefined/strings", () => {
    expect(isSftpMissingPathError(null)).toBe(false);
    expect(isSftpMissingPathError(undefined)).toBe(false);
    expect(isSftpMissingPathError("No such file")).toBe(false);
  });
});
