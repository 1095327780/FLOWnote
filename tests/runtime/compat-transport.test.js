const test = require("node:test");
const assert = require("node:assert/strict");

const { CompatTransport } = require("../../runtime/compat-transport");

function createTransport() {
  return new CompatTransport({
    vaultPath: "/vault",
    settings: {
      cliPath: "",
      autoDetectCli: true,
      requestTimeoutMs: 120000,
      opencodeHomeDir: ".opencode-runtime",
      launchStrategy: "auto",
      wslDistro: "",
    },
    logger: () => {},
  });
}

test("normalizeDirectoryForService should migrate legacy wsl workspace directory", () => {
  const transport = createTransport();
  transport.launchContext = {
    mode: "wsl",
    directory: "/mnt/c/Users/me/Desktop/FLOWnote",
    label: "wsl(sh)",
    distro: "Ubuntu",
    wslHome: "/home/me/.flownote-home",
  };
  transport.resolveWslDirectory = () => "/home/me/.opencode-runtime/workspace";
  transport.getDefaultWslWorkspaceDir = () => "/home/me/.flownote-workspace";

  const normalized = transport.normalizeDirectoryForService("Y:\\Desktop\\FLOWnote");
  assert.equal(normalized, "/home/me/.flownote-workspace");
});

test("normalizeDirectoryForService should keep non-legacy wsl directory", () => {
  const transport = createTransport();
  transport.launchContext = {
    mode: "wsl",
    directory: "/mnt/c/Users/me/Desktop/FLOWnote",
    label: "wsl(sh)",
    distro: "Ubuntu",
    wslHome: "/home/me/.flownote-home",
  };
  transport.resolveWslDirectory = () => "/home/me/projects/FLOWnote";

  const normalized = transport.normalizeDirectoryForService("C:\\Users\\me\\Desktop\\FLOWnote");
  assert.equal(normalized, "/home/me/projects/FLOWnote");
});

test("normalizeDirectoryForService should keep mapped /mnt path when mount is accessible", () => {
  const transport = createTransport();
  let mirrored = false;
  transport.launchContext = {
    mode: "wsl",
    directory: "/mnt/c/Users/me/Desktop/FLOWnote",
    label: "wsl(sh)",
    distro: "Ubuntu",
    wslHome: "/home/me/.flownote-home",
  };
  transport.resolveWslDirectory = () => "/mnt/c/Users/me/Desktop/FLOWnote";
  transport.probeWslDirectory = () => true;
  transport.getDefaultWslWorkspaceDir = () => "/home/me/.flownote-workspace";
  transport.ensureWslFallbackWorkspaceMirror = () => {
    mirrored = true;
  };

  const normalized = transport.normalizeDirectoryForService("C:\\Users\\me\\Desktop\\FLOWnote");
  assert.equal(normalized, "/mnt/c/Users/me/Desktop/FLOWnote");
  assert.equal(mirrored, false);
});

test("normalizeDirectoryForService should fallback when mapped /mnt path is inaccessible", () => {
  const transport = createTransport();
  let mirrorArgs = null;
  transport.launchContext = {
    mode: "wsl",
    directory: "/mnt/y/Desktop/FLOWnote",
    label: "wsl(sh)",
    distro: "Ubuntu",
    wslHome: "/home/me/.flownote-home",
  };
  transport.resolveWslDirectory = () => "/mnt/y/Desktop/FLOWnote";
  transport.probeWslDirectory = () => false;
  transport.getDefaultWslWorkspaceDir = () => "/home/me/.flownote-workspace";
  transport.ensureWslFallbackWorkspaceMirror = (raw, fallback) => {
    mirrorArgs = { raw, fallback };
  };

  const normalized = transport.normalizeDirectoryForService("Y:\\Desktop\\FLOWnote");
  assert.equal(normalized, "/home/me/.flownote-workspace");
  assert.deepEqual(mirrorArgs, {
    raw: "Y:\\Desktop\\FLOWnote",
    fallback: "/home/me/.flownote-workspace",
  });
});

test("withWslRequestLock should run tasks sequentially", async () => {
  const transport = createTransport();
  const order = [];

  const p1 = transport.withWslRequestLock(async () => {
    order.push("a-start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    order.push("a-end");
    return "a";
  });
  const p2 = transport.withWslRequestLock(async () => {
    order.push("b-start");
    order.push("b-end");
    return "b";
  });

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, "a");
  assert.equal(r2, "b");
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
});

