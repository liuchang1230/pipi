// Remote/WSL directory picker — extracted from App.tsx (O1). Browsed through
// the given connection TARGET (a tab id or an explicit server profile), so a
// directory can be picked without opening a connection tab. Picking adds the
// directory as a project through the sessionsStore project actions.
import { useCallback, useEffect, useState } from "react";
import { useSessionsStore } from "../stores/sessionsStore";
import { useUiStore } from "../stores/uiStore";
import type { FileNode } from "../stores/types";
import type { TargetRef } from "../stores/remote-target";
import { Icon } from "../components/Icon";
import { useOverlayDismiss } from "../components/overlay-dismiss";

export function RemoteDirPicker({ target, onClose }: { target: TargetRef; onClose: () => void }) {
  // Press AND release on the backdrop (see overlay-dismiss.ts) — a drag from the
  // path field out of the dialog must not cancel the picker.
  const overlayDismiss = useOverlayDismiss(onClose);
  const [pickerPath, setPickerPath] = useState("~");
  const [pickerEntries, setPickerEntries] = useState<FileNode[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  /** Failure state, NOT a fake row: a placeholder entry named
   *  "（远程目录加载失败）" looks like a file and could be double-clicked to
   *  "enter" it (docs/robustness-plan.md B5). */
  const [pickerError, setPickerError] = useState("");

  const listDir = useCallback(
    async (dir: string) => {
      setPickerPath(dir);
      setPickerLoading(true);
      setPickerError("");
      try {
        const entries = (await window.api.file.list(target, dir)) as FileNode[];
        setPickerEntries(entries);
      } catch (error) {
        setPickerEntries([]);
        setPickerError(error instanceof Error ? error.message : String(error));
      }
      setPickerLoading(false);
    },
    [target],
  );

  // Start from the target's own browse path.
  useEffect(() => {
    window.api.remote.getBrowsePath(target).then((p) => listDir(p || "~")).catch(() => listDir("~"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const pickerSelectInner = useCallback(async () => {
    const remote = await window.api.remote.getInfo(target);
    if (remote) {
      const ss = useSessionsStore.getState();
      if ((remote as { isWsl?: boolean }).isWsl) {
        // WSL project: store distro + selected directory.
        await ss.addWslProject((remote as { host: string }).host, pickerPath);
      } else {
        await ss.addRemoteProject({
          host: remote.host,
          user: remote.user,
          port: remote.port,
          path: pickerPath,
          password: remote.password,
          agentDir: (remote as { agentDir?: string }).agentDir,
        });
      }
    }
    onClose();
  }, [pickerPath, target, onClose]);

  const pickerSelect = useCallback(async () => {
    try {
      await pickerSelectInner();
    } catch (error) {
      // A refused write (damaged config file, permission problem) must be
      // visible: adding the project did NOT happen.
      useUiStore.getState().showToast(error instanceof Error ? error.message : "添加项目失败", "err", { failure: true });
    }
  }, [pickerSelectInner]);

  return (
    <div className="dialog-overlay" {...overlayDismiss}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} style={{ width: 480 }}>
        <div className="dialog-title">选择项目目录</div>
        <div className="dialog-body">
          <div className="picker-path">
            <Icon name="folder-open" /> <strong>{pickerPath.replace(/^\/home\/[^/]+/, "~")}</strong>
          </div>
          <div className="picker-list">
            {/* Always show .. unless at root */}
            {pickerPath !== "/" && (
              <div
                className="picker-row"
                onClick={() => listDir(pickerPath === "~" ? "/" : (pickerPath.replace(/\/[^/]+$/, "") || "/"))}
              >
                <span className="picker-icon"><Icon name="folder" /></span>
                <span>..</span>
              </div>
            )}
            {pickerLoading ? (
              <div className="placeholder">加载中…</div>
            ) : pickerError ? (
              <div className="placeholder picker-error">
                <div>无法加载该目录：{pickerError}</div>
                <button className="btn" onClick={() => void listDir(pickerPath)}>重试</button>
              </div>
            ) : pickerEntries.length === 0 ? (
              <div className="placeholder">（空目录）</div>
            ) : (
              pickerEntries.map((e) => (
                <div
                  key={e.path}
                  className={`picker-row${e.type === "directory" ? "" : " picker-file"}`}
                  onClick={() => e.type === "directory" && listDir(e.path)}
                  onDoubleClick={() => { if (e.type === "directory") { listDir(e.path).then(() => pickerSelect()); } }}
                >
                  <span className="picker-icon"><Icon name={e.type === "directory" ? "folder" : "file"} /></span>
                  <span>{e.name}</span>
                </div>
              ))
            )}
          </div>
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={() => void pickerSelect()}>选择当前目录</button>
        </div>
      </div>
    </div>
  );
}
