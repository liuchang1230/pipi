// Project labels: the tab record is the only honest source for "where does this
// session run", and for remote tabs `cwd` is the LOCAL path — using it would
// label a /data/liuchang/… session as "agent".
import { describe, expect, it } from "vitest";
import { projectLabelForTab, tabHoverInfo } from "../project-label";
import type { TabInfo } from "../stores/types";

const tab = (over: Partial<TabInfo>): TabInfo => ({ id: "t", cwd: "", title: "", pi: true, ...over });

describe("projectLabelForTab", () => {
  it("uses the local cwd for a local tab", () => {
    expect(projectLabelForTab(tab({ cwd: "D:/其余文件/项目/agent" }))).toEqual({
      short: "agent",
      full: "D:/其余文件/项目/agent",
    });
  });

  it("prefers the remote project dir over the misleading local cwd", () => {
    const label = projectLabelForTab(
      tab({
        cwd: "D:/其余文件/项目/agent", // the app-side cwd a new tab would inherit
        isRemote: true,
        remoteHost: "192.168.10.49",
        remoteUser: "crscu",
        remoteDir: "/data/liuchang/CRSCU Intelligence Algorithm Platform",
      }),
    );
    expect(label).toEqual({
      short: "CRSCU Intelligence Algorithm Platform",
      full: "crscu@192.168.10.49:/data/liuchang/CRSCU Intelligence Algorithm Platform",
    });
  });

  it("falls back to the host when the remote dir is unknown or home", () => {
    expect(projectLabelForTab(tab({ isRemote: true, remoteUser: "root", remoteHost: "10.0.0.2" }))).toEqual({
      short: "root@10.0.0.2",
      full: "root@10.0.0.2",
    });
    expect(
      projectLabelForTab(tab({ isRemote: true, remoteUser: "root", remoteHost: "10.0.0.2", remoteDir: "~" })),
    ).toEqual({ short: "root@10.0.0.2", full: "root@10.0.0.2" });
  });

  it("labels WSL tabs with the distro", () => {
    expect(
      projectLabelForTab(tab({ isWsl: true, isRemote: true, wslDistro: "Ubuntu", remoteDir: "/home/me/app" })),
    ).toEqual({ short: "app", full: "WSL Ubuntu:/home/me/app" });
  });

  it("has nothing to say without a record or a cwd", () => {
    expect(projectLabelForTab(undefined)).toBeNull();
    expect(projectLabelForTab(null)).toBeNull();
    expect(projectLabelForTab(tab({ cwd: "" }))).toBeNull();
  });
});

// The hover card exists because the strip truncates the label to 140px: it must
// carry the WHOLE session label plus the location, and must not render an empty
// box for a record main has not filled in yet.
describe("tabHoverInfo", () => {
  it("shows the full session label with where it runs", () => {
    const label = tabHoverInfo(
      tab({
        title: "基于悬挂异物_人检测v4模型，对悬挂异物_人检测数据集v5版本数据集进行训练，请",
        isRemote: true,
        remoteHost: "192.168.10.49",
        remoteUser: "crscu",
        remoteDir: "/data/liuchang/CRSCU Intelligence Algorithm Platform",
      }),
    );
    expect(label).toEqual({
      title: "基于悬挂异物_人检测v4模型，对悬挂异物_人检测数据集v5版本数据集进行训练，请",
      path: "crscu@192.168.10.49:/data/liuchang/CRSCU Intelligence Algorithm Platform",
    });
  });

  it("falls back to the project name when the label is empty (optimistic tab)", () => {
    expect(tabHoverInfo(tab({ cwd: "D:/work/agent", title: "   " }))).toEqual({
      title: "agent",
      path: "D:/work/agent",
    });
  });

  it("has nothing to show for a tab with neither label nor location", () => {
    expect(tabHoverInfo(undefined)).toBeNull();
    expect(tabHoverInfo(null)).toBeNull();
    expect(tabHoverInfo(tab({ cwd: "", title: "" }))).toBeNull();
  });
});
