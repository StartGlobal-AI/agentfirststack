// ua-parser-js v1 ships no types (v2 does, but is AGPL). Only the bits we use.
declare module "ua-parser-js" {
  interface IResult {
    ua: string;
    browser: { name?: string; version?: string; major?: string };
    os: { name?: string; version?: string };
    device: { model?: string; type?: string; vendor?: string };
  }
  class UAParser {
    constructor(ua?: string);
    getResult(): IResult;
  }
  export default UAParser;
}

// esbuild output of src/recorder and src/player, imported as Text modules (wrangler "rules").
declare module "*.txt" {
  const text: string;
  export default text;
}
