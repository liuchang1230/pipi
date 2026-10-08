// The composer's extension zone: the widgets an extension declared for
// `aboveEditor` / `belowEditor`, plus the status chips that sit in the input bar.
//
// Why a component and not inline JSX in ChatPane: ChatPane is the pane's
// everything-file and this block has its own state (per-widget expand) and its
// own rules (the widget line cap). The rules themselves are pure and tested in
// stores/extension-ui-view.ts; this file only draws them.
import { useState } from "react";
import type { ExtensionUiSurface, WidgetPlacement } from "../../../shared/extension-ui";
import { statusEntries, widgetViews, type WidgetView } from "../stores/extension-ui-view";

/** One widget: text lines in a bordered block, collapsed to the cap with the
 *  remainder behind the same affordance the long thinking blocks use
 *  (.chat-expand-output). `key` is the extension's own key — it is the only name
 *  the widget has, so it becomes the tooltip rather than being dropped. */
function WidgetBlock({ view }: { view: WidgetView }) {
  const [expanded, setExpanded] = useState(false);
  const lines = expanded ? [...view.lines, ...view.rest] : view.lines;
  return (
    <div className="chat-ext-widget" title={view.key}>
      {lines.map((line, i) => (
        <div key={i} className="chat-ext-widget-line">
          {line || "\u00a0"}
        </div>
      ))}
      {!expanded && view.rest.length > 0 && (
        <button className="chat-ext-widget-more" onClick={() => setExpanded(true)}>
          {view.hidden > 0 ? `展开（还有 ${view.rest.length} 行）` : `展开全部（还有 ${view.rest.length} 行）`}
        </button>
      )}
      {expanded && view.hidden > 0 && (
        <div className="chat-ext-widget-note">另有 {view.hidden} 行未显示（扩展声明了 {view.hidden + view.rest.length + view.lines.length} 行）</div>
      )}
      {expanded && view.rest.length > 0 && (
        <button className="chat-ext-widget-more" onClick={() => setExpanded(false)}>
          收起
        </button>
      )}
    </div>
  );
}

/** pi's `setStatus` text, drawn in the input bar **right after the token/usage
 *  stats**: 「↑6.7k ↓2.4k · 缓存664k · 26.5%」 then 「◆ 3 checkpoints」. Both are
 *  facts about THIS session, so one line reads them together; on its own row
 *  above the composer the status looked like a message nobody sent. The row
 *  shrinks/ellipsises instead of wrapping — the send button must not move.
 *  `title` carries a status the row had to clip. */
export function ExtensionStatusChips({ surface }: { surface: ExtensionUiSurface }) {
  const statuses = statusEntries(surface);
  if (statuses.length === 0) return null;
  return (
    <div className="chat-ext-status">
      {statuses.map((s) => (
        <span key={s.key} className="chat-ext-status-item" title={s.full === s.text ? s.key : `${s.key}：${s.full}`}>
          {s.text}
        </span>
      ))}
    </div>
  );
}

export function ExtensionUiZone({
  surface,
  placement,
}: {
  surface: ExtensionUiSurface;
  placement: WidgetPlacement;
}) {
  const widgets = widgetViews(surface, placement);
  if (widgets.length === 0) return null;
  return (
    <div className={`chat-ext-zone chat-ext-zone-${placement}`}>
      {widgets.map((w) => (
        <WidgetBlock key={w.key} view={w} />
      ))}
    </div>
  );
}