test("buildWslServeCommand should pin xdg paths in wsl", () => {
  const transport = createTransport();
  const script = transport.buildWslServeCommand("");
  assert.match(script, /XDG_DATA_HOME/);
  assert.match(script, /XDG_CONFIG_HOME/);
  assert.match(script, /\.flownote-data/);
  assert.match(script, /SRC_DATA_DIR/);
  assert.match(script, /TARGET_DATA_DIR/);
  assert.match(script, /cp -R/);
  assert.match(script, /-name \"\*\.lock\"/);
  assert.match(script, /WSL HOME=/);
  assert.doesNotMatch(script, /WSL OPENCODE_HOME/);
});

test("buildWslServeCommand should honor overridden WSL data home", () => {
  const transport = createTransport();
  transport.wslDataHomeOverride = "/home/me/.flownote-data-custom";
  const script = transport.buildWslServeCommand("");
  assert.match(script, /XDG_DATA_HOME_DIR='\/home\/me\/\.flownote-data-custom'/);
});

test("buildLaunchAttempts should run node script via node runtime", () => {
  const transport = createTransport();
  const attempts = transport.buildLaunchAttempts(
    {
      path: "/tmp/opencode-cli.js",
      kind: "node-script",
      nodePath: "/custom/node",
    },
    "/vault/.opencode-runtime",
  );

  const nodeAttempt = attempts.find((item) => item.command === "/custom/node");
  assert.ok(nodeAttempt);
  assert.equal(nodeAttempt.args[0], "/tmp/opencode-cli.js");
  assert.equal(nodeAttempt.args[1], "serve");
  assert.equal(nodeAttempt.remember, true);
  assert.equal(nodeAttempt.options && nodeAttempt.options.shell, false);
  assert.equal(attempts.some((item) => item.command === "/tmp/opencode-cli.js"), false);
});

test("buildLaunchProfileFromAttempt should skip non-rememberable attempts", () => {
  const transport = createTransport();
  const profile = transport.buildLaunchProfileFromAttempt({
    mode: "native",
    command: "node",
    args: ["/tmp/opencode-cli.js", "serve"],
    options: { shell: false },
    remember: false,
  });
  assert.equal(profile, null);
});

test("buildEventStreamUrlCandidates should include legacy and global endpoints", () => {
  const transport = createTransport();
  const urls = transport.buildEventStreamUrlCandidates(
    "http://127.0.0.1:38080",
    "/home/me/.flownote-workspace",
  );

  assert.deepEqual(urls, [
    {
      path: "/event",
      url: "http://127.0.0.1:38080/event?directory=%2Fhome%2Fme%2F.flownote-workspace",
    },
    {
      path: "/global/event",
      url: "http://127.0.0.1:38080/global/event?directory=%2Fhome%2Fme%2F.flownote-workspace",
    },
  ]);
});

test("buildLaunchAttempts should include WSL fallback on windows arm64 even in native mode", () => {
  const platformDesc = Object.getOwnPropertyDescriptor(process, "platform");
  const archDesc = Object.getOwnPropertyDescriptor(process, "arch");
  if (!platformDesc || !archDesc) return;

  try {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    Object.defineProperty(process, "arch", { value: "arm64", configurable: true });
    const transport = createTransport();
    transport.settings.launchStrategy = "native";
    const attempts = transport.buildLaunchAttempts(
      { path: "C:\\Users\\shanghao\\.opencode\\bin\\opencode.exe", kind: "native" },
      "C:\\vault\\.opencode-runtime",
    );
    assert.equal(attempts.some((item) => item.mode === "wsl"), true);
  } finally {
    Object.defineProperty(process, "platform", platformDesc);
    Object.defineProperty(process, "arch", archDesc);
  }
});

test("buildLaunchAttempts should self-heal native strategy on windows arm64 when cliPath is empty", () => {
  const platformDesc = Object.getOwnPropertyDescriptor(process, "platform");
  const archDesc = Object.getOwnPropertyDescriptor(process, "arch");
  if (!platformDesc || !archDesc) return;

  try {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    Object.defineProperty(process, "arch", { value: "arm64", configurable: true });
    const transport = createTransport();
    transport.settings.launchStrategy = "native";
    transport.settings.cliPath = "";
    transport.settings.wslDistro = "";
    const attempts = transport.buildLaunchAttempts(
      { path: "C:\\Users\\shanghao\\scoop\\shims\\opencode.exe", kind: "native" },
      "C:\\vault\\.opencode-runtime",
    );
    assert.equal(attempts.length > 0, true);
    assert.equal(attempts[0].mode, "wsl");
  } finally {
    Object.defineProperty(process, "platform", platformDesc);
    Object.defineProperty(process, "arch", archDesc);
  }
});

test("buildLaunchAttempts should force wsl strategy on windows arm64 when wsl hint exists", () => {
  const platformDesc = Object.getOwnPropertyDescriptor(process, "platform");
  const archDesc = Object.getOwnPropertyDescriptor(process, "arch");
  if (!platformDesc || !archDesc) return;

  try {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    Object.defineProperty(process, "arch", { value: "arm64", configurable: true });
    const transport = createTransport();
    transport.settings.launchStrategy = "native";
    transport.settings.wslDistro = "Ubuntu";
    const attempts = transport.buildLaunchAttempts(
      { path: "C:\\Users\\shanghao\\scoop\\shims\\opencode.exe", kind: "native" },
      "C:\\vault\\.opencode-runtime",
    );
    assert.equal(attempts.length > 0, true);
    assert.equal(attempts.every((item) => item.mode === "wsl"), true);
  } finally {
    Object.defineProperty(process, "platform", platformDesc);
    Object.defineProperty(process, "arch", archDesc);
  }
});

test("buildLaunchAttempts should understand windows-wsl legacy strategy value", () => {
  const platformDesc = Object.getOwnPropertyDescriptor(process, "platform");
  if (!platformDesc) return;

  try {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    const transport = createTransport();
    transport.settings.launchStrategy = "windows-wsl";
    transport.settings.wslDistro = "Ubuntu";
    const attempts = transport.buildLaunchAttempts(
      { path: "C:\\Users\\shanghao\\scoop\\shims\\opencode.exe", kind: "native" },
      "C:\\vault\\.opencode-runtime",
    );
    assert.equal(attempts.length > 0, true);
    assert.equal(attempts[0].mode, "wsl");
    assert.equal(attempts.some((item) => item.mode === "native"), false);
  } finally {
    Object.defineProperty(process, "platform", platformDesc);
  }
});

test("buildLaunchAttempts should prefer WSL first on windows arm64 auto mode", () => {
  const platformDesc = Object.getOwnPropertyDescriptor(process, "platform");
  const archDesc = Object.getOwnPropertyDescriptor(process, "arch");
  if (!platformDesc || !archDesc) return;

  try {
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    Object.defineProperty(process, "arch", { value: "arm64", configurable: true });
    const transport = createTransport();
    transport.settings.launchStrategy = "auto";
    const attempts = transport.buildLaunchAttempts(
      { path: "C:\\Users\\shanghao\\.opencode\\bin\\opencode.exe", kind: "native" },
      "C:\\vault\\.opencode-runtime",
    );
    assert.equal(attempts.length > 0, true);
    assert.equal(attempts[0].mode, "wsl");
  } finally {
    Object.defineProperty(process, "platform", platformDesc);
    Object.defineProperty(process, "arch", archDesc);
  }
});

test("getSessionStatus should support nested status payload shape", async () => {
  const transport = createTransport();
  transport.request = async () => ({
    sessionID: "ses_1",
    status: { type: "busy" },
  });

  const status = await transport.getSessionStatus("ses_1");
  assert.deepEqual(status, { type: "busy" });
});

test("getSessionStatus should support array payload shape", async () => {
  const transport = createTransport();
  transport.request = async () => ([
    { sessionID: "ses_1", status: { type: "retry", attempt: 1 } },
  ]);

  const status = await transport.getSessionStatus("ses_1");
  assert.deepEqual(status, { type: "retry", attempt: 1 });
});

test("getSessionStatus should support map value as string", async () => {
  const transport = createTransport();
  transport.request = async () => ({
    ses_1: "busy",
  });

  const status = await transport.getSessionStatus("ses_1");
  assert.deepEqual(status, { type: "busy" });
});

test("getSessionStatus should treat empty map payload as idle", async () => {
  const transport = createTransport();
  transport.request = async () => ({});

  const status = await transport.getSessionStatus("ses_1");
  assert.deepEqual(status, { type: "idle" });
});

test("getSessionStatus should treat map without target session as idle", async () => {
  const transport = createTransport();
  transport.request = async () => ({
    ses_other: { type: "busy" },
  });

  const status = await transport.getSessionStatus("ses_1");
  assert.deepEqual(status, { type: "idle" });
});

test("extractMessageList should support wrapped list payload", () => {
  const transport = createTransport();
  const list = transport.extractMessageList({
    messages: [
      {
        message: {
          id: "msg_1",
          role: "assistant",
          time: { created: 123 },
          parts: [{ type: "text", text: "ok" }],
        },
      },
    ],
  });

  assert.equal(Array.isArray(list), true);
  assert.equal(list.length, 1);
  assert.equal(list[0].info.role, "assistant");
  assert.equal(Array.isArray(list[0].parts), true);
});

test("extractMessageList should keep info-only envelope even when parts is missing", () => {
  const transport = createTransport();
  const list = transport.extractMessageList({
    messages: [
      {
        info: {
          id: "msg_1",
          role: "assistant",
          error: { name: "APIError", data: { message: "User not found." } },
          time: { created: 123 },
        },
      },
    ],
  });

  assert.equal(Array.isArray(list), true);
  assert.equal(list.length, 1);
  assert.equal(list[0].info.role, "assistant");
  assert.equal(Array.isArray(list[0].parts), true);
  assert.equal(list[0].parts.length, 0);
});

test("createSession should normalize session id aliases from response payload", async () => {
  const transport = createTransport();
  const calls = [];
  transport.request = async (method, endpoint, _body, query) => {
    calls.push({ method, endpoint, query });
    if (method === "POST" && endpoint === "/session") {
      return { sessionID: "ses_alias", title: "alias" };
    }
    throw new Error(`unexpected request: ${method} ${endpoint}`);
  };

  const session = await transport.createSession("alias");
  assert.equal(session.id, "ses_alias");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].query && calls[0].query.directory, "/vault");
  assert.equal(transport.getSessionScopedDirectory("ses_alias"), "/vault");
});

