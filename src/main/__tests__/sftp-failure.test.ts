// Remote CONNECT failure classification: it decides between "ask the user for a
// password" and "retry shortly", and keeps the SFTP circuit breaker from
// tripping on a merely-missing path.
import { describe, expect, it } from "vitest";
import { describeConnectFailure, isSftpPathError, isSshAuthError } from "../sftp-failure";

const authErr = (message: string) => Object.assign(new Error(message), { level: "client-authentication" });
const pathErr = () => Object.assign(new Error("list: No such file"), { code: 2 });

describe("isSshAuthError", () => {
  it("recognizes ssh2's authentication level", () => {
    expect(isSshAuthError(authErr("All configured authentication methods failed"))).toBe(true);
  });

  it("recognizes the phrasings a wrapped client error keeps", () => {
    expect(isSshAuthError(new Error("Permission denied (publickey,password)."))).toBe(true);
    expect(isSshAuthError(new Error("connect: All configured authentication methods failed"))).toBe(true);
    expect(isSshAuthError(new Error("No supported authentication methods available"))).toBe(true);
  });

  it("does not treat transport or path failures as auth", () => {
    expect(isSshAuthError(pathErr())).toBe(false);
    expect(isSshAuthError(new Error("connect ECONNREFUSED 1.2.3.4:22"))).toBe(false);
    expect(isSshAuthError(new Error("Timed out while waiting for handshake"))).toBe(false);
    expect(isSshAuthError(undefined)).toBe(false);
    expect(isSshAuthError("permission denied")).toBe(false); // plain string: not inspected
  });
});

describe("isSftpPathError", () => {
  it("matches status 2 / ENOENT / the SSH text", () => {
    expect(isSftpPathError(pathErr())).toBe(true);
    expect(isSftpPathError(new Error("get: No such file"))).toBe(true);
    expect(isSftpPathError(authErr("All configured authentication methods failed"))).toBe(false);
  });
});

describe("describeConnectFailure", () => {
  it("prefers the actionable auth phrasing", () => {
    expect(describeConnectFailure(authErr("All configured authentication methods failed"))).toContain("认证失败");
  });

  it("maps the common transport failures to short Chinese reasons", () => {
    expect(describeConnectFailure(new Error("Timed out while waiting for handshake"))).toContain("超时");
    expect(describeConnectFailure(new Error("connect ECONNREFUSED 1.2.3.4:22"))).toContain("拒绝连接");
    expect(describeConnectFailure(new Error("getaddrinfo ENOTFOUND nope.invalid"))).toContain("主机名");
    expect(describeConnectFailure(new Error("read ECONNRESET"))).toContain("重置");
  });

  it("strips the sftp-client method prefix and bounds the length", () => {
    expect(describeConnectFailure(new Error("connect: something odd"))).toBe("something odd");
    expect(describeConnectFailure(new Error("x".repeat(500))).length).toBeLessThanOrEqual(160);
    expect(describeConnectFailure(undefined)).toBe("连接失败");
  });
});
