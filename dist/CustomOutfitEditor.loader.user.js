// ==UserScript==
// @name         Bondage Club - Custom Outfit Editor（dev 测试加载器）
// @name:zh-CN   Bondage Club - 自定义服装编辑器（dev 测试加载器）
// @namespace    https://github.com/stareyeXuanyeLin/BC-COE
// @version      1.3.0
// @description  Fetches and executes the latest Custom Outfit Editor from the dev branch with a privileged request and network fallback.
// @description:zh-CN 每次进入页面时通过特权请求获取并执行 dev 分支的最新 Custom Outfit Editor，并在网络故障时自动切换备用源。
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
// @grant        GM_xmlhttpRequest
// @grant        GM_addElement
// @grant        unsafeWindow
// @connect      raw.githubusercontent.com
// @connect      cdn.jsdelivr.net
// @connect      fastly.jsdelivr.net
// @connect      gcore.jsdelivr.net
// @noframes
// @run-at       document-end
// @downloadURL  https://raw.githubusercontent.com/stareyeXuanyeLin/BC-COE/dev/dist/CustomOutfitEditor.loader.user.js
// @updateURL    https://raw.githubusercontent.com/stareyeXuanyeLin/BC-COE/dev/dist/CustomOutfitEditor.loader.user.js
// ==/UserScript==

(function () {
    "use strict";

    const pageWindow = unsafeWindow;
    const LOADER_GUARD = "__CUSTOM_OUTFIT_EDITOR_DEV_LOADER__";
    const EXECUTION_MARKER = "__CUSTOM_OUTFIT_EDITOR_DEV_CORE_EVALUATED__";
    if (pageWindow[LOADER_GUARD]) return;
    pageWindow[LOADER_GUARD] = true;

    const cacheKey = Date.now();
    const corePath = "stareyeXuanyeLin/BC-COE/dev/dist/CustomOutfitEditor.user.js";
    const sources = Object.freeze([
        `https://raw.githubusercontent.com/${corePath}?timestamp=${cacheKey}`,
        `https://cdn.jsdelivr.net/gh/stareyeXuanyeLin/BC-COE@dev/dist/CustomOutfitEditor.user.js?timestamp=${cacheKey}`,
        `https://fastly.jsdelivr.net/gh/stareyeXuanyeLin/BC-COE@dev/dist/CustomOutfitEditor.user.js?timestamp=${cacheKey}`,
        `https://gcore.jsdelivr.net/gh/stareyeXuanyeLin/BC-COE@dev/dist/CustomOutfitEditor.user.js?timestamp=${cacheKey}`,
    ]);

    function fail(message, detail) {
        delete pageWindow[LOADER_GUARD];
        console.error(`[Custom Outfit Editor Loader] ${message}`, detail || "");
    }

    function validCore(source) {
        return typeof source === "string"
            && source.includes('const MOD_NAME = "CustomOutfitEditor"')
            && source.includes("function initialize()")
            && !/^\s*</.test(source);
    }

    function executeCore(source, sourceURL) {
        delete pageWindow[EXECUTION_MARKER];
        const marker = `\n;globalThis.${EXECUTION_MARKER} = true;\n//# sourceURL=${sourceURL}`;
        GM_addElement(document.head || document.documentElement, "script", { textContent: source + marker });
        if (pageWindow[EXECUTION_MARKER] !== true) throw new Error("核心文本已下载，但未能在游戏页面上下文中执行");
        delete pageWindow[EXECUTION_MARKER];
        console.info(`[Custom Outfit Editor Loader] latest core executed from ${sourceURL}.`);
    }

    function loadFrom(attempt) {
        if (attempt >= sources.length) {
            fail("all remote sources failed; core was not loaded.");
            return;
        }

        const sourceURL = sources[attempt];
        GM_xmlhttpRequest({
            method: "GET",
            url: sourceURL,
            timeout: 15000,
            headers: { "Cache-Control": "no-cache" },
            onload(response) {
                if (response.status < 200 || response.status >= 300 || !validCore(response.responseText)) {
                    console.warn(`[Custom Outfit Editor Loader] invalid response from ${sourceURL} (HTTP ${response.status}); trying the next source.`);
                    loadFrom(attempt + 1);
                    return;
                }
                try {
                    executeCore(response.responseText, sourceURL);
                } catch (error) {
                    fail("the core was downloaded but execution failed.", error);
                }
            },
            onerror(error) {
                console.warn(`[Custom Outfit Editor Loader] request failed for ${sourceURL}; trying the next source.`, error);
                loadFrom(attempt + 1);
            },
            ontimeout() {
                console.warn(`[Custom Outfit Editor Loader] request timed out for ${sourceURL}; trying the next source.`);
                loadFrom(attempt + 1);
            },
        });
    }

    loadFrom(0);
})();
