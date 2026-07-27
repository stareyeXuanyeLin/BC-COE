// ==UserScript==
// @name         Bondage Club - Custom Outfit Editor（正式版加载器）
// @name:zh-CN   Bondage Club - 自定义服装编辑器（正式版加载器）
// @namespace    https://github.com/stareyeXuanyeLin/BC-COE
// @version      1.2.7
// @description  Loads the latest Custom Outfit Editor from the official branch with automatic CDN fallback.
// @description:zh-CN 每次进入页面时从正式分支加载最新的 Custom Outfit Editor，并在 CDN 故障时自动切换备用节点。
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

    const CORE_PATH = "gh/stareyeXuanyeLin/BC-COE@main/dist/CustomOutfitEditor.user.js";
    const CDN_BASES = Object.freeze([
        "https://cdn.jsdelivr.net/",
        "https://fastly.jsdelivr.net/",
        "https://gcore.jsdelivr.net/",
    ]);
    const cacheKey = Date.now();
    const parent = document.head || document.documentElement;

    function loadFrom(attempt) {
        if (attempt >= CDN_BASES.length) {
            delete window.__CUSTOM_OUTFIT_EDITOR_LOADER__;
            console.error("[Custom Outfit Editor Loader] all CDN endpoints failed; core was not loaded.");
            return;
        }

        const script = document.createElement("script");
        const source = `${CDN_BASES[attempt]}${CORE_PATH}?timestamp=${cacheKey}-${attempt}`;

        script.async = true;
        script.src = source;
        script.onload = () => {
            script.onload = null;
            script.onerror = null;
            console.info(`[Custom Outfit Editor Loader] core loaded from ${CDN_BASES[attempt]} (cache key ${cacheKey}).`);
        };
        script.onerror = () => {
            script.onload = null;
            script.onerror = null;
            script.remove();
            console.warn(`[Custom Outfit Editor Loader] failed to load ${source}; trying the next CDN.`);
            loadFrom(attempt + 1);
        };
        parent.appendChild(script);
    }

    loadFrom(0);
})();
