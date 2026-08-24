'use strict';

const DEFAULT_OPERATION_TIMEOUT_MS = 4000;

class VolumeWriteTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`volume operation timed out after ${timeoutMs}ms`);
    this.name = 'VolumeWriteTimeoutError';
  }
}

function normalizeVolume(value) {
  if (!Number.isFinite(value)) throw new TypeError('volume must be a finite number');
  return Math.min(1, Math.max(0, value));
}

function isVolumeTargetCurrent(suppliedTarget, currentTarget) {
  return suppliedTarget === undefined
    || (typeof suppliedTarget === 'string' && suppliedTarget === currentTarget);
}

function createVolumeWriteCoordinator({
  operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
  scheduleTimeout = setTimeout,
  cancelTimeout = clearTimeout,
} = {}) {
  if (!Number.isFinite(operationTimeoutMs) || operationTimeoutMs <= 0) {
    throw new TypeError('operationTimeoutMs must be a positive finite number');
  }
  if (typeof scheduleTimeout !== 'function' || typeof cancelTimeout !== 'function') {
    throw new TypeError('timeout dependencies must be functions');
  }

  const targets = new Map();

  function stateFor(target) {
    if (!targets.has(target)) {
      targets.set(target, {
        active: null,
        generation: 0,
        latest: null,
        queued: null,
        repairNeeded: false,
      });
    }
    return targets.get(target);
  }

  function settle(request, outcome, error) {
    if (request.settled) return;
    request.settled = true;
    if (error) request.reject(error);
    else request.resolve({ outcome, value: request.value });
  }

  function pump(state) {
    if (state.active) return;
    if (state.queued) {
      const next = state.queued;
      state.queued = null;
      startAttempt(state, next, false);
      return;
    }
    if (state.repairNeeded && state.latest) {
      // Consume one repair signal up front: failures never retry themselves, but
      // another late stale success can independently request one more repair.
      state.repairNeeded = false;
      startAttempt(state, state.latest, true);
    }
  }

  function finishAttempt(state, attempt, error) {
    if (attempt.finished) return;
    attempt.finished = true;
    cancelTimeout(attempt.timer);

    if (attempt.timedOut) {
      // The device call was unabortable. Its late success may have overwritten a
      // newer generation, so put the latest snapshotted operation back in line.
      if (!error && attempt.request.generation < state.generation) state.repairNeeded = true;
      pump(state);
      return;
    }

    if (state.active === attempt) state.active = null;
    if (!error && attempt.request.generation === state.generation) state.repairNeeded = false;
    if (!attempt.repair) {
      settle(attempt.request, 'applied', error);
    }
    pump(state);
  }

  function timeOutAttempt(state, attempt) {
    if (attempt.finished || state.active !== attempt) return;
    attempt.timedOut = true;
    state.active = null;
    if (!attempt.repair) {
      settle(attempt.request, null, new VolumeWriteTimeoutError(operationTimeoutMs));
    }
    pump(state);
  }

  function startAttempt(state, request, repair) {
    const attempt = {
      finished: false,
      repair,
      request,
      timedOut: false,
      timer: null,
    };
    state.active = attempt;
    attempt.timer = scheduleTimeout(() => timeOutAttempt(state, attempt), operationTimeoutMs);
    Promise.resolve()
      .then(() => request.write(request.value))
      .then(
        () => finishAttempt(state, attempt, null),
        error => finishAttempt(state, attempt, error || new Error('volume operation failed')),
      );
  }

  function submit({ target, value, write }) {
    if (typeof target !== 'string' || !target) throw new TypeError('target must be a non-empty string');
    if (typeof write !== 'function') throw new TypeError('write must be a function');
    const normalizedValue = normalizeVolume(value);
    const state = stateFor(target);
    const request = {
      generation: ++state.generation,
      reject: null,
      resolve: null,
      settled: false,
      value: normalizedValue,
      write,
    };
    const result = new Promise((resolve, reject) => {
      request.resolve = resolve;
      request.reject = reject;
    });
    state.latest = request;

    if (state.active) {
      if (state.queued) settle(state.queued, 'superseded', null);
      state.queued = request;
    } else {
      startAttempt(state, request, false);
    }
    return result;
  }

  return Object.freeze({ submit });
}

module.exports = {
  DEFAULT_OPERATION_TIMEOUT_MS,
  VolumeWriteTimeoutError,
  createVolumeWriteCoordinator,
  isVolumeTargetCurrent,
  normalizeVolume,
};
