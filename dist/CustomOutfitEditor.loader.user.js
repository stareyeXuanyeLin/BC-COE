// ==UserScript==
// @name         Bondage Club - Custom Outfit Editor（正式版加载器）
// @name:zh-CN   Bondage Club - 自定义服装编辑器（正式版加载器）
// @namespace    https://github.com/stareyeXuanyeLin/BC-COE
// @version      1.2.6
// @description  Loads the latest Custom Outfit Editor from the official branch on every page load.
// @description:zh-CN 每次进入页面时从正式分支加载最新的 Custom Outfit Editor。
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
// @downloadURL  https://raw.githubusercontent.com/stareyeXuanyeLin/BC-COE/main/dist/CustomOutfitEditor.loader.user.js
// @updateURL    https://raw.githubusercontent.com/stareyeXuanyeLin/BC-COE/main/dist/CustomOutfitEditor.loader.user.js
// ==/UserScript==

(function () {
    "use strict";

    if (window.__CUSTOM_OUTFIT_EDITOR_LOADER__) return;
    window.__CUSTOM_OUTFIT_EDITOR_LOADER__ = true;

    const script = document.createElement("script");
    const timestamp = Date.now();
    script.src = `https://raw.githubusercontent.com/stareyeXuanyeLin/BC-COE/main/dist/CustomOutfitEditor.user.js?timestamp=${timestamp}`;
    script.onload = () => console.info(`[Custom Outfit Editor Loader] core loaded from main (cache key ${timestamp}).`);
    script.onerror = () => console.error("[Custom Outfit Editor Loader] failed to load the core script.");
    (document.head || document.documentElement).appendChild(script);
})();