test("createSession should fallback directories in wsl mode when primary response lacks session id", async () => {
  const transport = createTransport();
  transport.launchContext = {
    mode: "wsl",
    directory: "/home/me/.flownote-workspace",
  };
  transport.getDefaultWslWorkspaceDir = () => "/home/me/.flownote-workspace";
  transport.resolveWslDirectory = () => "/home/me/projects/FLOWnote";
  transport.buildWslDirectoryCandidates = () => ["/home/me/projects/FLOWnote"];

  const attemptedDirectories = [];
  transport.request = async (method, endpoint, _body, query) => {
    if (method !== "POST" || endpoint !== "/session") {
      throw new Error(`unexpected request: ${method} ${endpoint}`);
    }
    const directory = String((query && query.directory) || "");
    attemptedDirectories.push(directory);
    if (directory === "/vault") return {};
    if (directory === "/home/me/.flownote-workspace") return { sessionId: "ses_wsl_ok", title: "wsl" };
    return {};
  };

  const session = await transport.createSession("");
  assert.equal(session.id, "ses_wsl_ok");
  assert.equal(attemptedDirectories[0], "/vault");
  assert.equal(attemptedDirectories.length, 2);
  assert.equal(Boolean(attemptedDirectories[1]), true);
  const normalizedHint = transport.normalizeDirectoryForService(attemptedDirectories[1]);
  assert.equal(transport.getSessionScopedDirectory("ses_wsl_ok"), normalizedHint);
});

test("fetchSessionMessages should fallback to unbounded list when limited window misses latest assistant", async () => {
  const transport = createTransport();
  const state = transport.createMessageListFetchState({ fallbackCooldownMs: 0 });
  const oldMessages = Array.from({ length: 50 }, (_, idx) => ({
    info: {
      id: `a_old_${idx + 1}`,
      role: "assistant",
      time: { created: 1000 + idx },
    },
    parts: [{ type: "text", text: `old-${idx + 1}` }],
  }));
  const latestMessage = {
    info: {
      id: "a_new",
      role: "assistant",
      time: { created: 5000, completed: 5001 },
    },
    parts: [{ type: "text", text: "new-response" }],
  };

  transport.request = async (_method, endpoint, _body, query) => {
    if (endpoint !== "/session/ses_1/message") throw new Error(`unexpected endpoint: ${endpoint}`);
    if (query && Number(query.limit) === 50) {
      return { messages: oldMessages };
    }
    return { messages: [...oldMessages, latestMessage] };
  };

  const fetched = await transport.fetchSessionMessages("ses_1", {
    startedAt: 4500,
    limit: 50,
    state,
  });

  assert.equal(fetched.strategy, "unbounded");
  assert.equal(Boolean(state.useUnbounded), true);
  assert.ok(fetched.latest);
  assert.equal(fetched.latest.info.id, "a_new");
  assert.equal(fetched.list.length, 51);
});

