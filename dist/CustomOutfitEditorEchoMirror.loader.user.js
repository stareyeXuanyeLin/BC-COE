// ==UserScript==
// @name         Bondage Club - Custom Outfit Editor（远程加载器）
// @name:zh-CN   Bondage Club - 自定义服装编辑器（远程加载器）
// @namespace    https://github.com/stareyeXuanyeLin/BC-COE
// @version      1.1.0
// @description  Always loads the latest Custom Outfit Editor from CDN. Update core code without reinstalling the loader.
// @description:zh-CN 从 CDN 自动加载最新版自定义服装编辑器；更新核心代码时无需重新安装本加载器。
// @author       凡尘 / 佩菈
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
// @run-at       document-end
// ==/UserScript==

(function () {
    "use strict";

    const SCRIPT_ID = "coe-echo-mirror-remote-script";
    const REMOTE_URL = "https://cdn.jsdelivr.net/gh/stareyeXuanyeLin/BC-COE@main/dist/CustomOutfitEditorEchoMirror.user.js";

    if (document.getElementById(SCRIPT_ID)) {
        console.info("[COE Loader] Remote script is already loading or loaded.");
        return;
    }

    const script = document.createElement("script");
    script.id = SCRIPT_ID;
    script.async = true;
    script.src = REMOTE_URL + "?t=" + Date.now();

    script.addEventListener("load", function () {
        console.info("[COE Loader] Latest patch loaded from CDN.");
    }, { once: true });

    script.addEventListener("error", function () {
        console.error("[COE Loader] Failed to load: " + REMOTE_URL);
    }, { once: true });

    (document.head || document.documentElement).appendChild(script);
})();
