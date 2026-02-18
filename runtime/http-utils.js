const http = require("http");
const https = require("https");

function nodeHttpRequestJson(url, method, body, timeoutMs, signal) {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === "https:";
  const client = isHttps ? https : http;

  const payload = body === undefined ? undefined : JSON.stringify(body);
  const headers = {
    accept: "application/json, text/plain, */*",
  };
  if (payload !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = Buffer.byteLength(payload);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      fn(value);
    };

    let onAbort = null;

    console.log(`[opencode-assistant] HTTP ${method} ${parsed.pathname}${parsed.search}`);
    const req = client.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          console.log(`[opencode-assistant] HTTP ${method} ${parsed.pathname} -> ${res.statusCode}`);
          finish(resolve, {
            status: Number(res.statusCode || 0),
            text,
          });
        });
      },
    );

    req.on("error", (err) => finish(reject, err));
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`请求超时 (${timeoutMs}ms)`));
    });

    if (signal) {
      onAbort = () => req.destroy(new Error("用户取消了请求"));
      if (signal.aborted) {
        req.destroy(new Error("用户取消了请求"));
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function nodeHttpRequestSse(url, timeoutMs, signal, handlers) {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === "https:";
  const client = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = "";

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      fn(value);
    };

    const consumeSseChunk = (chunk) => {
      const textChunk = String(chunk || "").replace(/\r/g, "");
      if (!textChunk) return;
      buffer += textChunk;

      let splitIndex = buffer.indexOf("\n\n");
      while (splitIndex >= 0) {
        const block = buffer.slice(0, splitIndex);
        buffer = buffer.slice(splitIndex + 2);
        splitIndex = buffer.indexOf("\n\n");

        if (!block.trim()) continue;
        const lines = block.split("\n");
        const dataLines = [];
        let eventName = "";
        let eventId = "";
        let retry = "";

        for (const line of lines) {
          if (line.startsWith("data:")) {
            dataLines.push(line.replace(/^data:\s*/, ""));
          } else if (line.startsWith("event:")) {
            eventName = line.replace(/^event:\s*/, "");
          } else if (line.startsWith("id:")) {
            eventId = line.replace(/^id:\s*/, "");
          } else if (line.startsWith("retry:")) {
            retry = line.replace(/^retry:\s*/, "");
          }
        }

        if (!dataLines.length) continue;
        const rawData = dataLines.join("\n");
        let payload = rawData;
        try {
          payload = JSON.parse(rawData);
        } catch {
          payload = rawData;
        }

        if (handlers && typeof handlers.onEvent === "function") {
          handlers.onEvent(payload, { event: eventName, id: eventId, retry });
        }

        if (handlers && typeof handlers.shouldStop === "function" && handlers.shouldStop()) {
          finish(resolve);
          req.destroy();
          return;
        }
      }
    };

    let onAbort = null;
    const req = client.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method: "GET",
        headers: {
          accept: "text/event-stream",
        },
      },
      (res) => {
        const status = Number(res.statusCode || 0);
        if (status < 200 || status >= 300) {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            finish(reject, new Error(`SSE 请求失败 (${status}): ${body}`));
          });
          return;
        }

        res.on("data", consumeSseChunk);
        res.on("end", () => finish(resolve));
        res.on("error", (err) => finish(reject, err));
      },
    );

    req.on("error", (err) => finish(reject, err));
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`SSE 超时 (${timeoutMs}ms)`)));

    if (signal) {
      onAbort = () => req.destroy(new Error("用户取消了请求"));
      if (signal.aborted) {
        req.destroy(new Error("用户取消了请求"));
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    req.end();
  });
}

function createLinkedAbortController(signal) {
  const controller = new AbortController();
  let off = () => {};

  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      const onAbort = () => controller.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      off = () => signal.removeEventListener("abort", onAbort);
    }
  }

  return { controller, detach: off };
}

module.exports = {
  nodeHttpRequestJson,
  nodeHttpRequestSse,
  createLinkedAbortController,
};
