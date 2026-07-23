// ==UserScript==
// @name         Bondage Club - COE Remote Communication Probe
// @name:en      Bondage Club - COE Remote Communication Probe
// @namespace    https://github.com/liliMozi/openhanako
// @version      0.1.0
// @description  默认关闭的 R130 Hidden 消息隔离探针；只发送协议名、序号、固定文本和时间戳。
// @author       凡尘 / 佩菈
// @match        https://www.bondageprojects.com/R*/*
// @match        https://bondageprojects.com/R*/*
// @match        https://www.bondageprojects.elementfx.com/R*/*
// @match        https://bondageprojects.elementfx.com/R*/*
// @match        https://bondage-europe.com/R*/*
// @match        https://www.bondage-europe.com/R*/*
// @match        https://bondage-asia.com/club/R*/*
// @match        https://www.bondage-asia.com/club/R*/*
// @match        http://localhost:*/*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const API_NAME = "COERemoteCommunicationProbe";
  const PROTOCOL = "COE_REMOTE_PROBE/1";
  const PREFIX = `${PROTOCOL}|`;
  const ALLOWED_BODY_LENGTHS = Object.freeze([16, 64, 256, 512, 1024, 1400]);
  const MIN_SEND_INTERVAL_MS = 3000;
  const VISIBILITY_OBSERVE_MS = 1500;
  const MAX_RECORDS = 100;

  if (globalThis[API_NAME]) {
    console.warn(`[${PROTOCOL}] duplicate probe ignored`);
    return;
  }

  let enabled = false;
  let handlerInstalled = false;
  let sequence = 0;
  let lastSendAt = 0;
  const records = [];

  const clone = value => JSON.parse(JSON.stringify(value));
  const log = (...args) => console.log(`[${PROTOCOL}]`, ...args);
  const warn = (...args) => console.warn(`[${PROTOCOL}]`, ...args);

  function addRecord(record) {
    records.push({ at: new Date().toISOString(), ...record });
    if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
  }

  function isInChatRoom() {
    return typeof globalThis.ServerPlayerIsInChatRoom === "function" && ServerPlayerIsInChatRoom()
      && !!globalThis.ChatRoomData
      && Array.isArray(globalThis.ChatRoomCharacter);
  }

  function makeBody(length, seq) {
    if (!ALLOWED_BODY_LENGTHS.includes(length)) {
      throw new RangeError(`length must be one of: ${ALLOWED_BODY_LENGTHS.join(", ")}`);
    }
    const seed = `P${String(seq).padStart(6, "0")}-0123456789ABCDEF-`;
    return seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
  }

  function observeChatVisibility(marker, record) {
    const root = document.getElementById("TextAreaChatLog");
    if (!root) {
      record.chatVisibility = "chat-log-not-found";
      return;
    }

    const isVisible = () => (root.textContent || "").includes(marker) || (root.innerHTML || "").includes(marker);
    if (isVisible()) {
      record.chatVisibility = "visible";
      warn("protocol marker appeared in chat UI", record);
      return;
    }

    record.chatVisibility = "not-observed";
    const observer = new MutationObserver(() => {
      if (isVisible()) {
        record.chatVisibility = "visible";
        warn("protocol marker appeared in chat UI", record);
      }
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    setTimeout(() => {
      observer.disconnect();
      if (record.chatVisibility !== "visible") record.chatVisibility = "not-visible-during-window";
      log("visibility observation finished", clone(record));
    }, VISIBILITY_OBSERVE_MS);
  }

  function onProbeMessage(data, sender) {
    if (!enabled || data?.Type !== "Hidden" || typeof data.Content !== "string" || !data.Content.startsWith(PREFIX)) {
      return false;
    }

    try {
      if (!Number.isFinite(data.Sender) || sender?.MemberNumber !== data.Sender) {
        addRecord({ direction: "rejected", reason: "sender-mismatch" });
        return true;
      }
      if (data.Content.length > 1900) {
        addRecord({ direction: "rejected", sender: data.Sender, reason: "content-over-probe-budget", contentLength: data.Content.length });
        return true;
      }

      const payload = JSON.parse(data.Content.slice(PREFIX.length));
      if (!payload || payload.protocol !== PROTOCOL || !Number.isSafeInteger(payload.sequence)
        || typeof payload.timestamp !== "number" || typeof payload.body !== "string"
        || !ALLOWED_BODY_LENGTHS.includes(payload.body.length)) {
        addRecord({ direction: "rejected", sender: data.Sender, reason: "invalid-envelope" });
        return true;
      }

      const record = {
        direction: "received",
        sender: data.Sender,
        target: Number.isFinite(data.Target) ? data.Target : null,
        mode: payload.mode,
        sequence: payload.sequence,
        bodyLength: payload.body.length,
        contentLength: data.Content.length,
        latencyMs: Date.now() - payload.timestamp,
        chatVisibility: "pending",
      };
      addRecord(record);
      observeChatVisibility(PROTOCOL, record);
      log("received", clone(record));
    } catch (error) {
      addRecord({ direction: "rejected", sender: data?.Sender ?? null, reason: "parse-error", error: String(error) });
      warn("receive rejected", error);
    }
    return true;
  }

  function installHandler() {
    if (handlerInstalled) return;
    if (typeof globalThis.ChatRoomRegisterMessageHandler !== "function") {
      throw new Error("ChatRoomRegisterMessageHandler is not available yet");
    }
    ChatRoomRegisterMessageHandler({
      Description: "COE Remote isolated communication probe",
      Priority: -50,
      Callback: onProbeMessage,
    });
    handlerInstalled = true;
  }

  function send(target, bodyLength) {
    if (!enabled) throw new Error("probe is disabled; call enable() first");
    if (!isInChatRoom()) throw new Error("not currently in a chat room");
    if (typeof globalThis.ServerSend !== "function") throw new Error("ServerSend is unavailable");

    const now = Date.now();
    if (now - lastSendAt < MIN_SEND_INTERVAL_MS) {
      throw new Error(`probe send interval is ${MIN_SEND_INTERVAL_MS} ms`);
    }
    if (target !== null && (!Number.isSafeInteger(target) || target <= 0)) {
      throw new TypeError("target must be a positive MemberNumber or null");
    }

    sequence += 1;
    const payload = {
      protocol: PROTOCOL,
      sequence,
      timestamp: now,
      mode: target === null ? "broadcast" : "targeted",
      body: makeBody(bodyLength, sequence),
    };
    const content = PREFIX + JSON.stringify(payload);
    if (content.length > 1900) throw new Error("probe envelope exceeds the 1900-character safety budget");

    const message = { Content: content, Type: "Hidden" };
    if (target !== null) message.Target = target;
    ServerSend("ChatRoomChat", message);
    lastSendAt = now;

    const record = {
      direction: "sent",
      sender: Number.isFinite(globalThis.Player?.MemberNumber) ? Player.MemberNumber : null,
      target,
      mode: payload.mode,
      sequence,
      bodyLength,
      contentLength: content.length,
      chatVisibility: "pending",
    };
    addRecord(record);
    observeChatVisibility(PROTOCOL, record);
    log("sent", clone(record));
    return clone(record);
  }

  const api = Object.freeze({
    protocol: PROTOCOL,
    allowedBodyLengths: ALLOWED_BODY_LENGTHS,
    minSendIntervalMs: MIN_SEND_INTERVAL_MS,
    enable() {
      installHandler();
      enabled = true;
      log("enabled; no message is sent automatically");
      return true;
    },
    disable() {
      enabled = false;
      log("disabled");
      return true;
    },
    sendBroadcast(bodyLength = 16) {
      return send(null, Number(bodyLength));
    },
    sendTo(memberNumber, bodyLength = 16) {
      return send(Number(memberNumber), Number(bodyLength));
    },
    clearRecords() {
      records.length = 0;
    },
    status() {
      return clone({
        enabled,
        handlerInstalled,
        sequence,
        lastSendAt,
        records,
      });
    },
  });

  Object.defineProperty(globalThis, API_NAME, { value: api, configurable: true });
  console.info(`[${PROTOCOL}] loaded DISABLED. Explicitly call ${API_NAME}.enable() before testing.`);
})();
