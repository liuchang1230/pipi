// Remote/WSL directory picker — extracted from App.tsx (O1). Browsed through
// the given connection TARGET (a tab id or an explicit server profile), so a
// directory can be picked without opening a connection tab. Picking adds the
// directory as a project through the sessionsStore project actions.
import { useCallback, useEffect, useState } from "react";
import { useSessionsStore } from "../stores/sessionsStore";
import type { FileNode } from "../stores/types";
import type { TargetRef } from "../stores/remote-target";
import { Icon } from "../components/Icon";

export function RemoteDirPicker({ target, onClose }: { target: TargetRef; onClose: () => void }) {
  const [pickerPath, setPickerPath] = useState("~");
  const [pickerEntries, setPickerEntries] = useState<FileNode[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);

  const listDir = useCallback(
    async (dir: string) => {
      setPickerPath(dir);
      setPickerLoading(true);
      try {
        const entries = (await window.api.file.list(target, dir)) as FileNode[];
        setPickerEntries(entries);
      } catch {
        setPickerEntries([{ name: "（远程目录加载失败）", path: "", type: "file" }]);
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

  const pickerSelect = useCallback(async () => {
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

  return (
    <div className="dialog-overlay" onClick={onClose}>
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
