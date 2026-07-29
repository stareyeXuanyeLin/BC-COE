  const REMOTE_BURST_SIZE = 8;
  const REMOTE_NEXT_BURST_DELAY = 250;
  let remoteControlQueue = [];
  let remoteSnapshotQueue = [];
  let remoteSendTimer = 0;
  let remoteSendPumping = false;
  let remoteMessageHandlerDispose = null;

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
  }

  function remoteSendEntry(entry) {
    if (!entry || entry.generation !== remoteStore.roomGeneration) return false;
    try {
      const packet = { Type: "Hidden", Content: entry.content };
      if (entry.target != null) packet.Target = entry.target;
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
      // STATE / REQUEST / CLEAR are tiny and deduplicated by the controller. Send
      // all currently queued control messages in this execution turn so hidden-tab
      // timer alignment cannot add one second to every handshake step.
      while (remoteControlQueue.length) remoteSendEntry(remoteControlQueue.shift());
      if (!remoteSnapshotQueue.length || remoteSendTimer) return;

      const batch = remoteSnapshotQueue.shift();
      const end = Math.min(batch.cursor + REMOTE_BURST_SIZE, batch.chunks.length);
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
        remoteSendTimer = scheduleRemoteTimer(() => {
          remoteSendTimer = 0;
          pumpRemoteSendQueue();
        }, REMOTE_NEXT_BURST_DELAY);
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
    if (typeof globalThis.ChatRoomRegisterMessageHandler !== "function" || remoteMessageHandlerDispose) return false;
    remoteMessageHandlerDispose = ChatRoomRegisterMessageHandler({ Description: "COE Remote visual snapshot protocol", Priority: -50, Callback: onRemoteMessage }) || true;
    return true;
  }
