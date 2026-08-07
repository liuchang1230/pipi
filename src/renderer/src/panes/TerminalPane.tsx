// Middle pane: tab bar + one xterm per tab. Subscribes only to the tabs
// slice; tab lifecycle actions (create/close/select) are tabsStore actions,
// so the only props are the theme and the two dialog openers.
//
// Live color-scheme push lives here, keyed on theme ONLY: new tabs get their
// palette from main's COLORFGBG injection, so a running pi only needs a
// `CSI ?997` nudge when the mode actually flips. (The old effect depended on
// [theme, tabs] and re-pushed to every running pi on every tab-list change.)
import { memo, useEffect, useMemo, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { TERMINAL_THEMES } from "../../../shared/terminal-theme";
import { openExternalSafe } from "../openExternal";
// Keep Windows IME candidate/preedit anchored to pi's visible TUI caret.
import { attachImeHeuristic } from "../xterm-ime-anchor";
import { useTabsStore } from "../stores/tabsStore";
import { useViewerStore } from "../stores/viewerStore";
import type { TabInfo } from "../stores/types";
import { ChatView } from "./ChatPane";

interface TerminalViewProps {
  tabId: string;
  theme: "dark" | "light";
  onResize: (cols: number, rows: number) => void;
}

function TerminalView({ tabId, theme, onResize }: TerminalViewProps) {
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
    const ime = attachImeHeuristic(term);

    // Pipe user input → pty.
    const disp = term.onData((data) => {
      window.api.tab.write(tabId, data);
    });

    // Copy / paste handling — terminal eats Ctrl+C/V so we intercept here.
    const keyHandler = (e: KeyboardEvent) => {
      // Shift+Enter → insert newline (pi keybinding `tui.input.newLine`)
      if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && e.type === "keydown") {
        window.api.tab.write(tabId, "\n");
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
    const offData = window.api.onTabData(tabId, (data) => {
      term.write(data);
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
      offData();
      offExit();
      ro.disconnect();
      ime.detach();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

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
}

const TerminalHost = memo(function TerminalHost({ visibleTabs, activeTab, theme }: TerminalHostProps) {
  return (
    <div className="terminal-wrap">
      {visibleTabs.length === 0 ? (
        <div className="placeholder">点击 + 开始（或从左侧选择一个会话）</div>
      ) : (
        visibleTabs.map((tab) => (
          <div key={tab.id} className={`terminal-pane${tab.id === activeTab ? " active" : " hidden"}`}>
            {tab.mode === "rpc" ? (
              <ChatView tabId={tab.id} />
            ) : (
              <TerminalView
                tabId={tab.id}
                theme={theme}
                onResize={(cols, rows) => window.api.tab.resize(tab.id, cols, rows)}
              />
            )}
          </div>
        ))
      )}
    </div>
  );
});

interface TabBarProps {
  visibleTabs: TabInfo[];
  activeTab: string | null;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
  onShowRemote: () => void;
  onShowModels: () => void;
}

const TabBar = memo(function TabBar({ visibleTabs, activeTab, onSelectTab, onCloseTab, onNewTab, onShowRemote, onShowModels }: TabBarProps) {
  return (
    <div className="tab-bar">
      <div className="tabs">
        {visibleTabs.map((t) => (
          <div
            key={t.id}
            className={`tab ${activeTab === t.id ? "active" : ""}${t.isRemote ? " remote" : ""}`}
            onClick={() => onSelectTab(t.id)}
          >
            {t.isWsl && <span className="tab-remote-icon">🐧</span>}
            {t.isRemote && !t.isWsl && <span className="tab-remote-icon">🌐</span>}
            <span className="tab-title">{t.title}</span>
            <button
              className="tab-close"
              onClick={(e) => { e.stopPropagation(); onCloseTab(t.id); }}
              title="关闭"
            >×</button>
          </div>
        ))}
      </div>
      <button className="tab-new" onClick={onNewTab} title="新标签（新建空白会话）">+</button>
      <button className="tab-remote" onClick={onShowModels} title="模型配置">🤖</button>
      <button className="tab-remote" onClick={onShowRemote} title="远程连接">🌐</button>
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
  const createTab = useTabsStore((s) => s.createTab);
  const closeTab = useTabsStore((s) => s.closeTab);
  const selectTab = useTabsStore((s) => s.selectTab);

  const visibleTabs = useMemo(() => tabs.filter((t) => !t.title.endsWith(" · 连接")), [tabs]);

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
        visibleTabs={visibleTabs}
        activeTab={activeTab}
        onSelectTab={(id) => void selectTab(id)}
        onCloseTab={(id) => void closeTab(id)}
        onNewTab={() => void createTab()}
        onShowRemote={onShowRemote}
        onShowModels={onShowModels}
      />
      <TerminalHost visibleTabs={visibleTabs} activeTab={activeTab} theme={theme} />
    </main>
  );
}
