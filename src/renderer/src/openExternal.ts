const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function openExternalSafe(href: string): void {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return;
  }
  if (!EXTERNAL_PROTOCOLS.has(url.protocol)) return;
  import("electron").then(({ shell }) => shell.openExternal(url.toString()));
}
