  let remoteMessageHandlerDispose = null;
  let remoteMessageHandlerRetryTimer = 0;

  function remoteRoomMember(memberNumber) {
    return (globalThis.ChatRoomCharacter || []).find(character => Number(character?.MemberNumber) === Number(memberNumber)) || null;
  }

  function cancelRemoteTransport() {
    // RVP/1 hands complete publication batches directly to BC's native queue.
    // There is no plugin-owned timer queue to cancel; room generation invalidates
    // all asynchronous protocol work in the controller and store.
  }

  function enqueueRemoteEnvelope(envelope, target = null) {
    const content = serializeRemoteEnvelope(envelope);
    try {
      const packet = { Type: "Hidden", Content: content };
      if (Number.isInteger(target)) packet.Target = target;
      ServerSend("ChatRoomChat", packet);
      remoteStore.stats.messagesSent++;
      remoteStore.stats.bytesSent += utf8Bytes(content);
      return true;
    } catch (error) {
      remoteDiagnostic("send-failed", target, error?.message || error);
      return false;
    }
  }

  function enqueueRemoteDataBatch(baseEnvelope, chunks, target = null, indexes = null) {
    if (!Array.isArray(chunks) || !chunks.length) return 0;
    const selected = Array.isArray(indexes) ? [...new Set(indexes)] : chunks.map((_, index) => index);
    let sent = 0;
    for (const index of selected) {
      if (!Number.isInteger(index) || index < 0 || index >= chunks.length) continue;
      if (enqueueRemoteEnvelope({ ...baseEnvelope, t: "X", i: index, n: chunks.length, d: chunks[index] }, target)) sent++;
    }
    return sent;
  }

  function acceptPublishedRemoteData(senderNumber, envelope) {
    if (!publicationMatchesEnvelope(senderNumber, envelope)) return false;
    const key = remoteObjectKey(senderNumber, envelope.h);
    const count = remoteStore.dataMessageCounts.get(key) || 0;
    if (count >= envelope.n * 2 + 4) return false;
    remoteStore.dataMessageCounts.set(key, count + 1);
    return true;
  }

  function clearRemoteDataBudget(senderNumber, hash) {
    remoteStore.dataMessageCounts.delete(remoteObjectKey(senderNumber, hash));
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
      let envelope;
      try { envelope = parseRemoteContent(data.Content); }
      catch (error) {
        remoteStore.stats.messagesRejected++;
        remoteDiagnostic("invalid-envelope", senderNumber, error?.message || error);
        return true;
      }
      const accepted = envelope.t === "X"
        ? acceptPublishedRemoteData(senderNumber, envelope)
        : acceptRemoteInboundRate(senderNumber);
      if (!accepted) {
        remoteStore.stats.messagesRejected++;
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
    if (remoteMessageHandlerDispose) return true;
    if (typeof globalThis.ChatRoomRegisterMessageHandler !== "function") return false;
    remoteMessageHandlerDispose = ChatRoomRegisterMessageHandler({ Description: "COE room visual publication protocol", Priority: -50, Callback: onRemoteMessage }) || true;
    return true;
  }

  function ensureRemoteMessageHandler() {
    if (installRemoteMessageHandler()) {
      if (remoteMessageHandlerRetryTimer) clearInterval(remoteMessageHandlerRetryTimer);
      remoteMessageHandlerRetryTimer = 0;
      return true;
    }
    if (!remoteMessageHandlerRetryTimer) {
      remoteMessageHandlerRetryTimer = setInterval(() => {
        if (!installRemoteMessageHandler()) return;
        clearInterval(remoteMessageHandlerRetryTimer);
        remoteMessageHandlerRetryTimer = 0;
      }, 1000);
      remoteMessageHandlerRetryTimer?.unref?.();
    }
    return false;
  }