test("fetchSessionMessages should keep using unbounded strategy after detecting limited-window mismatch", async () => {
  const transport = createTransport();
  const state = transport.createMessageListFetchState({ fallbackCooldownMs: 0 });
  let limitedCalls = 0;
  let unboundedCalls = 0;
  const oldMessages = Array.from({ length: 50 }, (_, idx) => ({
    info: {
      id: `a_old_${idx + 1}`,
      role: "assistant",
      time: { created: 1000 + idx },
    },
    parts: [{ type: "text", text: `old-${idx + 1}` }],
  }));
  const latestMessage = {
    info: {
      id: "a_new",
      role: "assistant",
      time: { created: 6000, completed: 6001 },
    },
    parts: [{ type: "text", text: "latest" }],
  };

  transport.request = async (_method, endpoint, _body, query) => {
    if (endpoint !== "/session/ses_1/message") throw new Error(`unexpected endpoint: ${endpoint}`);
    if (query && Number(query.limit) === 50) {
      limitedCalls += 1;
      return { messages: oldMessages };
    }
    unboundedCalls += 1;
    return { messages: [...oldMessages, latestMessage] };
  };

  const first = await transport.fetchSessionMessages("ses_1", {
    startedAt: 5500,
    limit: 50,
    state,
  });
  const second = await transport.fetchSessionMessages("ses_1", {
    startedAt: 5500,
    limit: 50,
    state,
  });

  assert.equal(first.strategy, "unbounded");
  assert.equal(second.strategy, "unbounded");
  assert.equal(limitedCalls, 1);
  assert.equal(unboundedCalls, 2);
});

test("fetchSessionMessages should fallback directory in wsl mode and cache session hint", async () => {
  const transport = createTransport();
  transport.launchContext = {
    mode: "wsl",
    directory: "/home/me/.flownote-workspace",
    label: "wsl(sh)",
    distro: "Ubuntu",
    wslHome: "/home/me/.flownote-home",
    wslUserHome: "/home/me",
  };
  transport.getDefaultWslWorkspaceDir = () => "/home/me/.flownote-workspace";
  transport.resolveWslDirectory = (value) => String(value || "");
  transport.buildWslDirectoryCandidates = () => ["/home/me/.flownote-workspace"];

  transport.request = async (_method, endpoint, _body, query) => {
    if (endpoint !== "/session/ses_1/message") throw new Error(`unexpected endpoint: ${endpoint}`);
    if (query && query.directory === "/vault") {
      return { messages: [] };
    }
    if (query && query.directory === "/home/me/.flownote-workspace") {
      return {
        messages: [
          {
            info: { id: "a_1", role: "assistant", time: { created: 1001, completed: 1002 } },
            parts: [{ type: "text", text: "hello from hint dir" }],
          },
        ],
      };
    }
    return { messages: [] };
  };

  const fetched = await transport.fetchSessionMessages("ses_1", {
    limit: 20,
    requireRecentTail: true,
  });

  assert.equal(fetched.strategy, "limited-directory-fallback");
  assert.equal(Array.isArray(fetched.list), true);
  assert.equal(fetched.list.length, 1);
  assert.equal(transport.getSessionScopedDirectory("ses_1"), "/home/me/.flownote-workspace");
});

test("sendMessage should use session directory hint for history session", async () => {
  const transport = createTransport();
  transport.settings.enableStreaming = false;
  transport.rememberSessionDirectoryHint("ses_1", "/home/me/.flownote-workspace");

  transport.request = async (method, endpoint, _body, query) => {
    if (method === "POST" && endpoint === "/session/ses_1/message") {
      assert.equal(query && query.directory, "/home/me/.flownote-workspace");
      return {
        info: {
          id: "a_1",
          role: "assistant",
          time: { created: 1001, completed: 1002 },
          finish: "stop",
        },
        parts: [{ type: "text", text: "ok" }],
      };
    }
    throw new Error(`unexpected request: ${method} ${endpoint}`);
  };

  const result = await transport.sendMessage({
    sessionId: "ses_1",
    prompt: "hello",
  });

  assert.equal(result.messageId, "a_1");
  assert.equal(result.text, "ok");
});

test("sendMessage should route by session alias mapping", async () => {
  const transport = createTransport();
  transport.settings.enableStreaming = false;
  transport.rememberSessionAlias("ses_old", "ses_new", "test");

  transport.request = async (method, endpoint) => {
    if (method === "POST" && endpoint === "/session/ses_new/message") {
      return {
        info: {
          id: "a_new_1",
          role: "assistant",
          time: { created: 1001, completed: 1002 },
          finish: "stop",
        },
        parts: [{ type: "text", text: "aliased session ok" }],
      };
    }
    if (method === "GET" && endpoint === "/question") return [];
    throw new Error(`unexpected request: ${method} ${endpoint}`);
  };

  const result = await transport.sendMessage({
    sessionId: "ses_old",
    prompt: "hello",
  });

  assert.equal(result.messageId, "a_new_1");
  assert.equal(result.text, "aliased session ok");
  assert.equal(transport.resolveSessionAlias("ses_old"), "ses_new");
});

test("hasPendingQuestionsForSession should fallback directory in wsl mode", async () => {
  const transport = createTransport();
  transport.launchContext = {
    mode: "wsl",
    directory: "/home/me/.flownote-workspace",
    label: "wsl(sh)",
    distro: "Ubuntu",
    wslHome: "/home/me/.flownote-home",
    wslUserHome: "/home/me",
  };
  transport.getDefaultWslWorkspaceDir = () => "/home/me/.flownote-workspace";
  transport.resolveWslDirectory = (value) => String(value || "");
  transport.buildWslDirectoryCandidates = () => ["/home/me/.flownote-workspace"];

  transport.request = async (method, endpoint, _body, query) => {
    if (method === "GET" && endpoint === "/question") {
      if (query && query.directory === "/vault") return [];
      if (query && query.directory === "/home/me/.flownote-workspace") {
        return [{ id: "que_1", sessionID: "ses_1", questions: [{ id: "q1" }] }];
      }
      return [];
    }
    throw new Error(`unexpected request: ${method} ${endpoint}`);
  };

  const hasPending = await transport.hasPendingQuestionsForSession("ses_1");
  assert.equal(hasPending, true);
  assert.equal(transport.getSessionScopedDirectory("ses_1"), "/home/me/.flownote-workspace");
});

