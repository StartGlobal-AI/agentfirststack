/**
 * The <script> tag finder behind domain proofs: it must see the tags a browser runs and nothing
 * that only looks like one (a page repeating a query string, a comment, an inline script's text).
 */
import { describe, expect, it } from "vitest";
import { scriptStartTags } from "../src/html";

const srcs = (html: string) => scriptStartTags(html).map((a) => a.get("src") ?? null);
const TAG = `<script src="/r/x.js">`;

describe("scriptStartTags", () => {
  it("finds real tags: any case, quoting and attribute order, self-closing slash, no closing tag", () => {
    expect(srcs(`<SCRIPT defer SRC=/a.js></SCRIPT><script data-site='s1' async src="https://h.test/b.js?v=1">`)).toEqual([
      "/a.js",
      "https://h.test/b.js?v=1",
    ]);
    const [a] = scriptStartTags(`<script data-site = "s1"   src = '/s.js' defer>`);
    expect(Object.fromEntries(a!)).toEqual({ "data-site": "s1", src: "/s.js", defer: "" });
    // "/" between attributes is a separator, as in the browser
    expect(srcs(`<script/src="/c.js">`)).toEqual(["/c.js"]);
    // the first of duplicate attributes wins
    expect(srcs(`<script src="/first.js" src="/second.js">`)).toEqual(["/first.js"]);
    // a quoted value may hold ">" and "<"
    expect(srcs(`<script data-x="a>b<c" src="/d.js">`)).toEqual(["/d.js"]);
  });

  it("ignores text that only looks like a tag", () => {
    for (const html of [
      `<!-- ${TAG} -->`,
      `<!-- -- ${TAG} --->`,
      `<input value='${TAG}'>`,
      `<input value="&lt;script src=/r/x.js&gt;">`,
      `<a title="${TAG.replace(/"/g, "'")}">x</a>`,
      `<textarea>${TAG}</textarea>`,
      `<title>${TAG}</title>`,
      `<style>/* ${TAG} */</style>`,
      `<noscript>${TAG}</noscript>`,
      `<iframe>${TAG}</iframe>`,
      `<xmp>${TAG}</xmp>`,
      `<svg><![CDATA[ > ${TAG} ]]></svg>`,
      `<?php echo "${TAG}" ?>`,
      `<scripts src="/r/x.js">`,
      `<script src="/r/x.js"`, // cut off: the browser drops it too
    ])
      expect(srcs(html), html).toEqual([]);
  });

  it("never reads an inline script's code as tags, with the spec's escape rules", () => {
    // a search query or JSON in inline code
    expect(srcs(`<script>var q = "${TAG.replace(/"/g, "'")}";</script>`)).toEqual([null]);
    // "</script>" inside a "<!-- <script>" escape doesn't end the outer script...
    expect(srcs(`<script><!-- <script> </script> ${TAG} --></script>`)).toEqual([null]);
    // ...but it does without the inner "<script"
    expect(srcs(`<script><!-- x </script>${TAG}`)).toEqual([null, "/r/x.js"]);
    // "<!-->" leaves the escape at once
    expect(srcs(`<script><!--><script></script>${TAG}`)).toEqual([null, "/r/x.js"]);
    // "</script >" and "</SCRIPT>" end it; "</scripts>" doesn't
    expect(srcs(`<script></scripts>${TAG}</script >${TAG}`)).toEqual([null, "/r/x.js"]);
    expect(srcs(`<script></SCRIPT>${TAG}`)).toEqual([null, "/r/x.js"]);
  });

  it("finds tags again after comments and raw-text elements end", () => {
    expect(srcs(`<!-- x -->${TAG}`)).toEqual(["/r/x.js"]);
    expect(srcs(`<!-->${TAG}`)).toEqual(["/r/x.js"]);
    expect(srcs(`<!--->${TAG}`)).toEqual(["/r/x.js"]);
    expect(srcs(`<!-- a --!>${TAG}`)).toEqual(["/r/x.js"]);
    expect(srcs(`<!-- a ---->${TAG}`)).toEqual(["/r/x.js"]);
    expect(srcs(`<textarea>a</textarea >${TAG}`)).toEqual(["/r/x.js"]);
    expect(srcs(`<title>a</TITLE>${TAG}`)).toEqual(["/r/x.js"]);
    expect(srcs(`<!DOCTYPE html><p class="a>b">${TAG}`)).toEqual(["/r/x.js"]);
    expect(srcs(`a < b ${TAG}`)).toEqual(["/r/x.js"]);
    // nothing after <plaintext> is markup
    expect(srcs(`<plaintext>${TAG}`)).toEqual([]);
  });

  it("stops at max tags", () => {
    expect(scriptStartTags(`${TAG}</script>`.repeat(500))).toHaveLength(100);
    expect(scriptStartTags(`${TAG}</script>`.repeat(5), 2)).toHaveLength(2);
    // without end tags the rest is the first script's code
    expect(scriptStartTags(TAG.repeat(5))).toHaveLength(1);
  });
  it("doesn't count scripts inside <template> (they never run), without letting a string end the template", () => {
    expect(srcs(`<template>${TAG}</script></template>`)).toEqual([]);
    expect(srcs(`<template><template></template>${TAG}</script></template>`)).toEqual([]);
    expect(srcs(`<template><script>var s = "</template>${TAG}";</script></template>`)).toEqual([]);
    expect(srcs(`<template></template>${TAG}</script>`)).toEqual(["/r/x.js"]);
  });
});
