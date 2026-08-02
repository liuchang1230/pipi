import type { Terminal } from "@xterm/xterm";

export function attachImeHeuristic(terminal: Terminal): { detach(): void } {
  const root = terminal.element;
  if (!root) return { detach() {} };

  const textarea = root.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement | null;
  const screen = root.querySelector(".xterm-screen") as HTMLElement | null;
  const compositionView = root.querySelector(".composition-view") as HTMLElement | null;
  if (!textarea || !screen || !compositionView) return { detach() {} };
  const textareaEl = textarea;
  const screenEl = screen;
  const compositionViewEl = compositionView;

  let composing = false;
  let pinned: { left: string; top: string } | null = null;
  let renderDisposable: { dispose(): void } | null = null;

  const reapply = (el: HTMLElement) => {
    if (!composing || !pinned) return;
    if (el.style.left !== pinned.left || el.style.top !== pinned.top) {
      el.style.setProperty("left", pinned.left, "important");
      el.style.setProperty("top", pinned.top, "important");
    }
  };
  const moTa = new MutationObserver(() => reapply(textareaEl));
  const moCv = new MutationObserver(() => reapply(compositionViewEl));

  function computeCellSize() {
    const rect = screenEl.getBoundingClientRect();
    return {
      w: rect.width / Math.max(terminal.cols, 1),
      h: rect.height / Math.max(terminal.rows, 1),
    };
  }

  function findInverseCell(): { col: number; row: number } | null {
    const buf = terminal.buffer.active;
    const rows = terminal.rows;
    const startY = buf.viewportY;
    for (let y = startY + rows - 1; y >= startY; y--) {
      const line = buf.getLine(y);
      if (!line) continue;
      for (let x = line.length - 1; x >= 0; x--) {
        const cell = line.getCell(x);
        if (!cell || !cell.isInverse()) continue;
        const left = x > 0 ? line.getCell(x - 1) : null;
        const right = x + 1 < line.length ? line.getCell(x + 1) : null;
        const leftInv = !!left && !!left.isInverse();
        const rightInv = !!right && !!right.isInverse();
        if (leftInv && rightInv) continue;
        return { col: x, row: y - startY };
      }
    }
    return null;
  }

  function recomputeAndPin() {
    if (!composing) return;
    const hit = findInverseCell();
    if (!hit) return;
    const { w, h } = computeCellSize();
    const left = `${Math.round(hit.col * w)}px`;
    const top = `${Math.round(hit.row * h)}px`;
    if (pinned && pinned.left === left && pinned.top === top) return;
    pinned = { left, top };
    textareaEl.style.setProperty("left", left, "important");
    textareaEl.style.setProperty("top", top, "important");
    compositionViewEl.style.setProperty("left", left, "important");
    compositionViewEl.style.setProperty("top", top, "important");
  }

  function onCompositionStart() {
    composing = true;
    const hit = findInverseCell();
    if (hit) {
      const { w, h } = computeCellSize();
      const left = `${Math.round(hit.col * w)}px`;
      const top = `${Math.round(hit.row * h)}px`;
      pinned = { left, top };
      textareaEl.style.setProperty("left", left, "important");
      textareaEl.style.setProperty("top", top, "important");
      compositionViewEl.style.setProperty("left", left, "important");
      compositionViewEl.style.setProperty("top", top, "important");
    } else {
      pinned = null;
    }
    renderDisposable = terminal.onRender(() => recomputeAndPin());
  }

  function onCompositionEnd() {
    composing = false;
    pinned = null;
    renderDisposable?.dispose();
    renderDisposable = null;
  }

  textareaEl.addEventListener("compositionstart", onCompositionStart);
  textareaEl.addEventListener("compositionend", onCompositionEnd);
  moTa.observe(textareaEl, { attributes: true, attributeFilter: ["style"] });
  moCv.observe(compositionViewEl, { attributes: true, attributeFilter: ["style"] });

  return {
    detach() {
      composing = false;
      pinned = null;
      renderDisposable?.dispose();
      renderDisposable = null;
      textareaEl.removeEventListener("compositionstart", onCompositionStart);
      textareaEl.removeEventListener("compositionend", onCompositionEnd);
      moTa.disconnect();
      moCv.disconnect();
    },
  };
}
