/**
 * The consent banner UI (dist/consent-ui.txt, served at /cb/<version>.js; see banner.ts). The
 * runtime sets window.__afst_cbh before loading it; later opens call window.__afst_ui directly.
 */
import { type BannerHost, render } from "./banner";

const w = window as Window & { __afst_cbh?: BannerHost; __afst_ui?: (h: BannerHost) => void };
w.__afst_ui = (h) => {
  try {
    render(h);
  } catch (e) {
    try {
      console.error("[afst] consent banner error", e);
    } catch {
      /* ignore */
    }
  }
};
if (w.__afst_cbh) w.__afst_ui(w.__afst_cbh);
