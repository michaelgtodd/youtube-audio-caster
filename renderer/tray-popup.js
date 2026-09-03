'use strict';

(() => {
  document.documentElement.dataset.nativeSurface = /^Mac/i.test(navigator.platform)
    ? 'vibrant' : 'solid';

  const POLL_INTERVAL_MS = 1000;
  const INTERACTION_SETTLE_MS = 650;
  const STATUS_REQUEST_TIMEOUT_MS = 5000;
  const VOLUME_REQUEST_TIMEOUT_MS = 5000;
  const VOLUME_FEEDBACK_MS = 2200;
  /* A speaker that has just failed twice in the same gesture is wedged, not
     busy. Keep painting locally and try once more on release rather than
     spending the rest of the drag filling /api/errors with the same fault. */
  const GESTURE_FAILURE_LIMIT = 2;
  const VOLUME_KEYS = new Set([
    'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'End', 'Home', 'PageDown', 'PageUp',
  ]);

  const elements = {
    controlStatus: document.getElementById('control-status'),
    deviceName: document.getElementById('device-name'),
    nowPlaying: document.getElementById('now-playing'),
    openWindow: document.getElementById('open-window'),
    playbackState: document.getElementById('playback-state'),
    playbackToggle: document.getElementById('playback-toggle'),
    quit: document.getElementById('quit'),
    volume: document.getElementById('volume'),
    volumeValue: document.getElementById('volume-value'),
  };

  let pendingTransport = null;   // 'play' | 'pause' | null, from the last status

  const interaction = {
    edit: null,
    editEndTimer: null,
    keyboardActive: false,
    pendingWrites: 0,
    pointerActive: false,
    settleUntil: 0,
  };

  const controlMessage = {
    baseline: { isError: false, message: 'Checking speaker status…' },
    feedback: null,
    feedbackTimer: null,
    volumeAvailable: false,
  };
  const volumeWriter = {
    inFlight: null,
    pending: null,
  };

  let latestWrite = 0;
  /* What the speaker was last told, so the trailing 'change' that every drag
     and every arrow key fires cannot re-send a value that is already set.
     Cleared wherever a poll repaints authoritatively or the slider goes away,
     so a speaker moved from another app can still be dragged back to the same
     number. */
  let lastSubmittedVolume = null;
  /* Writing during a drag means a settle every few hundred milliseconds, and
     announcing each one would flip the aria-live region between the baseline
     and 'Volume updated.' faster than anyone can read it. Outcomes wait here
     and are announced once, when the gesture ends. */
  let owedVolumeOutcome = null;
  let pollInFlight = false;
  let pollRefreshRequested = false;
  let pollTimer = null;
  let selectedVolumePercent = null;
  let selectedVolumeTarget = null;
  let statusRequestController = null;

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function setText(element, text) {
    if (element.textContent !== text) element.textContent = text;
  }

  function formatState(state) {
    const normalized = String(state || '').trim().toUpperCase();
    const labels = {
      BUFFERING: 'Buffering',
      IDLE: 'Idle',
      PAUSED: 'Paused',
      PLAYING: 'Playing',
    };
    return labels[normalized] || (normalized ? 'Status' : 'Unavailable');
  }

  function stateStyle(state, connected, hasError) {
    if (hasError || !connected) return 'error';
    const normalized = String(state || '').toLowerCase();
    return ['buffering', 'playing'].includes(normalized) ? normalized : 'idle';
  }

  /* PLAYING and BUFFERING are both "make it stop"; PAUSED is "start it again".
     Anything else - idle, disconnected, nothing loaded - has nothing to toggle,
     so the button says so by being disabled rather than failing when pressed. */
  function transportFor(state) {
    const normalized = String(state || '').trim().toUpperCase();
    if (normalized === 'PLAYING' || normalized === 'BUFFERING') return { action: 'pause', label: 'Pause' };
    if (normalized === 'PAUSED') return { action: 'play', label: 'Play' };
    return null;
  }

  function hasSelectedDevice(status) {
    return Boolean(status && (status.device || status.device_name));
  }

  function clearVolumeEditEndTimer() {
    clearTimeout(interaction.editEndTimer);
    interaction.editEndTimer = null;
  }

  function startVolumeEdit(source) {
    clearVolumeEditEndTimer();
    interaction.edit = {
      failures: 0,
      source,
      target: selectedVolumeTarget,
      valid: Boolean(selectedVolumeTarget),
    };
    return interaction.edit;
  }

  function ensureVolumeEdit(source) {
    return interaction.edit || startVolumeEdit(source);
  }

  function invalidateVolumeEdit() {
    if (interaction.edit) interaction.edit.valid = false;
  }

  function finishVolumeEdit() {
    clearVolumeEditEndTimer();
    interaction.edit = null;
  }

  function scheduleVolumeEditEnd() {
    clearVolumeEditEndTimer();
    const delay = interaction.edit && !interaction.edit.valid ? INTERACTION_SETTLE_MS : 0;
    interaction.editEndTimer = setTimeout(() => {
      interaction.editEndTimer = null;
      if (!interaction.keyboardActive && !interaction.pointerActive) interaction.edit = null;
    }, delay);
  }

  function restoreSelectedVolume() {
    if (selectedVolumePercent !== null) paintVolume(selectedVolumePercent);
  }

  /* The hand is still on the control: a pointer is down or a volume key is
     held. Distinct from isVolumeInteractionActive, which stays true through the
     settle window afterwards so polling cannot snap the thumb back. */
  function isVolumeGestureActive() {
    return interaction.pointerActive || interaction.keyboardActive;
  }

  function isVolumeInteractionActive() {
    return interaction.keyboardActive
      || interaction.pointerActive
      || interaction.pendingWrites > 0
      || Date.now() < interaction.settleUntil;
  }

  function holdPolling() {
    interaction.settleUntil = Date.now() + INTERACTION_SETTLE_MS;
  }

  function setControlMessage(message, isError = false) {
    setText(elements.controlStatus, message);
    elements.controlStatus.classList.toggle('error', isError);
  }

  function discardVolumeFeedback() {
    clearTimeout(controlMessage.feedbackTimer);
    controlMessage.feedbackTimer = null;
    controlMessage.feedback = null;
  }

  function renderControlMessage() {
    if (controlMessage.feedback && Date.now() >= controlMessage.feedback.expiresAt) {
      discardVolumeFeedback();
    }
    if (controlMessage.feedback && controlMessage.feedback.target !== selectedVolumeTarget) {
      discardVolumeFeedback();
    }
    const visibleFeedback = controlMessage.volumeAvailable && controlMessage.feedback;
    const message = visibleFeedback || controlMessage.baseline;
    setControlMessage(message.message, message.isError);
  }

  function setControlBaseline(message, isError, volumeAvailable) {
    controlMessage.baseline = { message, isError };
    controlMessage.volumeAvailable = volumeAvailable;
    if (!volumeAvailable) discardVolumeFeedback();
    renderControlMessage();
  }

  function clearVolumeFeedback() {
    discardVolumeFeedback();
    renderControlMessage();
  }

  function showVolumeFeedback(message, isError, write) {
    if (write.id !== latestWrite
        || write.target !== selectedVolumeTarget
        || !controlMessage.volumeAvailable) return;
    /* Mid-gesture this would be overwritten before it could be read, and
       submitVolume repaints the baseline between writes, so the region would
       stutter rather than inform. Keep the outcome for the release instead. */
    if (isVolumeGestureActive()) {
      owedVolumeOutcome = { isError, message, target: write.target };
      return;
    }
    renderVolumeFeedback(message, isError, write.target);
  }

  function renderVolumeFeedback(message, isError, target) {
    if (target !== selectedVolumeTarget || !controlMessage.volumeAvailable) return;
    discardVolumeFeedback();
    const feedback = {
      expiresAt: Date.now() + VOLUME_FEEDBACK_MS,
      isError,
      message,
      target,
    };
    controlMessage.feedback = feedback;
    renderControlMessage();
    controlMessage.feedbackTimer = setTimeout(() => {
      if (controlMessage.feedback !== feedback) return;
      controlMessage.feedback = null;
      controlMessage.feedbackTimer = null;
      renderControlMessage();
    }, VOLUME_FEEDBACK_MS);
  }

  /* One announcement per gesture, spoken once the hand comes off. A drag whose
     writes all failed still says so; a drag that worked says so once. */
  function endVolumeGestureIfIdle() {
    if (!isVolumeGestureActive()) announceOwedVolumeOutcome();
  }

  function announceOwedVolumeOutcome() {
    const owed = owedVolumeOutcome;
    owedVolumeOutcome = null;
    if (owed) renderVolumeFeedback(owed.message, owed.isError, owed.target);
  }

  function paintVolume(percent) {
    const rounded = Math.round(clamp(percent, 0, 100));
    elements.volume.value = String(rounded);
    elements.volume.setAttribute('aria-valuetext', `${rounded} percent`);
    setText(elements.volumeValue, `${rounded}%`);
  }

  function setVolumeUnavailable() {
    invalidateVolumeEdit();
    lastSubmittedVolume = null;
    owedVolumeOutcome = null;
    if (document.activeElement === elements.volume) elements.volume.blur();
    elements.volume.disabled = true;
    interaction.keyboardActive = false;
    interaction.pointerActive = false;
    elements.volume.setAttribute('aria-valuetext', 'Unavailable');
    setText(elements.volumeValue, '—');
  }

  function playbackTitle(status, connected) {
    if (!connected) return 'Nothing playing';
    if (status.media && status.media.title) return String(status.media.title);
    if (String(status.state || '').toUpperCase() === 'IDLE') return 'Nothing playing';
    return 'Playback details unavailable';
  }

  function renderStatus(status) {
    const connected = status && status.connected === true;
    const hasError = Boolean(status && status.error);
    const selected = hasSelectedDevice(status);
    const target = status && typeof status.device === 'string' && status.device
      ? status.device : null;
    const finiteVolume = Number.isFinite(status && status.volume);
    const canAdjustVolume = selected && Boolean(target) && finiteVolume && !hasError;
    const statusAvailable = connected || selected;
    const stateLabel = statusAvailable && !hasError ? formatState(status.state) : 'Disconnected';
    const nextVolumeTarget = canAdjustVolume ? target : null;
    const targetChanged = nextVolumeTarget !== selectedVolumeTarget;
    selectedVolumeTarget = nextVolumeTarget;
    selectedVolumePercent = canAdjustVolume ? clamp(status.volume, 0, 1) * 100 : null;
    if (targetChanged) {
      invalidateVolumeEdit();
      discardVolumeFeedback();
      lastSubmittedVolume = null;
      owedVolumeOutcome = null;
    }

    setText(elements.nowPlaying, playbackTitle(status || {}, connected && !hasError));
    setText(elements.deviceName, selected
      ? String(status.device_name || 'Selected speaker or group')
      : 'No speaker selected');
    setText(elements.playbackState, stateLabel);
    elements.playbackState.dataset.state = stateStyle(status && status.state, statusAvailable, hasError);

    const transport = (statusAvailable && !hasError) ? transportFor(status && status.state) : null;
    pendingTransport = transport ? transport.action : null;
    setText(elements.playbackToggle, transport ? transport.label : 'Pause');
    elements.playbackToggle.setAttribute('aria-label', transport ? transport.label : 'Pause');
    elements.playbackToggle.title = transport ? transport.label : 'Nothing to pause';
    elements.playbackToggle.disabled = !transport;

    if (!canAdjustVolume) {
      setVolumeUnavailable();
      const message = connected || selected
        ? 'Volume is unavailable for the selected speaker or group.'
        : 'Open the main window to select a speaker or group.';
      setControlBaseline(message, hasError, false);
      return;
    }

    elements.volume.disabled = false;
    /* An authoritative repaint means the speaker, not this window, decides
       what the slider reads - so what we last sent is no longer what it is at,
       and the same value must be allowed through again. */
    if (targetChanged || !isVolumeInteractionActive()) {
      paintVolume(selectedVolumePercent);
      lastSubmittedVolume = null;
    }
    setControlBaseline(`Volume for ${status.device_name || 'the selected speaker or group'}.`, false, true);
  }

  async function requestJson(path, options = {}, timeoutMs) {
    const controller = new AbortController();
    const sourceSignal = options.signal;
    const abortFromSource = () => controller.abort(sourceSignal.reason);
    if (sourceSignal) {
      if (sourceSignal.aborted) abortFromSource();
      else sourceSignal.addEventListener('abort', abortFromSource, { once: true });
    }
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(path, { ...options, signal: controller.signal });
      let body = {};
      try {
        body = await response.json();
      } catch (error) {
        if (controller.signal.aborted) throw error;
      }
      if (!response.ok) throw new Error('request failed');
      return body;
    } finally {
      clearTimeout(timeout);
      if (sourceSignal) sourceSignal.removeEventListener('abort', abortFromSource);
    }
  }

  function cancelScheduledPoll() {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  function schedulePoll() {
    cancelScheduledPoll();
    if (document.hidden) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void pollStatus();
    }, POLL_INTERVAL_MS);
  }

  function requestImmediatePoll() {
    cancelScheduledPoll();
    if (document.hidden) return;
    if (pollInFlight) {
      pollRefreshRequested = true;
      return;
    }
    pollRefreshRequested = false;
    void pollStatus();
  }

  async function pollStatus() {
    if (document.hidden) return;
    if (pollInFlight) {
      pollRefreshRequested = true;
      return;
    }
    pollInFlight = true;
    const requestController = new AbortController();
    statusRequestController = requestController;
    try {
      const status = await requestJson('/api/status', {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: requestController.signal,
      }, STATUS_REQUEST_TIMEOUT_MS);
      if (!document.hidden && !requestController.signal.aborted) renderStatus(status);
    } catch {
      if (!document.hidden && !requestController.signal.aborted) {
        renderStatus({ connected: false });
        setControlBaseline('Unable to reach the app. Retrying…', true, false);
      }
    } finally {
      if (statusRequestController === requestController) statusRequestController = null;
      pollInFlight = false;
      if (document.hidden) {
        pollRefreshRequested = false;
        return;
      }
      if (pollRefreshRequested) {
        pollRefreshRequested = false;
        requestImmediatePoll();
        return;
      }
      schedulePoll();
    }
  }

  function normalizedSliderVolume() {
    const percent = Number(elements.volume.value);
    if (!Number.isFinite(percent)) return null;
    return clamp(percent, 0, 100) / 100;
  }

  function syncPendingWriteLock() {
    interaction.pendingWrites = Number(Boolean(volumeWriter.inFlight))
      + Number(Boolean(volumeWriter.pending));
  }

  async function sendVolume(write) {
    let succeeded = false;
    try {
      await requestJson('/api/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'volume', target: write.target, value: write.value }),
      }, VOLUME_REQUEST_TIMEOUT_MS);
      succeeded = true;
    } catch {
      succeeded = false;
    }
    if (write.edit) write.edit.failures = succeeded ? 0 : (write.edit.failures || 0) + 1;
    if (succeeded) showVolumeFeedback('Volume updated.', false, write);
    else showVolumeFeedback('Volume change did not reach the speaker.', true, write);
  }

  function finishVolumeWrite(write) {
    if (volumeWriter.inFlight !== write) return;
    const nextWrite = volumeWriter.pending;
    volumeWriter.inFlight = null;
    volumeWriter.pending = null;
    syncPendingWriteLock();
    holdPolling();
    if (nextWrite) startVolumeWrite(nextWrite);
  }

  async function processVolumeWrite(write) {
    try {
      await sendVolume(write);
    } finally {
      finishVolumeWrite(write);
    }
  }

  function startVolumeWrite(write) {
    volumeWriter.inFlight = write;
    /* The pending slot outlives the poll that composed it, so a speaker change
       can land between queueing and sending. Drop the write rather than aiming
       one speaker's value at another and relying on the server's 409. */
    if (write.target !== selectedVolumeTarget) {
      finishVolumeWrite(write);
      return;
    }
    syncPendingWriteLock();
    void processVolumeWrite(write).catch(() => {
      showVolumeFeedback('Volume change did not reach the speaker.', true, write);
    });
  }

  function submitVolume(edit) {
    if (elements.volume.disabled
        || !edit
        || !edit.valid
        || edit.target !== selectedVolumeTarget) {
      restoreSelectedVolume();
      return;
    }
    const value = normalizedSliderVolume();
    const target = edit.target;
    if (value === null || !target) return;
    /* The speaker is already here. Every drag ends with a 'change' carrying the
       value its last 'input' already sent, and every arrow key fires both, so
       without this the write count per gesture doubles for no effect. */
    if (lastSubmittedVolume
        && lastSubmittedVolume.target === target
        && lastSubmittedVolume.value === value) return;
    if (edit.failures >= GESTURE_FAILURE_LIMIT && isVolumeGestureActive()) return;
    lastSubmittedVolume = { target, value };

    const writeId = ++latestWrite;
    const write = { edit, id: writeId, target, value };
    /* Between writes of a live drag the baseline would flash back over the last
       result; the release announces the outcome instead. */
    if (!isVolumeGestureActive()) clearVolumeFeedback();
    if (volumeWriter.inFlight) volumeWriter.pending = write;
    else startVolumeWrite(write);
    syncPendingWriteLock();
    holdPolling();
  }

  function releasePointerInteraction() {
    if (!interaction.pointerActive) return;
    interaction.pointerActive = false;
    holdPolling();
    scheduleVolumeEditEnd();
    endVolumeGestureIfIdle();
  }

  function bindVolumeInteraction() {
    elements.volume.addEventListener('blur', () => {
      interaction.keyboardActive = false;
      releasePointerInteraction();
      holdPolling();
      scheduleVolumeEditEnd();
      endVolumeGestureIfIdle();
    });
    elements.volume.addEventListener('pointerdown', () => {
      startVolumeEdit('pointer');
      interaction.pointerActive = true;
    });
    window.addEventListener('pointerup', releasePointerInteraction);
    window.addEventListener('pointercancel', () => {
      /* The speaker is already at the last dragged value, so snapping the
         slider back would show a number it is not at. Commit what the gesture
         reached - dedupe makes this free when the value already went out, and
         an edit invalidated by a speaker change still restores. Released
         first, so the failure limit cannot block this last attempt. */
      releasePointerInteraction();
      submitVolume(interaction.edit);
    });
    elements.volume.addEventListener('keydown', event => {
      if (!VOLUME_KEYS.has(event.key)) return;
      if (!interaction.keyboardActive) startVolumeEdit('keyboard');
      else ensureVolumeEdit('keyboard');
      interaction.keyboardActive = true;
    });
    elements.volume.addEventListener('keyup', event => {
      if (!VOLUME_KEYS.has(event.key)) return;
      interaction.keyboardActive = false;
      holdPolling();
      scheduleVolumeEditEnd();
      endVolumeGestureIfIdle();
    });
    elements.volume.addEventListener('input', () => {
      const edit = ensureVolumeEdit('assistive');
      if (!edit.valid || edit.target !== selectedVolumeTarget) {
        restoreSelectedVolume();
        return;
      }
      paintVolume(Number(elements.volume.value));
      holdPolling();
      /* Paint first: paintVolume rounds and writes the value back to the
         element, and submitVolume reads it back out, so what is sent is
         provably what is shown. The writer's one-in-flight latch is what keeps
         a drag from flooding the speaker - it self-clocks to whatever the
         device can absorb, which is why no throttle is needed here. */
      submitVolume(edit);
    });
    elements.volume.addEventListener('change', () => {
      submitVolume(ensureVolumeEdit('assistive'));
      if (!interaction.keyboardActive && !interaction.pointerActive) finishVolumeEdit();
    });
  }

  function bindPollingVisibility() {
    document.addEventListener('visibilitychange', () => {
      cancelScheduledPoll();
      if (document.hidden) {
        pollRefreshRequested = false;
        interaction.keyboardActive = false;
        interaction.pointerActive = false;
        interaction.settleUntil = 0;
        invalidateVolumeEdit();
        finishVolumeEdit();
        /* The panel closes mid-drag every time it loses focus, so a queued
           write would land at a speaker the user can no longer see, and its
           outcome would be announced to an empty room. Drop both; the write
           already in flight is left to finish on its own. */
        volumeWriter.pending = null;
        syncPendingWriteLock();
        lastSubmittedVolume = null;
        owedVolumeOutcome = null;
        if (statusRequestController) statusRequestController.abort();
        return;
      }
      renderControlMessage();
      requestImmediatePoll();
    });
  }

  /* Goes through the same /api/control the main window uses, so pausing from
     the menu bar and pausing from the window are the same operation. The button
     is disabled again until the next poll confirms what actually happened,
     rather than flipping its own label optimistically and lying if the request
     fails. */
  async function sendTransport(action) {
    elements.playbackToggle.disabled = true;
    try {
      await requestJson('/api/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      }, VOLUME_REQUEST_TIMEOUT_MS);
      requestImmediatePoll();
    } catch {
      setControlMessage(action === 'pause' ? 'Could not pause the speaker.'
                                           : 'Could not start the speaker.', true);
      elements.playbackToggle.disabled = false;
    }
  }

  function bindTransportButton() {
    elements.playbackToggle.addEventListener('click', () => {
      if (!pendingTransport) return;
      sendTransport(pendingTransport);
    });
  }

  function bridgeMethod(name) {
    const bridge = window.trayPopup;
    return bridge && typeof bridge[name] === 'function' ? bridge[name].bind(bridge) : null;
  }

  function bindBridgeButton(button, methodName) {
    const method = bridgeMethod(methodName);
    if (!method) {
      button.disabled = true;
      return;
    }
    button.addEventListener('click', () => {
      try {
        Promise.resolve(method()).catch(() => {
          setControlMessage('App controls are unavailable.', true);
        });
      } catch {
        setControlMessage('App controls are unavailable.', true);
      }
    });
  }

  function initialize() {
    bindVolumeInteraction();
    bindTransportButton();
    bindPollingVisibility();
    bindBridgeButton(elements.openWindow, 'openWindow');
    bindBridgeButton(elements.quit, 'quit');
    requestImmediatePoll();
  }

  initialize();
})();
