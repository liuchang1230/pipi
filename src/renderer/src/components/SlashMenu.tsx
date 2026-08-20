/**
 * SlashMenu: the "/" command popup above the chat input. Presentational —
 * the parent owns the open state, the query and the selected index (keyboard
 * navigation lives in ChatPane's onKeyDown so the textarea keeps focus).
 */
import { memo, useEffect, useMemo, useRef } from "react";
import { commandGroupLabel, filterCommands, sourceIcon, sourceLabel, type SessionCommand } from "../commands";
import { Icon } from "./Icon";

interface SlashMenuProps {
  commands: SessionCommand[];
  query: string;
  selectedIndex: number;
  onSelect: (cmd: SessionCommand) => void;
  onHover: (index: number) => void;
}

export const SlashMenu = memo(function SlashMenu({ commands, query, selectedIndex, onSelect, onHover }: SlashMenuProps) {
  const list = useMemo(() => filterCommands(commands, query), [commands, query]);
  const selRef = useRef<HTMLDivElement>(null);
  // Keep the keyboard selection visible when arrows move it past the fold.
  useEffect(() => {
    selRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, query]);
  let lastGroup: SessionCommand["source"] | null = null;
  return (
    <div className="slash-menu">
      <div className="slash-menu-title">
        {query ? `“/${query}” 匹配 ${list.length} 个命令` : `${commands.length} 个可用命令`}
      </div>
      {list.length === 0 ? (
        <div className="slash-menu-empty">无匹配命令 — 输入 / 查看全部</div>
      ) : (
        list.map((c, i) => {
          const showGroup = c.source !== lastGroup;
          lastGroup = c.source;
          return (
            <div key={c.source + ":" + c.name}>
              {showGroup && <div className="slash-menu-group">{commandGroupLabel(c.source)}</div>}
              <div
                ref={i === selectedIndex ? selRef : undefined}
                className={`slash-menu-item${i === selectedIndex ? " selected" : ""}${c.supportedInChat === false ? " disabled" : ""}`}
                onMouseEnter={() => onHover(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(c);
                }}
              >
                <span className="slash-menu-icon"><Icon name={sourceIcon(c.source)} /></span>
                <span className="slash-menu-name">/{c.name}</span>
                <span className="slash-menu-desc">
                  {c.description ?? ""}
                  {c.argumentHint ? ` ${c.argumentHint}` : ""}
                  {c.supportedInChat === false ? " · 仅终端视图" : ""}
                </span>
                <span className="slash-menu-src">{sourceLabel(c.source)}</span>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
});
