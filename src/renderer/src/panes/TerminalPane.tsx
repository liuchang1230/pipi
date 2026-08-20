// Middle pane: tab bar + one xterm per tab. Subscribes only to the tabs
// slice; tab lifecycle actions (create/close/select) are tabsStore actions,
// so the only props are the theme and the two dialog openers.
//
// Live color-scheme push lives here, keyed on theme ONLY: new tabs get their
// palette from main's COLORFGBG injection, so a running pi only needs a
// `CSI ?997` nudge when the mode actually flips. (The old effect depended on
// [theme, tabs] and re-pushed to every running pi on every tab-list change.)
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { TERMINAL_THEMES } from "../../../shared/terminal-theme";
import { openExternalSafe } from "../openExternal";
// Keep Windows IME candidate/preedit anchored to pi's visible TUI caret.
import { attachImeHeuristic } from "../xterm-ime-anchor";
import { useTabsStore } from "../stores/tabsStore";
import { useViewerStore } from "../stores/viewerStore";
import { useChatStore } from "../stores/chatStore";
import { useUiStore } from "../stores/uiStore";
import type { TabInfo } from "../stores/types";
import { ChatView } from "./ChatPane";
import { Icon } from "../components/Icon";

interface TerminalViewProps {
  tabId: string;
  theme: "dark" | "light";
  active: boolean;
  /** While true (connect notice overlay shown) the xterm must not grab
   *  focus — keystrokes would vanish into a hidden shell underneath. */
  blockFocus: boolean;
  onResize: (cols: number, rows: number) => void;
}

