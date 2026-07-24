// ==UserScript==
// @name         Bondage Club - Custom Outfit Editor（远程加载器）
// @name:zh-CN   Bondage Club - 自定义服装编辑器（远程加载器）
// @namespace    https://github.com/stareyeXuanyeLin/BC-COE
// @version      1.2.2
// @description  Loads the Custom Outfit Editor as a Tampermonkey dependency.
// @description:zh-CN 通过 Tampermonkey 依赖机制加载自定义服装编辑器，避免页面 CSP 拦截。
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
// @noframes
// @run-at       document-end
// @require      https://raw.githubusercontent.com/stareyeXuanyeLin/BC-COE/main/dist/CustomOutfitEditorEchoMirror.user.js?v=1.2.2
// @downloadURL  https://raw.githubusercontent.com/stareyeXuanyeLin/BC-COE/main/dist/CustomOutfitEditorEchoMirror.loader.user.js
// @updateURL    https://raw.githubusercontent.com/stareyeXuanyeLin/BC-COE/main/dist/CustomOutfitEditorEchoMirror.loader.user.js
// ==/UserScript==

(function () {
    "use strict";
    console.info("[COE Loader] v1.2.2 active; core loaded through Tampermonkey @require from GitHub Raw.");
})();