test("trySyncMessageRecovery should reuse placeholder parent message id", async () => {
  const transport = createTransport();
  const calls = [];
  transport.request = async (method, endpoint, body) => {
    calls.push({ method, endpoint, body });
    if (method === "GET" && endpoint === "/session/ses_1/message/msg_a") {
      return {
        info: { id: "msg_a", role: "assistant", parentID: "msg_u" },
        parts: [],
      };
    }
    if (method === "POST" && endpoint === "/session/ses_1/message") {
      return {
        info: { id: "msg_a", role: "assistant", parentID: "msg_u" },
        parts: [{ type: "text", text: "ok" }],
      };
    }
    throw new Error(`unexpected call: ${method} ${endpoint}`);
  };

  const recovered = await transport.trySyncMessageRecovery(
    "ses_1",
    { noReply: false, parts: [{ type: "text", text: "hello" }] },
    undefined,
    "msg_a",
  );

  assert.ok(recovered);
  assert.equal(recovered.messageId, "msg_a");
  assert.equal(recovered.text, "ok");
  assert.equal(calls.some((c) => c.method === "POST" && c.body && c.body.messageID === "msg_u"), true);
});

test("trySyncMessageRecovery should find latest user anchor from unbounded message list", async () => {
  const transport = createTransport();
  const calls = [];
  const oldUsers = Array.from({ length: 50 }, (_, idx) => ({
    info: { id: `u_old_${idx + 1}`, role: "user", time: { created: 100 + idx } },
    parts: [{ type: "text", text: `old-${idx + 1}` }],
  }));
  transport.request = async (method, endpoint, body, query) => {
    calls.push({ method, endpoint, body, query });
    if (method === "GET" && endpoint === "/session/ses_1/message") {
      if (query && Number(query.limit) === 50) {
        return {
          messages: oldUsers,
        };
      }
      return {
        messages: [
          ...oldUsers,
          {
            info: { id: "u_new", role: "user", time: { created: 200 } },
            parts: [{ type: "text", text: "new" }],
          },
        ],
      };
    }
    if (method === "POST" && endpoint === "/session/ses_1/message") {
      return {
        info: { id: "a_new", role: "assistant", parentID: body && body.messageID ? body.messageID : "" },
        parts: [{ type: "text", text: "ok-new" }],
      };
    }
    throw new Error(`unexpected call: ${method} ${endpoint}`);
  };

  const recovered = await transport.trySyncMessageRecovery(
    "ses_1",
    { noReply: false, parts: [{ type: "text", text: "hello" }] },
    undefined,
    "",
  );

  assert.ok(recovered);
  assert.equal(recovered.text, "ok-new");
  const postCall = calls.find((item) => item.method === "POST" && item.endpoint === "/session/ses_1/message");
  assert.ok(postCall);
  assert.equal(postCall.body && postCall.body.messageID, "u_new");
});

test("trySyncMessageRecovery should parse assistant from list-shaped sync response", async () => {
  const transport = createTransport();
  transport.request = async (method, endpoint) => {
    if (method === "POST" && endpoint === "/session/ses_1/message") {
      return {
        messages: [
          { info: { id: "u1", role: "user", time: { created: 100 } }, parts: [{ type: "text", text: "hello" }] },
          { info: { id: "a1", role: "assistant", parentID: "u1", time: { created: 101 } }, parts: [{ type: "text", text: "ok-list" }] },
        ],
      };
    }
    throw new Error(`unexpected call: ${method} ${endpoint}`);
  };

  const recovered = await transport.trySyncMessageRecovery(
    "ses_1",
    { noReply: false, parts: [{ type: "text", text: "hello" }], messageID: "u1" },
    undefined,
    "",
  );

  assert.ok(recovered);
  assert.equal(recovered.messageId, "a1");
  assert.equal(recovered.text, "ok-list");
});

test("isUnknownStatusFallbackText should detect unknown-status placeholder", () => {
  const transport = createTransport();
  assert.equal(transport.isUnknownStatusFallbackText("(无文本返回：session.status=unknown。...)"), true);
  assert.equal(transport.isUnknownStatusFallbackText("ok"), false);
});

test("sendMessage should use /message response as authoritative result in streaming mode", async () => {
  const transport = createTransport();
  transport.settings.enableStreaming = true;
  const tokenUpdates = [];

  transport.request = async (method, endpoint) => {
    if (method === "POST" && endpoint === "/session/ses_1/message") {
      return {
        info: {
          id: "msg_final",
          role: "assistant",
          sessionID: "ses_1",
          time: { created: 100, completed: 101 },
          finish: "stop",
        },
        parts: [{ type: "text", text: "authoritative-final" }],
      };
    }
    throw new Error(`unexpected request: ${method} ${endpoint}`);
  };
  transport.streamAssistantFromEvents = async () => ({
    messageId: "msg_stream",
    text: "partial-stream",
    reasoning: "",
    meta: "",
    blocks: [],
    completed: false,
  });

  const result = await transport.sendMessage({
    sessionId: "ses_1",
    prompt: "hello",
    onToken: (text) => tokenUpdates.push(String(text || "")),
  });

  assert.equal(result.text, "authoritative-final");
  assert.equal(result.messageId, "msg_final");
  assert.equal(tokenUpdates[tokenUpdates.length - 1], "authoritative-final");
});

