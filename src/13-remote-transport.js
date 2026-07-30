  const REMOTE_BURST_SIZE = 8;
  const REMOTE_NEXT_BURST_DELAY = 250;
  const REMOTE_SEND_WINDOW_MS = 1200;
  const REMOTE_SEND_WINDOW_CAPACITY = 12;
  let remoteControlQueue = [];
  let remoteSnapshotQueue = [];
  let remoteSendTimer = 0;
  let remoteSendPumping = false;
  let remoteSendWindowAt = 0;
  let remoteSendWindowCount = 0;
  let remoteMessageHandlerDispose = null;
  let remoteMessageHandlerRetryTimer = 0;

  function remoteRoomMember(memberNumber) {
    return (globalThis.ChatRoomCharacter || []).find(character => Number(character?.MemberNumber) === Number(memberNumber)) || null;
  }

  function clearRemoteSendTimer() {
    if (!remoteSendTimer) return;
    clearTimeout(remoteSendTimer);
    remoteStore.timers.delete(remoteSendTimer);
    remoteSendTimer = 0;
  }

  function cancelRemoteTransport() {
    remoteControlQueue = [];
    remoteSnapshotQueue = [];
    clearRemoteSendTimer();
    remoteSendPumping = false;
    remoteSendWindowAt = 0;
    remoteSendWindowCount = 0;
  }

  function refreshRemoteSendWindow(now = remoteNow()) {
    if (!remoteSendWindowAt || now - remoteSendWindowAt >= REMOTE_SEND_WINDOW_MS) {
      remoteSendWindowAt = now;
      remoteSendWindowCount = 0;
    }
    return now;
  }

  function remoteSendCapacity(now = remoteNow()) {
    refreshRemoteSendWindow(now);
    return Math.max(0, REMOTE_SEND_WINDOW_CAPACITY - remoteSendWindowCount);
  }

  function scheduleRemoteSendPump(delay) {
    if (remoteSendTimer) return;
    remoteSendTimer = scheduleRemoteTimer(() => {
      remoteSendTimer = 0;
      pumpRemoteSendQueue();
    }, Math.max(0, delay));
  }

  function remoteSendEntry(entry) {
    if (!entry || entry.generation !== remoteStore.roomGeneration) return false;
    try {
      const packet = { Type: "Hidden", Content: entry.content };
      if (entry.target != null) packet.Target = entry.target;
      remoteSendWindowCount++;
      ServerSend("ChatRoomChat", packet);
      remoteStore.stats.messagesSent++;
      remoteStore.stats.bytesSent += utf8Bytes(entry.content);
      return true;
    } catch (error) {
      remoteDiagnostic("send-failed", entry.target, error?.message || error);
      return false;
    }
  }

  function enqueueRemoteEnvelope(envelope, target = null) {
    const content = serializeRemoteEnvelope(envelope);
    remoteControlQueue.push({
      content,
      target: Number.isInteger(target) ? target : null,
      generation: remoteStore.roomGeneration,
    });
    // Control messages are latency-sensitive. If a later snapshot burst is waiting
    // on a background-throttled timer, cancel that wait and send control now.
    clearRemoteSendTimer();
    pumpRemoteSendQueue();
  }

  function enqueueRemoteSnapshotBatch(baseEnvelope, chunks, target) {
    if (!Array.isArray(chunks) || !chunks.length || !Number.isInteger(target)) return false;
    remoteSnapshotQueue.push({
      baseEnvelope: { ...baseEnvelope },
      chunks: chunks.slice(),
      target,
      cursor: 0,
      generation: remoteStore.roomGeneration,
    });
    pumpRemoteSendQueue();
    return true;
  }

  function pruneRemoteSendQueues() {
    const generation = remoteStore.roomGeneration;
    remoteControlQueue = remoteControlQueue.filter(entry => entry.generation === generation);
    remoteSnapshotQueue = remoteSnapshotQueue.filter(batch => batch.generation === generation && batch.cursor < batch.chunks.length);
  }

  function pumpRemoteSendQueue() {
    if (remoteSendPumping) return;
    remoteSendPumping = true;
    try {
      pruneRemoteSendQueues();
      const now = refreshRemoteSendWindow();
      // Keep the plugin below BC's native 14 messages / 1200 ms client queue.
      // Twelve slots leave headroom for unrelated game traffic while allowing one
      // ordinary snapshot burst to finish in the current execution turn.
      while (remoteControlQueue.length && remoteSendCapacity(now) > 0) remoteSendEntry(remoteControlQueue.shift());
      if (remoteControlQueue.length) {
        scheduleRemoteSendPump(Math.max(1, REMOTE_SEND_WINDOW_MS - (now - remoteSendWindowAt)));
        return;
      }
      if (!remoteSnapshotQueue.length || remoteSendTimer) return;
      const capacity = remoteSendCapacity(now);
      if (capacity <= 0) {
        scheduleRemoteSendPump(Math.max(1, REMOTE_SEND_WINDOW_MS - (now - remoteSendWindowAt)));
        return;
      }

      const batch = remoteSnapshotQueue.shift();
      const end = Math.min(batch.cursor + REMOTE_BURST_SIZE, batch.cursor + capacity, batch.chunks.length);
      while (batch.cursor < end) {
        const index = batch.cursor++;
        const envelope = {
          ...batch.baseEnvelope,
          t: "CHUNK",
          index,
          count: batch.chunks.length,
          data: batch.chunks[index],
        };
        remoteSendEntry({
          content: serializeRemoteEnvelope(envelope),
          target: batch.target,
          generation: batch.generation,
        });
      }
      // Round-robin fairness: a large response returns to the end of the queue so
      // another target can receive its first burst before this target continues.
      if (batch.cursor < batch.chunks.length) remoteSnapshotQueue.push(batch);
      if (remoteSnapshotQueue.length) {
        const after = remoteNow();
        const delay = remoteSendCapacity(after) > 0
          ? REMOTE_NEXT_BURST_DELAY
          : Math.max(1, REMOTE_SEND_WINDOW_MS - (after - remoteSendWindowAt));
        scheduleRemoteSendPump(delay);
      }
    } finally {
      remoteSendPumping = false;
    }
  }

  function acceptRequestedRemoteChunk(senderNumber, envelope) {
    const pending = pendingRequestFor(senderNumber);
    if (!pending || pending.generation !== remoteStore.roomGeneration ||
      pending.requestId !== envelope.requestId || pending.session !== envelope.session ||
      pending.revision !== envelope.revision || pending.hash !== envelope.hash) return false;
    // One valid request may receive every legal chunk plus a small duplicate margin.
    // Assembly count/byte budgets remain authoritative in addRemoteChunk().
    pending.chunkMessages = Number(pending.chunkMessages) || 0;
    if (pending.chunkMessages >= REMOTE_LIMITS.chunks + 4) return false;
    pending.chunkMessages++;
    return true;
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
      const accepted = envelope.t === "CHUNK"
        ? acceptRequestedRemoteChunk(senderNumber, envelope)
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
    remoteMessageHandlerDispose = ChatRoomRegisterMessageHandler({ Description: "COE Remote visual snapshot protocol", Priority: -50, Callback: onRemoteMessage }) || true;
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
