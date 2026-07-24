// ==UserScript==
// @name         Bondage Club - 自定义服装编辑器 Echo Mirror（加载器）
// @name:en      Bondage Club - Custom Outfit Editor Echo Mirror (Loader)
// @namespace    https://github.com/liliMozi/openhanako
// @version      1.0.0
// @description  轻量加载器，从仓库实时加载 COE-Echo Mirror 完整代码。更新仓库后无需重新安装此脚本。
// @author       凡尘 / 佩菈
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
    const script = document.createElement("script");
    const timestamp = new Date().getTime();
    script.src = "https://raw.githubusercontent.com/stareyeXuanyeLin/BC-COE-Echo-Mirror/main/dist/CustomOutfitEditorEchoMirror.user.js?t=" + timestamp;
    document.head.appendChild(script);
})();