test("sendMessage should fallback to sync recovery when authoritative response has no renderable payload", async () => {
  const transport = createTransport();
  transport.settings.enableStreaming = true;

  transport.request = async (method, endpoint) => {
    if (method === "POST" && endpoint === "/session/ses_1/message") {
      return {
        info: {
          id: "msg_empty",
          role: "assistant",
          sessionID: "ses_1",
          time: { created: 100, completed: 101 },
          finish: "stop",
        },
        parts: [],
      };
    }
    throw new Error(`unexpected request: ${method} ${endpoint}`);
  };
  transport.streamAssistantFromEvents = async () => null;
  transport.trySyncMessageRecovery = async () => ({
    messageId: "msg_recovered",
    text: "recovered",
    reasoning: "",
    meta: "",
    blocks: [],
    completed: true,
  });

  const result = await transport.sendMessage({
    sessionId: "ses_1",
    prompt: "hello",
  });

  assert.equal(result.text, "recovered");
  assert.equal(result.messageId, "msg_recovered");
});

test("sendMessage should fallback to polling stream callbacks when event stream is unavailable", async () => {
  const transport = createTransport();
  transport.settings.enableStreaming = true;
  const tokenUpdates = [];
  let pollingFallbackCalled = 0;

  transport.request = async (method, endpoint) => {
    if (method === "POST" && endpoint === "/session/ses_1/message") {
      return {
        info: {
          id: "msg_empty",
          role: "assistant",
          sessionID: "ses_1",
          time: { created: 100, completed: 101 },
          finish: "stop",
        },
        parts: [],
      };
    }
    throw new Error(`unexpected request: ${method} ${endpoint}`);
  };
  transport.streamAssistantFromEvents = async () => {
    throw new Error("sse unavailable");
  };
  transport.streamAssistantFromPolling = async (_sessionId, _startedAt, _signal, handlers) => {
    pollingFallbackCalled += 1;
    if (handlers && typeof handlers.onToken === "function") {
      handlers.onToken("po");
      handlers.onToken("polling");
    }
    return {
      messageId: "msg_poll",
      text: "polling",
      reasoning: "",
      meta: "",
      blocks: [],
      completed: true,
    };
  };
  transport.trySyncMessageRecovery = async () => null;

  const result = await transport.sendMessage({
    sessionId: "ses_1",
    prompt: "hello",
    onToken: (text) => tokenUpdates.push(String(text || "")),
  });

  assert.equal(pollingFallbackCalled, 1);
  assert.equal(result.text, "polling");
  assert.equal(result.messageId, "msg_poll");
  assert.equal(tokenUpdates.includes("po"), true);
  assert.equal(tokenUpdates.includes("polling"), true);
});

test("sendMessage should not fallback to polling when event stream is internally aborted after request", async () => {
  const transport = createTransport();
  transport.settings.enableStreaming = true;
  let pollingFallbackCalled = 0;

  transport.request = async (method, endpoint) => {
    if (method === "POST" && endpoint === "/session/ses_1/message") {
      return {
        info: {
          id: "msg_direct",
          role: "assistant",
          sessionID: "ses_1",
          time: { created: 100, completed: 101 },
          finish: "stop",
        },
        parts: [{ type: "text", text: "direct response" }],
      };
    }
    throw new Error(`unexpected request: ${method} ${endpoint}`);
  };
  transport.streamAssistantFromEvents = async (_sessionId, _startedAt, signal) =>
    new Promise((resolve, reject) => {
      if (signal && typeof signal.addEventListener === "function") {
        signal.addEventListener(
          "abort",
          () => reject(new Error("用户取消了请求")),
          { once: true },
        );
      } else {
        reject(new Error("用户取消了请求"));
      }
    });
  transport.streamAssistantFromPolling = async () => {
    pollingFallbackCalled += 1;
    return {
      messageId: "msg_poll_should_not_run",
      text: "polling",
      reasoning: "",
      meta: "",
      blocks: [],
      completed: true,
    };
  };
  transport.trySyncMessageRecovery = async () => null;

  const result = await transport.sendMessage({
    sessionId: "ses_1",
    prompt: "hello",
  });

  assert.equal(pollingFallbackCalled, 0);
  assert.equal(result.messageId, "msg_direct");
  assert.equal(result.text, "direct response");
});

test("sendMessage should recover from request timeout when streaming payload is complete", async () => {
  const transport = createTransport();
  transport.settings.enableStreaming = true;

  transport.request = async (method, endpoint) => {
    if (method === "POST" && endpoint === "/session/ses_1/message") {
      throw new Error("FLOWnote 连接失败: 请求超时 (120000ms)");
    }
    throw new Error(`unexpected request: ${method} ${endpoint}`);
  };
  transport.streamAssistantFromEvents = async () => ({
    messageId: "msg_stream_ok",
    text: "stream-complete",
    reasoning: "",
    meta: "",
    blocks: [],
    completed: true,
  });
  transport.trySyncMessageRecovery = async () => null;

  const result = await transport.sendMessage({
    sessionId: "ses_1",
    prompt: "hello",
  });

  assert.equal(result.text, "stream-complete");
  assert.equal(result.messageId, "msg_stream_ok");
});

test("sendMessage should reject response without completion signal", async () => {
  const transport = createTransport();
  transport.settings.enableStreaming = true;

  transport.request = async (method, endpoint) => {
    if (method === "POST" && endpoint === "/session/ses_1/message") {
      return {
        info: {
          id: "msg_a",
          role: "assistant",
          sessionID: "ses_1",
          time: { created: 100 },
        },
        parts: [{ type: "text", text: "partial-without-complete" }],
      };
    }
    throw new Error(`unexpected request: ${method} ${endpoint}`);
  };
  transport.streamAssistantFromEvents = async () => null;
  transport.trySyncMessageRecovery = async () => null;
  transport.getSessionStatus = async () => ({ type: "idle" });
  transport.fetchSessionMessages = async () => ({ list: [] });

  await assert.rejects(
    () =>
      transport.sendMessage({
        sessionId: "ses_1",
        prompt: "hello",
      }),
    /未收到明确完成信号/,
  );
});

