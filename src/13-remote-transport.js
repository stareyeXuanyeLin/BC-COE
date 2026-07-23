  let remoteSendQueue = [];
  let remoteSendTimer = 0;
  let remoteSendTokens = 2;
  let remoteSendTokenAt = 0;
  let remoteMessageHandlerDispose = null;

  function remoteRoomMember(memberNumber) {
    return (globalThis.ChatRoomCharacter || []).find(character => Number(character?.MemberNumber) === Number(memberNumber)) || null;
  }

  function cancelRemoteTransport() {
    remoteSendQueue = [];
    if (remoteSendTimer) {
      clearTimeout(remoteSendTimer);
      remoteStore.timers.delete(remoteSendTimer);
    }
    remoteSendTimer = 0;
  }

  function enqueueRemoteEnvelope(envelope, target = null, options = {}) {
    const content = serializeRemoteEnvelope(envelope);
    remoteSendQueue.push({ content, target: Number.isInteger(target) ? target : null, generation: remoteStore.roomGeneration, earliest: Math.max(remoteNow(), Number(options.earliest) || 0) });
    pumpRemoteSendQueue();
  }

  function pumpRemoteSendQueue() {
    if (remoteSendTimer || !remoteSendQueue.length) return;
    const now = remoteNow();
    if (!remoteSendTokenAt) remoteSendTokenAt = now;
    remoteSendTokens = Math.min(2, remoteSendTokens + Math.max(0, now - remoteSendTokenAt) * 2.5 / 1000);
    remoteSendTokenAt = now;
    while (remoteSendQueue.length && remoteSendQueue[0].generation !== remoteStore.roomGeneration) remoteSendQueue.shift();
    if (!remoteSendQueue.length) return;
    const entry = remoteSendQueue[0];
    const delay = Math.max(entry.earliest - now, remoteSendTokens >= 1 ? 0 : Math.ceil((1 - remoteSendTokens) / 2.5 * 1000));
    if (delay > 0) {
      remoteSendTimer = scheduleRemoteTimer(() => { remoteSendTimer = 0; pumpRemoteSendQueue(); }, delay);
      return;
    }
    remoteSendQueue.shift();
    remoteSendTokens -= 1;
    try {
      const packet = { Type: "Hidden", Content: entry.content };
      if (entry.target != null) packet.Target = entry.target;
      ServerSend("ChatRoomChat", packet);
      remoteStore.stats.messagesSent++;
      remoteStore.stats.bytesSent += utf8Bytes(entry.content);
    } catch (error) {
      remoteDiagnostic("send-failed", entry.target, error?.message || error);
    }
    if (remoteSendQueue.length) {
      remoteSendTimer = scheduleRemoteTimer(() => { remoteSendTimer = 0; pumpRemoteSendQueue(); }, 0);
    }
  }

  function onRemoteMessage(data) {
    try {
      if (data?.Type !== "Hidden" || typeof data.Content !== "string" || !data.Content.startsWith(REMOTE_PREFIX)) return false;
      if (data.Content.length > REMOTE_LIMITS.content) {
        remoteStore.stats.messagesRejected++;
        return true;
      }
      const senderNumber = Number(data.Sender);
      const sender = Number.isInteger(senderNumber) ? remoteRoomMember(senderNumber) : null;
      if (!sender || Number(sender.MemberNumber) !== senderNumber) {
        remoteStore.stats.messagesRejected++;
        return true;
      }
      if (senderNumber === Number(globalThis.Player?.MemberNumber)) return true;
      if (!acceptRemoteInboundRate(senderNumber)) {
        remoteStore.stats.messagesRejected++;
        return true;
      }
      let envelope;
      try { envelope = parseRemoteContent(data.Content); }
      catch (error) {
        remoteStore.stats.messagesRejected++;
        remoteDiagnostic("invalid-envelope", senderNumber, error?.message || error);
        return true;
      }
      remoteStore.stats.messagesReceived++;
      remoteStore.stats.bytesReceived += utf8Bytes(data.Content);
      Promise.resolve(handleRemoteEnvelope(sender, envelope, remoteStore.roomGeneration)).catch(error => {
        remoteStore.stats.messagesRejected++;
        remoteDiagnostic("handler-rejected", senderNumber, error?.message || error);
      });
      return true;
    } catch (error) {
      try { remoteStore.stats.messagesRejected++; remoteDiagnostic("callback-failed", Number(data?.Sender), error?.message || error); } catch (_) { /* never escape BC loop */ }
      return typeof data?.Content === "string" && data.Content.startsWith(REMOTE_PREFIX);
    }
  }

  function installRemoteMessageHandler() {
    if (typeof globalThis.ChatRoomRegisterMessageHandler !== "function" || remoteMessageHandlerDispose) return false;
    remoteMessageHandlerDispose = ChatRoomRegisterMessageHandler({ Description: "COE Remote visual snapshot protocol", Priority: -50, Callback: onRemoteMessage }) || true;
    return true;
  }
