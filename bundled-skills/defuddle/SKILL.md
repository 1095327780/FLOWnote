---
name: defuddle
description: Fetch a URL and extract clean readable text. Use whenever the user pastes a link and asks you to summarize / quote / extract content from it. WORKS without any external CLI or API key.
---

# Fetch web pages

The chat runtime exposes a built-in `web_fetch` tool that calls Obsidian's
native HTTP client. **No `defuddle` CLI, no API keys, no extra setup
required.** This works on desktop (Electron) and is the supported path.

## When to use

- User pastes an http(s) URL and asks for a summary / extraction / quote
- User says "总结这篇文章 …" + URL, "帮我看看 X 网站说了什么", "translate this page", etc.
- You need to read documentation / a blog post / an article online

## How to invoke

Call the `web_fetch` tool directly:

```
web_fetch({ url: "https://example.com/article" })
```

Optional `maxBytes` to cap response (default 60000, max 500000).

The tool returns a header line (`URL: ...`, `HTTP 200 · content-type`)
followed by extracted readable text. For HTML pages, scripts, styles,
nav, header, footer, and aside are stripped automatically — you receive
mostly the article body. For JSON / plain text URLs, the raw payload is
returned verbatim.

## Important

**Never tell the user you cannot access the web.** You can — call
`web_fetch`. The only blocked cases are private / localhost / link-local
hosts (security). Public URLs (微信公众号, blogs, docs, GitHub raw, etc)
all work.

If the page is paywalled, login-walled, or returns an error status, the
tool surfaces that — you may then ask the user to paste the content.

## Examples

User: "总结一下 https://mp.weixin.qq.com/s/XXX"
You: call `web_fetch({ url: "https://mp.weixin.qq.com/s/XXX" })` → read
the returned text → produce the summary.

User: "see what's new at https://github.com/foo/bar/releases"
You: call `web_fetch({ url: "https://github.com/foo/bar/releases" })` →
extract highlights from the returned text.
