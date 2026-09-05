const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ProviderStreamError,
  makeBrowserStreamIterable,
  makeNodeStreamIterable,
} = require("../../../runtime/providers/streaming-fetch");

function pendingForever() {
  return new Promise(() => {});
}

function browserStreamFromReads(reads, hooks = {}) {
  let index = 0;
  return {
    getReader() {
      return {
        read() {
          const next = reads[index++];
          return typeof next === "function" ? next() : next;
        },
        cancel(reason) {
          if (hooks.onCancel) hooks.onCancel(reason);
          return Promise.resolve();
        },
        releaseLock() {
          if (hooks.onRelease) hooks.onRelease();
        },
      };
    },
  };
}

function nodeReadableFromReads(reads, hooks = {}) {
  let index = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          const next = reads[index++];
          return typeof next === "function" ? next() : next;
        },
      };
    },
    destroy(reason) {
      if (hooks.onDestroy) hooks.onDestroy(reason);
    },
  };
}

test("browser stream wraps a mid-body reader failure with provider metadata", async () => {
  const rawError = new TypeError("Load failed");
  const stream = browserStreamFromReads([
    Promise.resolve({ done: false, value: new TextEncoder().encode("hello") }),
    () => Promise.reject(rawError),
  ]);
  const iterator = makeBrowserStreamIterable(stream, null, { idleTimeoutMs: 100 });

  assert.deepEqual(await iterator.next(), { done: false, value: "hello" });
  await assert.rejects(iterator.next(), (error) => {
    assert.ok(error instanceof ProviderStreamError);
    assert.equal(error.code, "PROVIDER_STREAM_READ_FAILED");
    assert.equal(error.phase, "response_body");
    assert.equal(error.transport, "browser");
    assert.equal(error.receivedChunks, 1);
    assert.equal(error.retryable, true);
    assert.equal(error.recoverable, true);
    assert.equal(error.replaySafe, false);
    assert.equal(error.recovery, "checkpoint_resume");
    assert.equal(error.cause, rawError);
    return true;
  });
});

test("browser stream times out an idle body read and cancels the reader", async () => {
  let cancelReason = null;
  const stream = browserStreamFromReads([pendingForever()], {
    onCancel(reason) { cancelReason = reason; },
  });
  const iterator = makeBrowserStreamIterable(stream, null, { idleTimeoutMs: 15 });

  await assert.rejects(iterator.next(), (error) => {
    assert.ok(error instanceof ProviderStreamError);
    assert.equal(error.code, "PROVIDER_STREAM_IDLE_TIMEOUT");
    assert.equal(error.transport, "browser");
    assert.equal(error.idleTimeoutMs, 15);
    return true;
  });
  assert.equal(cancelReason && cancelReason.code, "PROVIDER_STREAM_IDLE_TIMEOUT");
});

test("each received chunk renews the stream idle timeout", async () => {
  const after = (ms, result) => () => new Promise((resolve) => setTimeout(() => resolve(result), ms));
  const stream = browserStreamFromReads([
    after(20, { done: false, value: new TextEncoder().encode("a") }),
    after(20, { done: false, value: new TextEncoder().encode("b") }),
    after(20, { done: true }),
  ]);
  const iterator = makeBrowserStreamIterable(stream, null, { idleTimeoutMs: 35 });

  assert.deepEqual(await iterator.next(), { done: false, value: "a" });
  assert.deepEqual(await iterator.next(), { done: false, value: "b" });
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
});

test("user cancellation remains AbortError instead of a provider failure", async () => {
  const controller = new AbortController();
  let cancelReason = null;
  const stream = browserStreamFromReads([pendingForever()], {
    onCancel(reason) { cancelReason = reason; },
  });
  const iterator = makeBrowserStreamIterable(stream, null, {
    idleTimeoutMs: 100,
    signal: controller.signal,
  });

  const pending = iterator.next();
  controller.abort();
  await assert.rejects(pending, (error) => {
    assert.equal(error.name, "AbortError");
    assert.equal(error.code, "ABORT_ERR");
    assert.equal(error instanceof ProviderStreamError, false);
    return true;
  });
  assert.equal(cancelReason && cancelReason.name, "AbortError");
});

test("desktop and mobile stream paths expose the same liveness error semantics", async () => {
  const nodeReadable = nodeReadableFromReads([pendingForever()]);
  const browserStream = browserStreamFromReads([pendingForever()]);
  const nodeIterator = makeNodeStreamIterable(nodeReadable, null, { idleTimeoutMs: 15 });
  const browserIterator = makeBrowserStreamIterable(browserStream, null, { idleTimeoutMs: 15 });

  const captureError = async (promise) => {
    try {
      await promise;
      assert.fail("expected stream read to reject");
    } catch (error) {
      return error;
    }
  };
  const errors = await Promise.all([
    captureError(nodeIterator.next()),
    captureError(browserIterator.next()),
  ]);
  const comparable = errors.map((error) => ({
    name: error.name,
    code: error.code,
    phase: error.phase,
    idleTimeoutMs: error.idleTimeoutMs,
    retryable: error.retryable,
    recoverable: error.recoverable,
  }));
  assert.deepEqual(comparable[0], comparable[1]);
});
