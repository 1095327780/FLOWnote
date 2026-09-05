const test = require("node:test");
const assert = require("node:assert/strict");

const {
  collectLiveCheckpointRefs,
  checkpointReferenceIsStillNeeded,
} = require("../../../runtime/chat/direct-checkpoint-lifecycle");

function ref(hash) {
  return {
    version: 1,
    id: `sha256:${hash.repeat(64)}`,
    path: `.obsidian/plugins/flownote/continuations/${hash.repeat(64)}.json`,
    byteLength: 123,
  };
}

function assistant(status, checkpointRef, extra = {}) {
  return {
    role: "assistant",
    status,
    execution: {
      version: 1,
      events: [{ type: "run_suspended", checkpointRef }],
    },
    ...extra,
  };
}

test("live checkpoint roots are unique across sessions and exclude consumed or terminal messages", () => {
  const a = ref("a");
  const b = ref("b");
  const store = {
    state: () => ({
      messagesBySession: {
        one: [assistant("suspended", a), assistant("suspended", b, { continuationConsumedBy: "next" })],
        two: [assistant("suspended", a), assistant("completed", b)],
      },
    }),
  };

  assert.deepEqual(collectLiveCheckpointRefs(store), [a]);
  assert.equal(checkpointReferenceIsStillNeeded(store, a), true);
  assert.equal(checkpointReferenceIsStillNeeded(store, b), false);
});

test("malformed durable refs never become garbage-collection roots", () => {
  const store = {
    state: () => ({
      messagesBySession: {
        one: [assistant("suspended", { id: "not-a-hash", path: "private.json" })],
      },
    }),
  };

  assert.deepEqual(collectLiveCheckpointRefs(store), []);
});