function TerminalView({ tabId, theme, active, blockFocus, onResize }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sizeRef = useRef({ width: 0, height: 0 });
  const themeRef = useRef(theme);
  themeRef.current = theme;

  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      fontFamily: '"Cascadia Code", "Sarasa Mono SC", "Microsoft YaHei Mono", "Noto Sans Mono CJK SC", "Microsoft YaHei", "Consolas", monospace',
      fontSize: 13,
      cursorBlink: false,
      cursorStyle: "bar",
      allowProposedApi: true,
      scrollback: 50000,
      smoothScrollDuration: 0,
      scrollOnUserInput: true,
      // pi's TUI redraws with `\x1b[2J` (ED2) inside DEC 2026 sync blocks
      // (tui.ts fullRender). xterm's default ED2 blanks the visible rows IN
      // PLACE — while the user is scrolled up reading history, pi's next
      // redraw would erase the very lines being read (xtermjs#5620/#5801,
      // same pattern as claude-code/codex). PuTTY-style: push the erased
      // rows into scrollback instead, so history survives redraws.
      scrollOnEraseInDisplay: true,
      theme: TERMINAL_THEMES[theme].xterm,
      linkHandler: {
        allowNonHttpProtocols: true,
        activate: async (_event, uri) => {
          const resolved = await window.api.file.resolveLink({ href: uri, tabId });
          if (resolved.ok) {
            await useViewerStore.getState().openFile(resolved.relPath, false, { tabId: resolved.tabId, rootPath: resolved.rootPath });
          } else {
            openExternalSafe(uri);
          }
        },
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    // fit() depends on the font measurement (cellHeight); on the FIRST call
    // the font may not be ready yet and fit() returns early (cellHeight===0
    // guard), leaving the terminal at its initial rows with a big empty band
    // of --terminal-bg below it. Retry until the rows settle: once on the
    // first render (font measured), plus a bounded fallback timer chain.
    let fitTries = 0;
    let fitTimer: ReturnType<typeof setTimeout> | null = null;
    const retryFit = () => {
      fitTimer = null;
      if (fitTries >= 15) return;
      fitTries++;
      const before = { cols: term.cols, rows: term.rows };
      try {
        fit.fit();
      } catch {
        /* container not ready */
      }
      if (term.cols !== before.cols || term.rows !== before.rows) {
        onResize(term.cols, term.rows); // pty must learn the real size
        return;
      }
      fitTimer = setTimeout(retryFit, 120); // still not measured — wait
    };
    const retryOnFirstRender = term.onRender(() => {
      retryOnFirstRender.dispose();
      retryFit();
    });
    fitTimer = setTimeout(retryFit, 300); // fallback if no render fires
    // Instant feedback while the pty/pi boots: a dim placeholder that the
    // first real frame (pi TUI / shell prompt) overwrites. Without it the
    // pane sits blank for the ~1s pi takes to start.
    term.write("\r\n\x1b[2m正在启动会话…\x1b[0m\r\n");
    termRef.current = term;
    fitRef.current = fit;
    // Focus the input textarea while THIS tab is active — xterm only
    // receives keystrokes while its helper textarea is focused, and a
    // freshly opened session starts unfocused (typing would do nothing).
    if (active) termRef.current?.focus();
    const ime = attachImeHeuristic(term);

    // Pipe user input → pty. This deliberately uses one-way IPC: invoke()
    // allocates a Promise and a reply message for every key. During pi's
    // frequent full-screen redraws that backlog can starve the renderer and
    // make Windows IME / typing look frozen.
    const disp = term.onData((data) => {
      window.api.tab.writeInput(tabId, data);
    });

    // Copy / paste handling — terminal eats Ctrl+C/V so we intercept here.
    const keyHandler = (e: KeyboardEvent) => {
      // Shift+Enter → insert newline (pi keybinding `tui.input.newLine`)
      if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && e.type === "keydown") {
        window.api.tab.writeInput(tabId, "\n");
        return false;
      }
      if (e.ctrlKey && e.key === "c" && term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection()).catch(() => {
          document.execCommand("copy");
        });
        return false;
      }
      if (e.ctrlKey && e.key === "v" && e.type === "keydown") {
        navigator.clipboard.readText().then((text) => {
          term.paste(text);
        }).catch(() => {});
        return false;
      }
      return true;
    };
    term.attachCustomKeyEventHandler(keyHandler);

    // Right-click context menu for copy/paste.
    const ctxHandler = (e: MouseEvent) => {
      e.preventDefault();
      if (term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection()).catch(() => {
          document.execCommand("copy");
        });
      } else {
        navigator.clipboard.readText().then((text) => {
          term.paste(text);
        }).catch(() => {});
      }
    };
    term.element?.addEventListener("contextmenu", ctxHandler);
    // Pipe pty output → terminal. pi queries the terminal's color scheme
    // with `CSI ? 996 n` at startup; answer it (1=dark, 2=light) so pi's
    // auto theme resolves to the app's mode deterministically, and so pi
    // keeps its color-scheme notification listener armed (auto sync).
    let schemeBuf = "";
    // Let xterm drain output once per animation frame. Calling write() for
    // every IPC delivery competes directly with keyboard/IME event handling
    // when pi redraws rapidly; batching preserves byte order while keeping
    // input responsive.
    let pendingOutput = "";
    let outputFrame: number | null = null;
    const flushOutput = () => {
      outputFrame = null;
      if (!pendingOutput) return;
      const output = pendingOutput;
      pendingOutput = "";
      term.write(output);
    };
    const offData = window.api.onTabData(tabId, (data) => {
      pendingOutput += data;
      if (outputFrame === null) outputFrame = requestAnimationFrame(flushOutput);
      schemeBuf += data;
      if (schemeBuf.includes("\x1b[?996n")) {
        schemeBuf = "";
        window.api.tab.write(tabId, themeRef.current === "dark" ? "\x1b[?997;1n" : "\x1b[?997;2n");
      } else if (schemeBuf.length > 32) {
        schemeBuf = schemeBuf.slice(-32);
      }
    });
    const offExit = window.api.onTabExit(tabId, () => {
      term.write("\r\n\x1b[2m[进程已退出]\x1b[0m\r\n");
    });

    // Report initial size.
    onResize(term.cols, term.rows);

    // Resize observer → refit + notify pty.
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const width = Math.round(entry.contentRect.width);
      const height = Math.round(entry.contentRect.height);
      if (width === sizeRef.current.width && height === sizeRef.current.height) return;
      sizeRef.current = { width, height };
      try {
        const viewportY = term.buffer.active.viewportY;
        fit.fit();
        if (viewportY > 0) term.scrollToLine(viewportY);
        onResize(term.cols, term.rows);
      } catch {
        /* container not ready */
      }
    });
    const rect = containerRef.current.getBoundingClientRect();
    sizeRef.current = { width: Math.round(rect.width), height: Math.round(rect.height) };
    ro.observe(containerRef.current);

    return () => {
      if (fitTimer) clearTimeout(fitTimer);
      term.element?.removeEventListener("contextmenu", ctxHandler);
      disp.dispose();
      if (outputFrame !== null) cancelAnimationFrame(outputFrame);
      // Do not discard output already delivered by main during unmount.
      flushOutput();
      offData();
      offExit();
      ro.disconnect();
      ime.detach();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  // Refocus when THIS tab becomes the active one (switching tabs must hand
  // the keyboard straight back to the terminal, not leave it unfocused).
  // The window-focus listener lives here too so its closure always sees the
  // CURRENT active value (a stale first-render value would skip refocus).
  // While the connect-notice overlay is up (blockFocus) keystrokes must
  // NEVER reach the shell hidden underneath — focus the overlay's button
  // instead. This also covers switching away and back (the previous tab's
  // textarea would otherwise keep focus and swallow keystrokes invisibly).
  useEffect(() => {
    if (!active) return;
    if (blockFocus) {
      containerRef.current?.closest(".terminal-pane")?.querySelector<HTMLButtonElement>(".connect-notice button")?.focus();
      return;
    }
    termRef.current?.focus();
    const onWinFocus = () => termRef.current?.focus();
    window.addEventListener("focus", onWinFocus);
    return () => window.removeEventListener("focus", onWinFocus);
  }, [active, blockFocus]);

  // Update theme without destroying the terminal.
  useEffect(() => {
    const t = termRef.current;
    if (!t) return;
    t.options.theme = TERMINAL_THEMES[theme].xterm;
  }, [theme]);

  return <div className="terminal-container" ref={containerRef} />;
}

