// src/index.ts
// —————— 动态 require Polyfill ——————
declare global { var require: any; }
globalThis.require = (module: string) => {
  if (module === "fs" || module === "path") {
    return {};      // 屏蔽掉对 fs 和 path 的实际调用
  }
  throw new Error(`Module not found: ${module}`);
};
// —————————————————————————————————————

// 然后才是原来的 XHR polyfill、Kuroshiro 逻辑……
import Kuroshiro from "kuroshiro";
import KuromojiAnalyzer from "@sglkc/kuroshiro-analyzer-kuromoji";

const allowedOrigin = "https://sotsuken-odai.pages.dev";

function getCorsHeaders(origin: string | null): Record<string, string> {
  if (origin !== allowedOrigin) return {};
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function withCors(response: Response, origin: string | null): Response {
  const headers = new Headers(response.headers);
  const corsHeaders = getCorsHeaders(origin);
  for (const [key, value] of Object.entries(corsHeaders)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

// --------- XHR Polyfill for Cloudflare Workers ---------
declare global { var XMLHttpRequest: any; }
globalThis.XMLHttpRequest = class {
  private _method!: string;
  private _url!: string;
private _headers: Record<string,string> = {};
  public status!: number;
  public response!: ArrayBuffer;
  public responseType = "";
  public onload: (() => void) | null = null;
  public onerror: ((err: any) => void) | null = null;

  open(method: string, url: string) {
    this._method = method;
    this._url = url;
  }
  setRequestHeader(name: string, value: string) {
    this._headers[name] = value;
  }
  async send() {
    try {
      const res = await fetch(this._url, {
        method: this._method,
        headers: this._headers,
      });
      this.status = res.status;
      this.response = await res.arrayBuffer();
      if (this.onload) this.onload();
    } catch (e) {
      if (this.onerror) this.onerror(e);
    }
  }
  get responseText() {
    return new TextDecoder().decode(new Uint8Array(this.response));
  }
};
// ----------------------------------------------------------

let kuro: Kuroshiro | null = null;
async function ensureInitialized() {
  if (!kuro) {
    kuro = new Kuroshiro();
    await kuro.init(new KuromojiAnalyzer({
      dictPath: "https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/"
    }));
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      if (origin !== allowedOrigin) {
        return new Response("Forbidden", { status: 403 });
      }
      return new Response(null, {
        status: 204,
        headers: getCorsHeaders(origin)
      });
    }

    // 1) GET / → 随机 UUID
    if (request.method === "GET" && url.pathname === "/") {
      return withCors(new Response(JSON.stringify({ uuid: crypto.randomUUID() }), {
        headers: { "Content-Type": "application/json" }
      }), origin);
    }

    // 2) POST /v1/chat/completions → OpenAI Chat Completions (支持流式 + 合并 model/mode)
    if (url.pathname === "/v1/chat/completions") {
      if (request.method !== "POST") {
        return withCors(new Response(JSON.stringify({
          error: "Method Not Allowed",
          message: "Use POST on /v1/chat/completions"
        }), { status: 405, headers: { "Content-Type": "application/json" } }), origin);
      }

      let body: any;
      try {
        body = await request.json();
      } catch {
        return withCors(new Response(JSON.stringify({ error: "Invalid JSON body" }), {
          status: 400, headers: { "Content-Type": "application/json" }
        }), origin);
      }

      // 验证 messages
      const messages = body.messages;
      if (!Array.isArray(messages) || messages.length === 0) {
        return withCors(new Response(JSON.stringify({
          error: "Invalid format",
          message: "`messages` must be a non-empty array"
        }), { status: 400, headers: { "Content-Type": "application/json" } }), origin);
      }
      const last = messages[messages.length - 1];
      if (last.role !== "user" || typeof last.content !== "string") {
        return withCors(new Response(JSON.stringify({
          error: "Invalid message",
          message: "Last message must be { role: 'user', content: string }"
        }), { status: 400, headers: { "Content-Type": "application/json" } }), origin);
      }
      const prompt = last.content;

      // 合并解析 model 和 mode
      let to: string;
      let mode: string;
      if (typeof body.model === "string" && body.model.includes("-")) {
        const parts = body.model.split("-");
        const validTo = ["hiragana","katakana","romaji"];
        const validMode = ["normal","spaced","okurigana","furigana"];
        if (parts.length === 2 && validTo.includes(parts[0]) && validMode.includes(parts[1])) {
          to = parts[0];
          mode = parts[1];
        } else {
          // fallback
          to = validTo.includes(parts[0]) ? parts[0] : "hiragana";
          mode = validMode.includes(parts[1]) ? parts[1] : "normal";
        }
      } else {
        to = ["hiragana","katakana","romaji"].includes(body.model)
          ? body.model : "hiragana";
        mode = ["normal","spaced","okurigana","furigana"].includes(body.mode)
          ? body.mode : "normal";
      }
      const stream = body.stream === true;

      // 初始化
      try {
        await ensureInitialized();
      } catch (e: any) {
        return withCors(new Response(JSON.stringify({
          error: "Initialization failed",
          detail: e.toString()
        }), { status: 500, headers: { "Content-Type": "application/json" } }), origin);
      }

      // 转换
      let converted: string;
      try {
        converted = await kuro!.convert(prompt, { to, mode });
      } catch (e: any) {
        return withCors(new Response(JSON.stringify({
          error: "Conversion failed",
          detail: e.toString()
        }), { status: 500, headers: { "Content-Type": "application/json" } }), origin);
      }

      // 非流式响应
      if (!stream) {
        const responseBody = {
          id: `chatcmpl-${crypto.randomUUID()}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: body.model || to,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: converted },
              finish_reason: "stop"
            }
          ],
          usage: {
            prompt_tokens: prompt.length,
            completion_tokens: converted.length,
            total_tokens: prompt.length + converted.length
          }
        };
        return withCors(new Response(JSON.stringify(responseBody), {
          headers: { "Content-Type": "application/json" }
        }), origin);
      }

      // 流式响应（SSE）
      const encoder = new TextEncoder();
      const streamBody = new ReadableStream({
        async start(controller) {
          for (const ch of converted) {
            const chunk = {
              id: `chatcmpl-${crypto.randomUUID()}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: body.model || to,
              choices: [
                {
                  delta: { content: ch },
                  index: 0,
                  finish_reason: null
                }
              ]
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            await new Promise(r => setTimeout(r, 10));
          }
          const done = { choices: [{ delta: {}, index: 0, finish_reason: "stop" }] };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(done)}\n\n`));
          controller.close();
        }
      });
      return withCors(new Response(streamBody, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive"
        }
      }), origin);
    }

    // 3) POST / → 原始简单接口
    if (request.method === "POST" && url.pathname === "/") {
      let payload: any;
      try {
        payload = await request.json();
      } catch {
        return withCors(new Response(JSON.stringify({ error: "Invalid JSON body" }), {
          status: 400, headers: { "Content-Type": "application/json" }
        }), origin);
      }
      const { text, to = "hiragana", mode = "normal" } = payload;
      if (typeof text !== "string") {
        return withCors(new Response(JSON.stringify({ error: "`text` must be a string" }), {
          status: 400, headers: { "Content-Type": "application/json" }
        }), origin);
      }
      try { await ensureInitialized(); } catch (e: any) {
        return withCors(new Response(JSON.stringify({ error: "Initialization failed", detail: e.toString() }), {
          status: 500, headers: { "Content-Type": "application/json" }
        }), origin);
      }
      try {
        const converted = await kuro!.convert(text, { to, mode });
        return withCors(new Response(JSON.stringify({ converted }), {
          headers: { "Content-Type": "application/json" }
        }), origin);
      } catch (e: any) {
        return withCors(new Response(JSON.stringify({ error: "Conversion failed", detail: e.toString() }), {
          status: 500, headers: { "Content-Type": "application/json" }
        }), origin);
      }
    }

    // fallback 404
    return withCors(new Response(JSON.stringify({
      error: "Not Found",
      message: "Supported: GET /, POST /, POST /v1/chat/completions"
    }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    }), origin);
  }
};
