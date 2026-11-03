// Fixture imports: `import raw from "../fixtures/x.eml?raw"` (Vite inlines the file as a string).
declare module "*?raw" {
  const content: string;
  export default content;
}
