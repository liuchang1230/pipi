// Remote connection dialog (SSH / WSL) — extracted from App.tsx (O1).
// One interface: `onClose`. The SSH/WSL form, history dropdown, connect flow
// (tab.create + waitUntilAlive) and the post-connect project-cache refresh
// are all internal. The connect flow creates the tab via window.api directly
// (a remote-connection tab is a different shape from the blank-tab action).
import { useCallback, useState } from "react";
import { useTabsStore } from "../stores/tabsStore";
import { useSessionsStore } from "../stores/sessionsStore";
import { useUiStore } from "../stores/uiStore";
import type { FileNode, SessionItem } from "../stores/types";
import { Icon } from "../components/Icon";

const showToast = (text: string, type: "ok" | "err") => useUiStore.getState().showToast(text, type);

function sameRemoteProfile(p: { host?: string; user?: string; port?: number; agentDir?: string }, host: string, user: string, port: number, agentDir: string): boolean {
  return p.host === host && p.user === user && (p.port ?? 22) === port && (p.agentDir ?? "") === (agentDir || "");
}

export function RemoteDialog({ onClose }: { onClose: () => void }) {
  const cwd = useTabsStore((s) => s.cwd);
  const projects = useSessionsStore((s) => s.projects);
  const remoteHistory = useSessionsStore((s) => s.remoteHistory);
  const setRemoteHistory = useSessionsStore((s) => s.setRemoteHistory);

  const [remoteTab, setRemoteTab] = useState<"ssh" | "wsl">("ssh");
  const [remoteHost, setRemoteHost] = useState("");
  const [remoteUser, setRemoteUser] = useState("");
  const [remotePort, setRemotePort] = useState("22");
  const [remotePath, setRemotePath] = useState("");
  const [remotePassword, setRemotePassword] = useState("");
  const [remoteAgentDir, setRemoteAgentDir] = useState("");
  // Passwords are never remembered implicitly. This is opt-in and defaults
  // off; selecting an existing remembered entry turns it on so reconnecting
  // does not silently erase that user's explicit choice.
  const [rememberPassword, setRememberPassword] = useState(false);
  const [remoteStatus, setRemoteStatus] = useState<"" | "connecting" | "connected" | "failed">("");
  const [selectedRemoteHistory, setSelectedRemoteHistory] = useState("");
  const [wslDistros, setWslDistros] = useState<Array<{ name: string; default: boolean; running: boolean; version: number }>>([]);
  const [wslDistro, setWslDistro] = useState("");
  const [wslPath, setWslPathLocal] = useState("");

  const handleRemote = useCallback(async () => {
    if (remoteTab === "wsl") {
      if (!wslDistro) return;
      setRemoteStatus("connecting");
      try {
        const id = await window.api.tab.create({
          cwd: cwd || ".",
          wsl: { distro: wslDistro, path: wslPath.trim() || undefined },
        });
        const alive = await window.api.tab.waitUntilAlive(id, 3000, 200);
        if (!alive) {
          setRemoteStatus("failed");
          showToast(`WSL 启动失败: ${wslDistro}（发行版可能未安装或已停止）`, "err");
          return;
        }
        setRemoteStatus("connected");
        showToast(`已连接 WSL: ${wslDistro}`, "ok");
        // WSL 项目不再自动创建：和 SSH 一样，通过侧边栏 🐧 区域的 + 号
        // 打开目录选择器，选目录后手动创建项目。
        setWslDistro(""); setWslPathLocal("");
        onClose();
      } catch (e) {
        setRemoteStatus("failed");
        showToast(`WSL 连接失败: ${e instanceof Error ? e.message : String(e)}`, "err");
      }
      return;
    }
    if (!remoteHost || !remoteUser) return;
    const host = remoteHost.trim();
    const user = remoteUser.trim();
    const port = parseInt(remotePort) || 22;
    const agentDir = remoteAgentDir.trim() || undefined;
    setRemoteStatus("connecting");
    try {
      // Connect = probe. No tab is created, so a successful connect never
      // changes the middle pane; the sidebar dot shows the real state.
      const probe = await window.api.remote.probe({
        host,
        user,
        port,
        path: remotePath.trim() || undefined,
        password: remotePassword || undefined,
        agentDir,
      });
      if (probe.status === "need-password") {
        setRemoteStatus("failed");
        showToast(`需要密码才能连接 ${user}@${host}（或该账号需使用密钥认证）`, "err");
        return;
      }
      if (probe.status === "failed") {
        setRemoteStatus("failed");
        showToast(`连接失败: ${user}@${host}（${probe.error ?? "请检查地址与端口"}）`, "err");
        return;
      }
      setRemoteStatus("connected");
      showToast(`已连接到 ${user}@${host}`, "ok");
      // Remembering a password is explicitly opt-in. The profile itself may
      // still be kept as a host/path bookmark, but a one-off password must not
      // become a credential just because the connection succeeded.
      try {
        setRemoteHistory(await window.api.remote.saveHistory({
          host,
          user,
          port,
          path: remotePath.trim() || undefined,
          password: rememberPassword ? (remotePassword || undefined) : undefined,
          agentDir,
        }) as typeof remoteHistory);
      } catch {
        /* history is best-effort */
      }
      // Refresh cached projects for this server now that the connection is
      // confirmed: the profile is the target for both session and file reads.
      const target = { remote: { host, user, port, path: remotePath.trim() || undefined, password: remotePassword || undefined, agentDir } };
      const ss = useSessionsStore.getState();
      const matchingProjects = projects.filter((p) => p.type === "remote" && sameRemoteProfile(p, host, user, port, agentDir ?? ""));
      for (const p of matchingProjects) {
        ss.setProjectSessionStatus((prev) => ({ ...prev, [p.id]: "loading" }));
        window.api.session.listRemote(target, p.path).then((result) => {
          ss.setProjectSessions((prev) => ({ ...prev, [p.id]: result.sessions as SessionItem[] }));
          ss.setProjectErrors((prev) => ({ ...prev, [p.id]: result.error }));
          ss.setProjectDiagnostics((prev) => ({ ...prev, [p.id]: result.diagnostics }));
          ss.setProjectSessionStatus((prev) => ({ ...prev, [p.id]: result.error ? "error" : result.sessions.length > 0 ? "ready" : "empty" }));
        }).catch(() => {
          ss.setProjectSessionStatus((prev) => ({ ...prev, [p.id]: "error" }));
        });
        window.api.file.list(target, p.path).then((nodes) => {
          ss.setProjectTrees((prev) => ({ ...prev, [p.id]: nodes as FileNode[] }));
        }).catch(() => undefined);
      }
      setRemoteHost(""); setRemoteUser(""); setRemotePort("22"); setRemotePath(""); setRemotePassword(""); setRemoteAgentDir(""); setRememberPassword(false);
      setSelectedRemoteHistory("");
      onClose();
    } catch (e) {
      console.error("[remote] failed:", e);
      setRemoteStatus("failed");
      showToast(`连接失败: ${e instanceof Error ? e.message : String(e)}`, "err");
    }
  }, [cwd, onClose, projects, remoteAgentDir, remotePort, remotePath, remotePassword, remoteHost, remoteUser, remoteTab, rememberPassword, wslDistro, wslPath]);

  return (
    <div className="dialog-overlay" onClick={() => { onClose(); setRemoteStatus(""); }}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">远程连接</div>
        <div className="dialog-tabs">
          <button className={`dialog-tab${remoteTab === "ssh" ? " active" : ""}`} onClick={() => setRemoteTab("ssh")}><Icon name="globe" /> SSH</button>
          <button className={`dialog-tab${remoteTab === "wsl" ? " active" : ""}`} onClick={() => { setRemoteTab("wsl"); window.api.wsl.listDistros().then(setWslDistros).catch(() => setWslDistros([])); }}><Icon name="penguin" /> WSL</button>
        </div>
        <div className="dialog-body">
          {remoteTab === "ssh" ? (<>
            {remoteHistory.length > 0 && (
              <label>
                历史连接
                <select
                  className="dialog-input"
                  value={selectedRemoteHistory}
                  onChange={(e) => {
                    const id = e.target.value;
                    setSelectedRemoteHistory(id);
                    const item = remoteHistory.find((h) => h.id === id);
                    if (!item) return;
                    setRemoteHost(item.host);
                    setRemoteUser(item.user);
                    setRemotePort(String(item.port || 22));
                    setRemotePassword(item.password || "");
                    setRememberPassword(!!item.password);
                    setRemotePath(item.path || "");
                    setRemoteAgentDir(item.agentDir || "");
                  }}
                >
                  <option value="">选择已保存的地址</option>
                  {remoteHistory.map((item) => (
                    <option key={item.id} value={item.id}>{item.user}@{item.host}:{item.port}{item.agentDir ? ` · ${item.agentDir}` : ""}</option>
                  ))}
                </select>
              </label>
            )}
            <label>
              主机地址
              <input className="dialog-input" value={remoteHost} onChange={(e) => setRemoteHost(e.target.value)} placeholder="192.168.1.100 或 myserver.com" autoFocus />
            </label>
            <label>
              用户名
              <input className="dialog-input" value={remoteUser} onChange={(e) => setRemoteUser(e.target.value)} placeholder="root" />
            </label>
            <label>
              端口
              <input className="dialog-input" value={remotePort} onChange={(e) => setRemotePort(e.target.value)} placeholder="22" type="number" />
            </label>
            <label>
              远程路径 <span className="dialog-hint">（可选，默认 ~）</span>
              <input className="dialog-input" value={remotePath} onChange={(e) => setRemotePath(e.target.value)} placeholder="/home/user/project" />
            </label>
            <label>
              密码 <span className="dialog-hint">（可选，免密可留空）</span>
              <input className="dialog-input" value={remotePassword} onChange={(e) => setRemotePassword(e.target.value)} placeholder="输入 SSH 密码" type="password" />
            </label>
            <label className="dialog-check">
              <input type="checkbox" checked={rememberPassword} onChange={(e) => setRememberPassword(e.target.checked)} />
              记住此服务器的密码
            </label>
            <label>
              pi 数据目录 <span className="dialog-hint">（可选，默认 ~/.pi/agent；多人共用账号时各填各的目录隔离会话）</span>
              <input className="dialog-input" value={remoteAgentDir} onChange={(e) => setRemoteAgentDir(e.target.value)} placeholder="~/pi-zhangsan/agent" />
            </label>
            <p className="dialog-note">
              终端仍通过 SSH 启动远程 <code>pi</code>。左侧文件树和右侧文件查看会使用密码或免密方式单独建立 SFTP 连接。
            </p>
          </>) : (<>
            <label>
              WSL 发行版
              <select className="dialog-input" value={wslDistro} onChange={(e) => setWslDistro(e.target.value)} autoFocus>
                <option value="">选择发行版</option>
                {wslDistros.map((d) => (
                  <option key={d.name} value={d.name}>{d.default ? "★ " : ""}{d.name}{d.running ? " (运行中)" : ""} — WSL{d.version}</option>
                ))}
              </select>
            </label>
            <label>
              工作路径 <span className="dialog-hint">（可选，默认 ~）</span>
              <input className="dialog-input" value={wslPath} onChange={(e) => setWslPathLocal(e.target.value)} placeholder="~/projects/myapp" />
            </label>
            <p className="dialog-note">
              直接通过 <code>wsl.exe</code> 进入指定发行版，无需 SSH。pi 将在 WSL 内运行。文件浏览通过 <code>\\wsl$\</code> 实现。
            </p>
          </>)}
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={() => { onClose(); setRemoteStatus(""); }}>取消</button>
          <button
            className="btn btn-primary"
            onClick={() => void handleRemote()}
            disabled={(remoteTab === "ssh" ? (!remoteHost || !remoteUser) : !wslDistro) || remoteStatus === "connecting"}
          >
            {remoteStatus === "connecting" ? "连接中…" : "连接"}
          </button>
        </div>
        {remoteStatus === "connecting" && <div className="dialog-status">{remoteTab === "wsl" ? `正在连接 WSL: ${wslDistro} …` : `正在连接 ${remoteUser}@${remoteHost} …`}</div>}
        {remoteStatus === "failed" && <div className="dialog-status dialog-status-err">连接失败，请检查地址、密码或免密配置后重试</div>}
      </div>
    </div>
  );
}
