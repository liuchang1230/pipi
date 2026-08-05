// Remote/WSL directory picker — extracted from App.tsx (O1). Browsed via the
// given tab's SFTP connection; picking a directory adds it as a project
// (SSH remote or WSL) through the sessionsStore project actions.
import { useCallback, useEffect, useState } from "react";
import { useSessionsStore } from "../stores/sessionsStore";
import type { FileNode } from "../stores/types";

export function RemoteDirPicker({ tabId, onClose }: { tabId: string; onClose: () => void }) {
  const [pickerPath, setPickerPath] = useState("~");
  const [pickerEntries, setPickerEntries] = useState<FileNode[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);

  const listDir = useCallback(
    async (dir: string) => {
      setPickerPath(dir);
      setPickerLoading(true);
      try {
        const entries = (await window.api.file.list(tabId, dir)) as FileNode[];
        setPickerEntries(entries);
      } catch {
        setPickerEntries([{ name: "（远程目录加载失败）", path: "", type: "file" }]);
      }
      setPickerLoading(false);
    },
    [tabId],
  );

  // Start from the tab's own browse path.
  useEffect(() => {
    window.api.remote.getBrowsePath(tabId).then((p) => listDir(p || "~")).catch(() => listDir("~"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  const pickerSelect = useCallback(async () => {
    const remote = await window.api.remote.getInfo(tabId);
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
        });
      }
    }
    onClose();
  }, [pickerPath, tabId, onClose]);

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} style={{ width: 480 }}>
        <div className="dialog-title">选择项目目录</div>
        <div className="dialog-body">
          <div className="picker-path">
            📂 <strong>{pickerPath.replace(/^\/home\/[^/]+/, "~")}</strong>
          </div>
          <div className="picker-list">
            {/* Always show .. unless at root */}
            {pickerPath !== "/" && (
              <div
                className="picker-row"
                onClick={() => listDir(pickerPath === "~" ? "/" : (pickerPath.replace(/\/[^/]+$/, "") || "/"))}
              >
                <span className="picker-icon">📁</span>
                <span>..</span>
              </div>
            )}
            {pickerLoading ? (
              <div className="placeholder">加载中…</div>
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
                  <span className="picker-icon">{e.type === "directory" ? "📁" : "📄"}</span>
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
