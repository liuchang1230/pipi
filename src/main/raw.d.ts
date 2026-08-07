// Vite `?raw` imports (used by extension-sync.ts to embed extension sources).
declare module "*?raw" {
  const content: string;
  export default content;
}
