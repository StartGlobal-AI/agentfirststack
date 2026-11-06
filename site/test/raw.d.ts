// Vite's ?raw imports (a file's text), used to check public/_headers against src/static-pages.ts.
declare module "*?raw" {
  const text: string;
  export default text;
}

// Vite's import.meta.glob (file paths matching a pattern), used to list public/ assets in a test.
interface ImportMeta {
  glob(pattern: string | string[]): Record<string, () => Promise<unknown>>;
}