test("sendMessage should not fail with idle empty payload when question request is pending", async () => {
  const transport = createTransport();
  transport.settings.enableStreaming = true;

  transport.request = async (method, endpoint) => {
    if (method === "POST" && endpoint === "/session/ses_1/message") {
      return {
        info: {
          id: "msg_q_wait",
          role: "assistant",
          sessionID: "ses_1",
          time: { created: 100 },
        },
        parts: [],
      };
    }
    if (method === "GET" && endpoint === "/question") {
      return [
        {
          id: "que_1",
          sessionID: "ses_1",
          questions: [{ question: "继续前请确认目标？", options: ["确认"] }],
        },
      ];
    }
    throw new Error(`unexpected request: ${method} ${endpoint}`);
  };
  transport.streamAssistantFromEvents = async () => null;
  transport.trySyncMessageRecovery = async () => null;
  transport.reconcileAssistantResponseQuick = async () => null;

  const result = await transport.sendMessage({
    sessionId: "ses_1",
    prompt: "hello",
  });

  assert.match(String(result.text || ""), /等待问题回答后继续生成/);
});

test("sendMessage should allow incomplete payload while question request is pending", async () => {
  const transport = createTransport();
  transport.settings.enableStreaming = true;

  transport.request = async (method, endpoint) => {
    if (method === "POST" && endpoint === "/session/ses_1/message") {
      return {
        info: {
          id: "msg_q_partial",
          role: "assistant",
          sessionID: "ses_1",
          time: { created: 100 },
        },
        parts: [
          { type: "text", text: "请先回答以下问题后继续。" },
        ],
      };
    }
    if (method === "GET" && endpoint === "/question") {
      return [
        {
          id: "que_2",
          sessionID: "ses_1",
          questions: [{ question: "你希望我重点优化什么？", options: ["架构", "性能"] }],
        },
      ];
    }
    throw new Error(`unexpected request: ${method} ${endpoint}`);
  };
  transport.streamAssistantFromEvents = async () => ({
    messageId: "msg_q_partial",
    text: "请先回答以下问题后继续。",
    reasoning: "",
    meta: "",
    blocks: [{ id: "tool_q_1", type: "tool", status: "running", title: "question", summary: "工具: question" }],
    completed: false,
  });
  transport.trySyncMessageRecovery = async () => null;

  const result = await transport.sendMessage({
    sessionId: "ses_1",
    prompt: "hello",
  });

  assert.equal(result.messageId, "msg_q_partial");
  assert.match(String(result.text || ""), /请先回答/);
});

test("sendMessage should retry quick reconcile before failing on idle empty response", async () => {
  const transport = createTransport();
  transport.settings.enableStreaming = true;

  transport.request = async (method, endpoint) => {
    if (method === "POST" && endpoint === "/session/ses_1/message") {
      return {
        info: {
          id: "msg_retry_empty",
          role: "assistant",
          sessionID: "ses_1",
          time: { created: 100 },
        },
        parts: [],
      };
    }
    if (method === "GET" && endpoint === "/question") {
      return [];
    }
    throw new Error(`unexpected request: ${method} ${endpoint}`);
  };
  transport.streamAssistantFromEvents = async () => null;
  transport.trySyncMessageRecovery = async () => null;
  transport.fetchSessionMessages = async () => ({ list: [] });
  transport.getSessionStatus = async () => ({ type: "idle" });

  let reconcileCalls = 0;
  transport.reconcileAssistantResponseQuick = async () => {
    reconcileCalls += 1;
    if (reconcileCalls < 2) return null;
    return {
      messageId: "msg_retry_done",
      text: "late finalized answer",
      reasoning: "",
      meta: "",
      blocks: [],
      completed: true,
    };
  };

  const result = await transport.sendMessage({
    sessionId: "ses_1",
    prompt: "hello",
  });

  assert.equal(result.messageId, "msg_retry_done");
  assert.equal(result.text, "late finalized answer");
  assert.equal(reconcileCalls >= 2, true);
});

test("sendMessage should auto-recreate stale session when idle and empty list persists", async () => {
  const transport = createTransport();
  transport.settings.enableStreaming = false;

  let createSessionCalls = 0;
  let postOldCalls = 0;
  let postNewCalls = 0;

  transport.request = async (method, endpoint) => {
    if (method === "GET" && endpoint === "/question") return [];

    if (method === "POST" && endpoint === "/session/ses_old/message") {
      postOldCalls += 1;
      return {
        info: {
          id: "msg_old_empty",
          role: "assistant",
          sessionID: "ses_old",
          time: { created: 100 },
        },
        parts: [],
      };
    }
    if (method === "POST" && endpoint === "/session") {
      createSessionCalls += 1;
      return { id: "ses_new", title: "Recovered session", time: { created: 200, updated: 200 } };
    }
    if (method === "POST" && endpoint === "/session/ses_new/message") {
      postNewCalls += 1;
      return {
        info: {
          id: "msg_new_ok",
          role: "assistant",
          sessionID: "ses_new",
          time: { created: 201, completed: 202 },
          finish: "stop",
        },
        parts: [{ type: "text", text: "recreated session response" }],
      };
    }
    if (method === "GET" && endpoint === "/session/status") {
      return { type: "idle" };
    }
    if (method === "GET" && endpoint === "/session/ses_old/message") {
      return { messages: [] };
    }
    if (method === "GET" && endpoint === "/session/ses_new/message") {
      return { messages: [] };
    }
    throw new Error(`unexpected request: ${method} ${endpoint}`);
  };
  transport.trySyncMessageRecovery = async () => null;
  transport.reconcileAssistantResponseQuick = async () => null;

  const result = await transport.sendMessage({
    sessionId: "ses_old",
    prompt: "hello",
  });

  assert.equal(createSessionCalls, 1);
  assert.equal(postOldCalls, 1);
  assert.equal(postNewCalls, 1);
  assert.equal(result.text, "recreated session response");
  assert.equal(transport.resolveSessionAlias("ses_old"), "ses_new");
});

