// ==UserScript==
// @name         Bondage Club - Custom Outfit Editor（正式版加载器）
// @name:zh-CN   Bondage Club - 自定义服装编辑器（正式版加载器）
// @namespace    https://github.com/stareyeXuanyeLin/BC-COE
// @version      1.2.5
// @description  Loads the latest Custom Outfit Editor from the CDN on every page load.
// @description:zh-CN 每次进入页面时从 CDN 拉取最新的自定义服装编辑器。
// @author       林宣夜 ＆ 佩菈
// @match        https://www.bondageprojects.com/R*/BondageClub*
// @match        https://bondageprojects.com/R*/BondageClub*
// @match        https://www.bondageprojects.elementfx.com/R*/BondageClub*
// @match        https://bondageprojects.elementfx.com/R*/BondageClub*
// @match        https://bondage-europe.com/R*/BondageClub*
// @match        https://www.bondage-europe.com/R*/BondageClub*
// @match        https://bondage-asia.com/club/R*/BondageClub*
// @match        https://www.bondage-asia.com/club/R*/BondageClub*
// @include      /^https:\/\/(www\.)?bondageprojects\.elementfx\.com\/R\d+\/(BondageClub|\d+)(\/((index|\d+)\.html)?)?$/
// @include      /^https:\/\/(www\.)?bondageprojects\.com\/R\d+\/(BondageClub|\d+)(\/((index|\d+)\.html)?)?$/
// @include      /^https:\/\/(www\.)?bondage-europe\.com\/R\d+\/(BondageClub|\d+)(\/((index|\d+)\.html)?)?$/
// @include      /^https:\/\/(www\.)?bondage-asia\.com\/club\/R\d+\/(BondageClub|\d+)(\/((index|\d+)\.html)?)?$/
// @include      /^https?:\/\/localhost:\d+\/(BondageClub|\d+)(\/((index|\d+)\.html)?)?$/
// @grant        none
// @noframes
// @run-at       document-end
// @downloadURL  https://raw.githubusercontent.com/stareyeXuanyeLin/BC-COE/main/dist/CustomOutfitEditorEchoMirror.loader.user.js
// @updateURL    https://raw.githubusercontent.com/stareyeXuanyeLin/BC-COE/main/dist/CustomOutfitEditorEchoMirror.loader.user.js
// ==/UserScript==

(function () {
    "use strict";

    if (window.__COE_ECHO_MIRROR_LOADER__) return;
    window.__COE_ECHO_MIRROR_LOADER__ = true;

    const script = document.createElement("script");
    const timestamp = Date.now();
    script.src = `https://raw.githubusercontent.com/stareyeXuanyeLin/BC-COE/main/dist/CustomOutfitEditorEchoMirror.user.js?timestamp=${timestamp}`;
    script.onload = () => console.info(`[COE Loader] core loaded from main (cache key ${timestamp}).`);
    script.onerror = () => console.error("[COE Loader] failed to load the core script from CDN.");
    (document.head || document.documentElement).appendChild(script);
})();
