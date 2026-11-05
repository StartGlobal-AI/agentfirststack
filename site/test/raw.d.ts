// Vite's ?raw imports (a file's text), used to check public/_headers against src/static-pages.ts.
declare module "*?raw" {
  const text: string;
  export default text;
}