interface TerminalHostProps {
  visibleTabs: TabInfo[];
  activeTab: string | null;
  theme: "dark" | "light";
  /** Connection tabs the user explicitly forced to a terminal view. */
  forceShell: Set<string>;
  onForceShell: (id: string) => void;
}

/** A connection shell tab (startPi:false, "· 连接" title). */
function isConnectionTab(t: TabInfo): boolean {
  return !!t.isRemote && !t.isWsl && t.title.endsWith(" · 连接");
}

function connectionLabel(t: TabInfo): string {
  return t.remoteUser && t.remoteHost ? `${t.remoteUser}@${t.remoteHost}` : t.title;
}

/** "Connected" landing page: the user connected a server but hasn't picked a
 *  project yet — show a hint instead of dropping them into a bare shell. The
 *  terminal stays mounted underneath; the button lifts this overlay. */
function ConnectNotice({ tab, onOpenTerminal }: { tab: TabInfo; onOpenTerminal: () => void }) {
  return (
    <div className="connect-notice">
      <div className="connect-notice-title">✓ 已连接到 {connectionLabel(tab)}</div>
      <div className="connect-notice-sub">从左侧选择项目开始远程编程，或点击服务器右侧 + 添加项目目录。</div>
      <div className="connect-notice-actions">
        <button className="btn" autoFocus onClick={onOpenTerminal}>打开服务器终端</button>
      </div>
    </div>
  );
}

const TerminalHost = memo(function TerminalHost({ visibleTabs, activeTab, theme, forceShell, onForceShell }: TerminalHostProps) {
  return (
    <div className="terminal-wrap">
      {visibleTabs.length === 0 ? (
        <div className="placeholder">从左侧选择一个会话开始</div>
      ) : (
        visibleTabs.map((tab) => {
          const active = tab.id === activeTab;
          // A confirmed connection lands on a notice page instead of a bare
          // shell. The terminal STAYS mounted underneath (history intact —
          // "打开服务器终端" just lifts the overlay). While still connecting
          // (or waiting at a password prompt) the terminal is the surface
          // you interact with, so no overlay yet. Failed connection tabs are
          // removed by main immediately (tab:exit → registry delete), so the
          // failure is reported by toast/sidebar, not a lingering page.
          const showNotice = isConnectionTab(tab) && tab.sshState === "ready" && !forceShell.has(tab.id);
          return (
            <div key={tab.id} className={`terminal-pane${active ? " active" : " hidden"}`}>
              {tab.mode === "rpc" || tab.mode === "sdk" ? (
                <ChatView tabId={tab.id} active={active} />
              ) : (
                <TerminalView
                  tabId={tab.id}
                  theme={theme}
                  active={active}
                  blockFocus={showNotice}
                  onResize={(cols, rows) => window.api.tab.resize(tab.id, cols, rows)}
                />
              )}
              {showNotice && <ConnectNotice tab={tab} onOpenTerminal={() => onForceShell(tab.id)} />}
            </div>
          );
        })
      )}
    </div>
  );
});

interface TabBarProps {
  visibleTabs: TabInfo[];
  activeTab: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onShowRemote: () => void;
  onShowModels: () => void;
}

