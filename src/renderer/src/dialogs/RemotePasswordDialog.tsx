// SSH login dialog: the ONE place a remote password is typed. The connect
// path probes the server with ssh2 (no terminal tab), and when auth needs a
// password the probe reports "need-password" — this dialog collects it,
// retries, and (opt-in) remembers it for the next connect.
import { useState } from "react";
import { Icon } from "../components/Icon";
import type { RemoteProfileTarget } from "../stores/remote-target";

export interface RemotePasswordRequest {
  remote: RemoteProfileTarget;
  /** Reason the probe gave (e.g. "认证失败（密码可能已变更）"). */
  error?: string;
}

export function RemotePasswordDialog({
  request,
  busy,
  onSubmit,
  onCancel,
}: {
  request: RemotePasswordRequest;
  busy: boolean;
  onSubmit: (password: string, remember: boolean) => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const { remote } = request;
  const label = `${remote.user}@${remote.host}${remote.port && remote.port !== 22 ? `:${remote.port}` : ""}`;
  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-title">远程登录</div>
        <div className="dialog-body">
          <div className="dialog-target">
            <Icon name="globe" /> <strong>{label}</strong>
            {remote.agentDir ? <span className="dialog-hint"> · {remote.agentDir}</span> : null}
          </div>
          {request.error && <div className="dialog-status dialog-status-err">{request.error}</div>}
          <label>
            密码
            <input
              className="dialog-input"
              type="password"
              value={password}
              autoFocus
              placeholder="输入 SSH 密码"
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && password && !busy) onSubmit(password, remember);
              }}
            />
          </label>
          <label className="dialog-check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            记住此服务器的密码
          </label>
          <p className="dialog-note">
            密码用于建立 SSH 会话与 SFTP 文件访问；勾选“记住”后保存在本机连接历史里，下次连接无需再次输入。
          </p>
        </div>
        <div className="dialog-actions">
          <button className="btn" onClick={onCancel} disabled={busy}>取消</button>
          <button className="btn btn-primary" disabled={!password || busy} onClick={() => onSubmit(password, remember)}>
            {busy ? "连接中…" : "连接"}
          </button>
        </div>
      </div>
    </div>
  );
}
