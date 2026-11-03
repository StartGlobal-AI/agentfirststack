// ua-parser-js v1 ships no types (and @types/ua-parser-js isn't a dependency).
declare module "ua-parser-js" {
  interface UAResult {
    ua: string;
    browser: { name?: string; version?: string; major?: string };
    os: { name?: string; version?: string };
    device: { type?: string; model?: string; vendor?: string };
    engine: { name?: string; version?: string };
    cpu: { architecture?: string };
  }
  class UAParser {
    constructor(ua?: string);
    getResult(): UAResult;
  }
  export default UAParser;
}