const TabBar = memo(function TabBar({ visibleTabs, activeTab, onSelectTab, onCloseTab, onShowRemote, onShowModels }: TabBarProps) {
  const active = visibleTabs.find((t) => t.id === activeTab);
  // A pty-backed pi tab can switch to the chat view (local → in-process SDK,
  // remote/WSL → RPC). Chat-backed tabs (rpc/sdk) are already in the chat view.
  const canSwitchToChat = !!active && active.pi && (active.mode === "pty" || active.mode === undefined);
  const [switching, setSwitching] = useState(false);
  return (
    <div className="tab-bar">
      <div className="tabs">
        {visibleTabs.map((t) => (
          <div
            key={t.id}
            className={`tab ${activeTab === t.id ? "active" : ""}${t.isRemote ? " remote" : ""}`}
            onClick={() => onSelectTab(t.id)}
          >
            {t.isWsl && <span className="tab-remote-icon"><Icon name="penguin" /></span>}
            {t.isRemote && !t.isWsl && <span className="tab-remote-icon"><Icon name="globe" /></span>}
            <span className="tab-title">{t.title}</span>
            <button
              className="tab-close"
              onClick={(e) => { e.stopPropagation(); onCloseTab(t.id); }}
              title="关闭"
            >×</button>
          </div>
        ))}
      </div>
      {canSwitchToChat && (
        <button
          className="tab-chat"
          disabled={switching}
          onClick={async () => {
            setSwitching(true);
            try {
              // Drop stale chat state so the remounted ChatView re-boots
              // (messages + stats come from pi via --session resume).
              useChatStore.getState().clear(activeTab!);
              await window.api.tab.rpcSwitchToChat(activeTab!);
              // tabs:update flips this tab to mode "rpc"; TerminalPane re-renders.
            } catch (e) {
              useUiStore.getState().showToast(`切换到聊天视图失败: ${e instanceof Error ? e.message : String(e)}`, "err");
            } finally {
              setSwitching(false);
            }
          }}
          title="切换为聊天视图"
        >
          聊天视图
        </button>
      )}
      <button className="tab-remote" onClick={onShowModels} title="模型配置"><Icon name="robot" /></button>
      <button className="tab-remote" onClick={onShowRemote} title="远程连接"><Icon name="globe" /></button>
    </div>
  );
});

export function TerminalPane({
  theme,
  onShowRemote,
  onShowModels,
}: {
  theme: "dark" | "light";
  onShowRemote: () => void;
  onShowModels: () => void;
}) {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTab = useTabsStore((s) => s.activeTab);
  const closeTab = useTabsStore((s) => s.closeTab);
  const selectTab = useTabsStore((s) => s.selectTab);
  // Connection tabs the user explicitly asked to see as a terminal.
  const [forceShell, setForceShell] = useState<Set<string>>(() => new Set());
  const forceShellTab = useCallback((id: string) => {
    setForceShell((prev) => (prev.has(id) ? prev : new Set(prev).add(id)));
  }, []);
  // Prune closed tabs so the set never grows unboundedly across connections.
  const handleCloseTab = useCallback((id: string) => {
    setForceShell((prev) => (prev.has(id) ? new Set([...prev].filter((x) => x !== id)) : prev));
    void closeTab(id);
  }, [closeTab]);
  // Main can drop tabs without the close handler (failed connections exit
  // and are removed from the registry) — prune those ids too.
  useEffect(() => {
    setForceShell((prev) => {
      if (prev.size === 0) return prev;
      const alive = new Set(tabs.map((t) => t.id));
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [tabs]);

  // All tabs render, including connection-only shell tabs (startPi:false,
  // "· 连接"): a connected server must be visible and switchable. The sidebar
  // 远程服务器 section is the other handle onto these shells.

  // Live color-scheme push on mode flip only (deps [theme], tabs read
  // non-reactively). See file header for why the old [theme, tabs] dep was
  // wasteful.
  useEffect(() => {
    const seq = theme === "dark" ? "\x1b[?997;1n" : "\x1b[?997;2n";
    for (const tab of useTabsStore.getState().tabs) {
      if (tab.pi) {
        window.api.tab.write(tab.id, seq).catch(() => {});
      }
    }
  }, [theme]);

  return (
    <main className="main">
      <TabBar
        visibleTabs={tabs}
        activeTab={activeTab}
        onSelectTab={(id) => void selectTab(id)}
        onCloseTab={handleCloseTab}
        onShowRemote={onShowRemote}
        onShowModels={onShowModels}
      />
      <TerminalHost
        visibleTabs={tabs}
        activeTab={activeTab}
        theme={theme}
        forceShell={forceShell}
        onForceShell={forceShellTab}
      />
    </main>
  );
}