test("reconcileAssistantResponseQuick should promote latest completed assistant message", async () => {
  const transport = createTransport();
  const startedAt = 1000;
  const current = {
    messageId: "msg_stream",
    text: "partial",
    reasoning: "",
    meta: "",
    blocks: [],
    completed: true,
  };

  transport.request = async (method, endpoint, _body, query) => {
    if (method === "GET" && endpoint === "/session/ses_1/message/msg_stream") {
      return {
        info: { id: "msg_stream", role: "assistant", time: { created: 1001, completed: 1002 } },
        parts: [{ type: "text", text: "partial" }],
      };
    }
    if (method === "GET" && endpoint === "/session/ses_1/message") {
      return {
        messages: [
          { info: { id: "u1", role: "user", time: { created: 1000 } }, parts: [{ type: "text", text: "hello" }] },
          { info: { id: "msg_stream", role: "assistant", time: { created: 1001, completed: 1002 } }, parts: [{ type: "text", text: "partial" }] },
          { info: { id: "msg_final", role: "assistant", time: { created: 1003, completed: 1010 } }, parts: [{ type: "text", text: "final from list" }] },
        ],
      };
    }
    throw new Error(`unexpected request: ${method} ${endpoint} ${JSON.stringify(query || {})}`);
  };

  const reconciled = await transport.reconcileAssistantResponseQuick(
    "ses_1",
    current,
    startedAt,
    undefined,
    "msg_stream",
  );

  assert.equal(reconciled.messageId, "msg_final");
  assert.equal(reconciled.text, "final from list");
  assert.equal(Boolean(reconciled.completed), true);
});

test("reconcileAssistantResponseQuick should recover latest assistant by user anchor when startedAt is skewed", async () => {
  const transport = createTransport();
  const startedAt = Date.now() + 10 * 60 * 1000;

  transport.request = async (method, endpoint, _body, query) => {
    if (method === "GET" && endpoint === "/session/ses_1/message") {
      if (!query || !Object.prototype.hasOwnProperty.call(query, "directory")) {
        throw new Error("directory query is required");
      }
      return {
        messages: [
          {
            info: { id: "u_old", role: "user", time: { created: 1000 } },
            parts: [{ type: "text", text: "old user" }],
          },
          {
            info: { id: "a_old", role: "assistant", parentID: "u_old", time: { created: 1001, completed: 1002 } },
            parts: [{ type: "text", text: "old answer" }],
          },
          {
            info: { id: "u_new", role: "user", time: { created: 2000 } },
            parts: [{ type: "text", text: "new user" }],
          },
          {
            info: { id: "a_new", role: "assistant", parentID: "u_new", time: { created: 2001, completed: 2002 } },
            parts: [{ type: "text", text: "anchored response" }],
          },
        ],
      };
    }
    throw new Error(`unexpected request: ${method} ${endpoint} ${JSON.stringify(query || {})}`);
  };

  const reconciled = await transport.reconcileAssistantResponseQuick(
    "ses_1",
    { messageId: "", text: "", reasoning: "", meta: "", blocks: [], completed: false },
    startedAt,
    undefined,
    "",
  );

  assert.equal(reconciled.messageId, "a_new");
  assert.equal(reconciled.text, "anchored response");
  assert.equal(Boolean(reconciled.completed), true);
});

test("sendMessage should surface list error when authoritative payload is empty", async () => {
  const transport = createTransport();
  transport.settings.enableStreaming = true;

  transport.request = async (method, endpoint) => {
    if (method === "POST" && endpoint === "/session/ses_1/message") {
      return {
        info: {
          id: "msg_empty",
          role: "assistant",
          sessionID: "ses_1",
          time: { created: 100, completed: 101 },
          finish: "stop",
        },
        parts: [],
      };
    }
    if (method === "GET" && endpoint === "/session/status") return { type: "idle" };
    if (method === "GET" && endpoint === "/session/ses_1/message") {
      return {
        items: [
          { info: { id: "u1", role: "user", time: { created: 1000 } }, parts: [{ type: "text", text: "hello" }] },
          {
            info: {
              id: "err_1",
              role: "system",
              time: { created: 1001 },
              error: "APIError status=401: Unauthorized: User not found.",
            },
            parts: [],
          },
        ],
      };
    }
    throw new Error(`unexpected request: ${method} ${endpoint}`);
  };
  transport.streamAssistantFromEvents = async () => null;
  transport.trySyncMessageRecovery = async () => null;

  await assert.rejects(
    () =>
      transport.sendMessage({
        sessionId: "ses_1",
        prompt: "hello",
      }),
    /模型返回错误：/,
  );
});

test("useWslDataHomeFallback should allocate isolated data home in WSL mode", () => {
  const transport = createTransport();
  transport.launchContext = {
    mode: "wsl",
    directory: "/home/me/.flownote-workspace",
    label: "wsl(sh)",
    distro: "Ubuntu",
    wslHome: "/home/me/.flownote-data",
    wslUserHome: "/home/me",
  };
  transport.getWslHomeDirectory = () => "/home/me";

  const changed = transport.useWslDataHomeFallback();
  assert.equal(changed, true);
  assert.match(transport.wslDataHomeOverride, /^\/home\/me\/\.flownote-data-/);
});

test("useWslDataHomeFallback should no-op outside WSL mode", () => {
  const transport = createTransport();
  transport.launchContext = {
    mode: "native",
    directory: "/vault",
    label: "native",
    distro: "",
    wslHome: "",
    wslUserHome: "",
  };
  const changed = transport.useWslDataHomeFallback();
  assert.equal(changed, false);
  assert.equal(transport.wslDataHomeOverride, "");
});
