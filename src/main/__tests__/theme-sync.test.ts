// syncThemesViaSftp: the remote push that arms pi's autoSync on a server.
// Regression pin: ssh2-sftp-client's put() treats a STRING argument as a LOCAL
// file path, so raw content MUST be passed as a Buffer — otherwise the remote
// never receives the theme files/settings and the DSR live-switch is ignored.
import { describe, expect, it, vi } from "vitest";
import { syncThemesViaSftp, AUTO_THEME_SETTING } from "../theme-sync";

function makeClient() {
  const puts: Array<{ buffer: Buffer; remote: string }> = [];
  const client = {
    mkdir: vi.fn().mockResolvedValue(undefined),
    put: vi.fn((src: string | Buffer, remote: string) => {
      if (typeof src === "string") {
        return Promise.reject(new Error(`Bad path: ${src.slice(0, 40)}…`));
      }
      puts.push({ buffer: src, remote });
      return Promise.resolve(undefined);
    }),
    get: vi.fn().mockRejectedValue(new Error("no settings yet")),
    rename: vi.fn().mockResolvedValue(undefined),
  };
  return { client, puts };
}

describe("syncThemesViaSftp", () => {
  it("uploads both theme files as Buffers (never raw strings)", async () => {
    const { client, puts } = makeClient();
    const result = await syncThemesViaSftp(client as never, "/home/crscu");

    expect(result.ok).toBe(true);
    const remoteFiles = puts.map((p) => p.remote);
    expect(remoteFiles).toContain("/home/crscu/.pi/agent/themes/pipi-dark.json");
    expect(remoteFiles).toContain("/home/crscu/.pi/agent/themes/pipi-light.json");
    for (const p of puts) expect(p.buffer).toBeInstanceOf(Buffer);
    // Settings merge only happens AFTER the theme files succeeded.
    expect(client.mkdir).toHaveBeenCalledWith("/home/crscu/.pi/agent/themes", true);
  });

  it("writes the auto-mapping theme setting so pi arms its autoSync", async () => {
    const { client, puts } = makeClient();
    client.get.mockResolvedValue(Buffer.from(JSON.stringify({ theme: "dark" })));
    await syncThemesViaSftp(client as never, "/home/crscu");

    const settingsPut = puts.find((p) => p.remote.endsWith("settings.json"));
    expect(settingsPut).toBeDefined();
    const merged = JSON.parse(settingsPut!.buffer.toString("utf8"));
    // pi auto mapping: light half = pipi-light, dark half = pipi-dark.
    expect(merged.theme).toBe(AUTO_THEME_SETTING);
  });

  it("fails gracefully (ok:false) when a theme file upload fails", async () => {
    const { client } = makeClient();
    client.put.mockRejectedValueOnce(new Error("sftp boom"));
    const result = await syncThemesViaSftp(client as never, "/home/crscu");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("theme files");
  });
});
