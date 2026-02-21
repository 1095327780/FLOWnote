const test = require("node:test");
const assert = require("node:assert/strict");

const { migrateLegacyMessages } = require("../../runtime/state-migrations");

test("migrateLegacyMessages should compact inflated reasoning snapshots", () => {
  const chunks = [];
  let acc = "";
  for (let i = 0; i < 320; i += 1) {
    acc += `步骤${i} `;
    chunks.push(acc.trim());
  }
  const reasoning = chunks.join("\n\n");
  const runtimeState = {
    messagesBySession: {
      ses_1: [
        {
          id: "msg_1",
          role: "assistant",
          text: "",
          reasoning,
          blocks: [],
        },
      ],
    },
  };

  const migrated = migrateLegacyMessages(runtimeState);
  const nextReasoning = migrated.messagesBySession.ses_1[0].reasoning;
  assert.ok(nextReasoning.length < reasoning.length * 0.7);
  assert.match(nextReasoning, /步骤319/);
});

test("migrateLegacyMessages should compact oversized raw tool block payload", () => {
  const runtimeState = {
    messagesBySession: {
      ses_1: [
        {
          id: "msg_1",
          role: "assistant",
          text: "",
          reasoning: "",
          blocks: [
            {
              id: "blk_1",
              type: "tool",
              status: "completed",
              raw: {
                id: "prt_1",
                type: "tool",
                sessionID: "ses_1",
                messageID: "msg_1",
                tool: "read",
                state: {
                  status: "completed",
                  input: { filePath: "/tmp/a.md" },
                  output: "x".repeat(30000),
                  error: "",
                },
              },
            },
          ],
        },
      ],
    },
  };

  const migrated = migrateLegacyMessages(runtimeState);
  const block = migrated.messagesBySession.ses_1[0].blocks[0];
  assert.ok(block.raw && block.raw.state);
  assert.equal(block.raw.state.status, "completed");
  assert.equal(block.raw.state.input.filePath, "/tmp/a.md");
  assert.equal(Object.prototype.hasOwnProperty.call(block.raw.state, "output"), false);
});

test("migrateLegacyMessages should keep only the latest 200 messages per session", () => {
  const list = Array.from({ length: 250 }, (_, index) => ({
    id: `msg_${index}`,
    role: "user",
    text: String(index),
  }));
  const runtimeState = {
    messagesBySession: {
      ses_1: list,
    },
  };

  const migrated = migrateLegacyMessages(runtimeState);
  const next = migrated.messagesBySession.ses_1;
  assert.equal(next.length, 200);
  assert.equal(next[0].id, "msg_50");
  assert.equal(next[next.length - 1].id, "msg_249");
});

