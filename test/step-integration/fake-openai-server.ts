/**
 * fake-openai-server.ts — a scriptable OpenAI Chat Completions stub (a real
 * `pi` process talking to a fake model over HTTP).
 *
 * Pi↔stub contract (reverse-engineered from pi-ai's openai-completions.js;
 * see README.md for the full list): every request is
 * `POST {baseUrl}/chat/completions` with `stream: true`, answered with SSE
 * frames then `data: [DONE]`; the last choice REQUIRES a terminal
 * `finish_reason` (`stop`/`tool_calls`); the final chunk SHOULD carry a
 * `usage` payload (counts here are fabricated, only the shape is real); auth
 * is `Bearer <apiKey>`, enforced only when started with `expectedApiKey`.
 * Routes on method + exact path (query stripped), so each test owns its queue
 * under its own prefix. Localhost-only.
 *
 * Per-route FIFO queues: one request consumes exactly one reply, in order;
 * resolution is queue → route default → constructor `defaultReply`. A reply
 * may carry `delayMs` or `hold: "until-released"`, keeping its request in
 * flight. When all three are missing the test under-enqueued (a test bug):
 * the stub destroys the socket with no HTTP response and throws, crashing the
 * test — an empty queue must be impossible to mistake for a server response.
 */

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { isRecord } from "../../src/predicates.js";

/** One chat message as pi sends it (only the fields the stub reads). */
export interface StubChatMessage {
  role: string;
  content: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
}

/**
 * The request-body subset the stub decodes; extras are ignored but kept on
 * `RecordedRequest.rawBody` for assertions.
 */
export interface ChatCompletionsRequest {
  model: string;
  messages: StubChatMessage[];
  stream: boolean;
}

/**
 * A reply held before writing, leaving its request in flight for `delayMs` or
 * until `release` — the shape a test that acts mid-inference needs.
 */
type ReplyHold =
  | {
      /** Park this reply until `FakeOpenAI.release` is called. */
      hold: "until-released";
      delayMs?: never;
    }
  | {
      /** Hold this reply for this many milliseconds before writing it. */
      delayMs?: number;
      hold?: never;
    };

type TextReply = ReplyHold & {
  kind: "text";
  text: string;
};

interface ScriptedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * A reply emitting tool calls (optionally preceded by text). Multi-turn
 * sequences are ordered `enqueue` calls: one entry per model turn.
 */
type ToolCallReply = ReplyHold & {
  kind: "tool-call";
  text: string;
  calls: ScriptedToolCall[];
};

type StubReply = TextReply | ToolCallReply | ErrorReply;

/**
 * A reply that FAILS the request: `message`/`code` ride in the body's `error`
 * object, where pi's OpenAI client reads them. Status decides retries — the
 * client retries 408/409/429/5xx, so a 4xx is the terminator.
 */
type ErrorReply = ReplyHold & {
  kind: "error";
  status: number;
  message: string;
  code: string;
};

/** One stubbed route: HTTP method plus exact path, query string stripped. */
interface StubRoute {
  method: string;
  path: string;
}

interface RouteReply extends StubRoute {
  reply: StubReply;
}

/** Filter for `requests()`: method is required, path narrows to one route. */
interface RequestFilter {
  method: string;
  path?: string;
}

/** One request the stub has served, kept for post-run assertions. */
interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: ChatCompletionsRequest;
  /** The full parsed JSON body, for assertions on fields outside the subset. */
  rawBody: unknown;
}

interface StartFakeOpenAIOptions {
  /** When set, a non-matching `Authorization` header gets a 401. */
  expectedApiKey?: string;
  /** Model ids advertised by `GET {baseUrl}/models`. Defaults to []. */
  models?: string[];
  /** Server-wide fallback; when unset, an empty queue crashes the test process. */
  defaultReply?: StubReply;
}

export interface FakeOpenAI {
  /** Base URL to put in models.json, e.g. `http://127.0.0.1:54321/v1`. */
  readonly baseUrl: string;
  /** Server origin without any path, e.g. `http://127.0.0.1:54321`. */
  readonly origin: string;
  readonly port: number;
  /** Append a reply to a route's FIFO queue; routes are created implicitly. */
  enqueue(route: RouteReply): void;
  /** Set a route's default reply, served when its queue is empty. */
  on(route: RouteReply): void;
  /** Recorded requests matching the filter, in arrival order. */
  requests(filter: RequestFilter): readonly RecordedRequest[];
  /**
   * Recorded requests whose reply is not yet written, in arrival order — how a
   * test asserts an inference was still in flight, by construction not timing.
   * A disconnect drops the hold unwritten and removes the request.
   */
  pendingRequests(filter: RequestFilter): readonly RecordedRequest[];
  /** Release the first parked reply on the route; returns 1, else 0. */
  release(filter: RequestFilter & { path: string }): number;
  /** Clear queues, route defaults, and recordings. */
  reset(): void;
  close(): Promise<void>;
}

export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (
      typeof part === "object" &&
      part !== null &&
      (part as { type?: unknown }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      parts.push((part as { text: string }).text);
    }
  }
  return parts.join("");
}

export function lastUserText(request: ChatCompletionsRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const message = request.messages[i];
    if (message.role === "user") return messageText(message.content);
  }
  return "";
}

function isStubChatMessage(value: unknown): value is StubChatMessage {
  return isRecord(value) && typeof value["role"] === "string";
}

function asChatCompletionsRequest(
  body: unknown,
): ChatCompletionsRequest | null {
  if (!isRecord(body)) return null;
  if (typeof body["model"] !== "string") return null;
  if (!Array.isArray(body["messages"])) return null;
  const messages: StubChatMessage[] = [];
  for (const message of body["messages"]) {
    if (!isStubChatMessage(message)) return null;
    messages.push({
      role: message.role,
      content: message.content,
      tool_calls: message.tool_calls,
      tool_call_id: message.tool_call_id,
    });
  }
  return {
    model: body["model"],
    messages,
    stream: body["stream"] === true,
  };
}

function routeKey(method: string, path: string): string {
  const queryIndex = path.indexOf("?");
  const cleanPath = queryIndex === -1 ? path : path.slice(0, queryIndex);
  return `${method.toUpperCase()} ${cleanPath}`;
}

interface RouteState {
  queue: StubReply[];
  defaultReply: StubReply | undefined;
}

interface HeldRequest {
  entry: RecordedRequest;
  request: ChatCompletionsRequest;
  reply: StubReply;
  res: import("node:http").ServerResponse;
  timer: ReturnType<typeof setTimeout> | undefined;
  onClose: () => void;
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw) as unknown);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    request.on("error", reject);
  });
}

/** Fabricated usage counts (chars/4, min 1); only the shape is real. */
function fakeTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

interface SseWriter {
  chunk(payload: unknown): void;
  done(): void;
}

function openSse(
  res: import("node:http").ServerResponse,
  requestModel: string,
): SseWriter {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const frame = (delta: unknown, finishReason: string | null): void => {
    const payload = {
      id: "chatcmpl-fake",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: requestModel,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  return {
    chunk: (delta: unknown) => frame(delta, null),
    done: () => {
      res.write("data: [DONE]\n\n");
      res.end();
    },
  };
}

function streamTextReply(
  res: import("node:http").ServerResponse,
  request: ChatCompletionsRequest,
  text: string,
): void {
  const sse = openSse(res, request.model);
  const midpoint = Math.ceil(text.length / 2);
  sse.chunk({ role: "assistant", content: text.slice(0, midpoint) });
  sse.chunk({ content: text.slice(midpoint) });
  const promptTokens = fakeTokens(JSON.stringify(request.messages));
  const completionTokens = fakeTokens(text);
  const terminal = {
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: request.model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
  res.write(`data: ${JSON.stringify(terminal)}\n\n`);
  sse.done();
}

function streamToolCallReply(
  res: import("node:http").ServerResponse,
  request: ChatCompletionsRequest,
  reply: ToolCallReply,
): void {
  const sse = openSse(res, request.model);
  if (reply.text.length > 0) {
    sse.chunk({ role: "assistant", content: reply.text });
  } else {
    sse.chunk({ role: "assistant" });
  }
  reply.calls.forEach((call, index) => {
    const args = JSON.stringify(call.arguments);
    const midpoint = Math.ceil(args.length / 2);
    sse.chunk({
      tool_calls: [
        {
          index,
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: args.slice(0, midpoint) },
        },
      ],
    });
    sse.chunk({
      tool_calls: [
        {
          index,
          function: { arguments: args.slice(midpoint) },
        },
      ],
    });
  });
  const promptTokens = fakeTokens(JSON.stringify(request.messages));
  const completionTokens = fakeTokens(
    reply.text + JSON.stringify(reply.calls.map((call) => call.arguments)),
  );
  const terminal = {
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: request.model,
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
  res.write(`data: ${JSON.stringify(terminal)}\n\n`);
  sse.done();
}

function writeReply(
  res: import("node:http").ServerResponse,
  request: ChatCompletionsRequest,
  reply: StubReply,
): void {
  // A failing reply skips the stream machinery: the turn ends as a provider error.
  if (reply.kind === "error") {
    jsonError(res, reply.status, reply.message, reply.code);
    return;
  }
  if (!request.stream) {
    jsonReply(res, request, reply);
    return;
  }
  if (reply.kind === "text") {
    streamTextReply(res, request, reply.text);
  } else {
    streamToolCallReply(res, request, reply);
  }
}

/** Non-streaming JSON response (pi never sends `stream: false`; for direct-fetch debugging). */
function jsonReply(
  res: import("node:http").ServerResponse,
  request: ChatCompletionsRequest,
  reply: TextReply | ToolCallReply,
): void {
  const text = reply.kind === "text" ? reply.text : reply.text;
  const toolCalls =
    reply.kind === "tool-call"
      ? reply.calls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        }))
      : undefined;
  const promptTokens = fakeTokens(JSON.stringify(request.messages));
  const completionTokens = fakeTokens(text);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      id: "chatcmpl-fake",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: text,
            ...(toolCalls !== undefined ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: toolCalls !== undefined ? "tool_calls" : "stop",
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    }),
  );
}

function jsonError(
  res: import("node:http").ServerResponse,
  status: number,
  message: string,
  code: string,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      error: { message, type: "invalid_request_error", code },
    }),
  );
}

export function startFakeOpenAI(
  options: StartFakeOpenAIOptions = {},
): Promise<FakeOpenAI> {
  const recorded: RecordedRequest[] = [];
  // Recorded but not yet answered; a disconnect or the under-enqueue crash
  // removes the request with no write ever reaching it.
  const pending = new Set<RecordedRequest>();
  const heldRequests = new Set<HeldRequest>();
  const routes = new Map<string, RouteState>();
  const serverDefault = options.defaultReply;
  const models = options.models ?? [];
  const expectedAuth =
    options.expectedApiKey === undefined
      ? null
      : `Bearer ${options.expectedApiKey}`;

  const server: Server = createServer((request, res) => {
    void (async () => {
      const url = request.url ?? "/";
      const path = url.split("?", 2)[0];

      if (request.method === "GET" && path.endsWith("/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: models.map((id) => ({
              id,
              object: "model",
              created: Math.floor(Date.now() / 1000),
              owned_by: "fake-openai-stub",
            })),
          }),
        );
        return;
      }

      if (request.method !== "POST" || !path.endsWith("/chat/completions")) {
        jsonError(
          res,
          404,
          `no stub route for ${request.method} ${path}`,
          "not_found",
        );
        return;
      }

      if (
        expectedAuth !== null &&
        request.headers.authorization !== expectedAuth
      ) {
        jsonError(res, 401, "Incorrect API key provided", "invalid_api_key");
        return;
      }

      let rawBody: unknown;
      try {
        rawBody = await readJsonBody(request);
      } catch {
        jsonError(res, 400, "Invalid JSON body", "invalid_json");
        return;
      }
      const body = asChatCompletionsRequest(rawBody);
      if (body === null) {
        jsonError(
          res,
          400,
          "Body is not a chat-completions request",
          "invalid_request",
        );
        return;
      }
      const entry: RecordedRequest = {
        method: request.method,
        path,
        authorization: request.headers.authorization,
        body,
        rawBody,
      };
      recorded.push(entry);
      pending.add(entry);

      const key = routeKey(request.method, path);
      const state = routes.get(key);
      const reply =
        state?.queue.shift() ?? state?.defaultReply ?? serverDefault;
      if (reply === undefined) {
        // Test bug: out of replies. Never send an HTTP response — even a 500 is
        // indistinguishable from a real one — so destroy the socket and crash loudly.
        pending.delete(entry);
        request.socket.destroy();
        const missing = new Error(
          `fake-openai stub: no enqueued reply for ${request.method} ${path} ` +
            `(queue empty, no route default, no server default — the test ` +
            `under-enqueued; script one with ` +
            `server.enqueue({ method, path, reply }))`,
        );
        setImmediate(() => {
          throw missing;
        });
        return;
      }
      // A held reply writes nothing until its timer fires or the test releases
      // it; every hold dies with the connection, never writing to a dead socket.
      const delayMs = reply.delayMs ?? 0;
      if (delayMs <= 0 && reply.hold !== "until-released") {
        pending.delete(entry);
        writeReply(res, body, reply);
        return;
      }
      const held: HeldRequest = {
        entry,
        request: body,
        reply,
        res,
        timer: undefined,
        onClose: () => {
          if (held.timer !== undefined) clearTimeout(held.timer);
          heldRequests.delete(held);
          pending.delete(entry);
        },
      };
      heldRequests.add(held);
      res.once("close", held.onClose);
      const writeHeldReply = (): void => {
        if (res.destroyed || res.writableEnded) {
          held.onClose();
          return;
        }
        res.removeListener("close", held.onClose);
        heldRequests.delete(held);
        pending.delete(entry);
        writeReply(res, body, reply);
      };
      if (reply.hold !== "until-released") {
        held.timer = setTimeout(writeHeldReply, delayMs);
      }
    })().catch(() => {
      if (!res.headersSent) {
        jsonError(res, 500, "Stub handler failed", "stub_error");
      } else {
        res.end();
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      const origin = `http://127.0.0.1:${address.port}`;
      const getOrCreate = (route: StubRoute): RouteState => {
        const key = routeKey(route.method, route.path);
        const existing = routes.get(key);
        if (existing !== undefined) return existing;
        const created: RouteState = { queue: [], defaultReply: undefined };
        routes.set(key, created);
        return created;
      };
      resolve({
        baseUrl: `${origin}/v1`,
        origin,
        port: address.port,
        enqueue: (route: RouteReply) => {
          getOrCreate(route).queue.push(route.reply);
        },
        on: (route: RouteReply) => {
          getOrCreate(route).defaultReply = route.reply;
        },
        requests: (filter: RequestFilter) => {
          const method = filter.method.toUpperCase();
          return recorded.filter(
            (entry) =>
              entry.method.toUpperCase() === method &&
              (filter.path === undefined || entry.path === filter.path),
          );
        },
        pendingRequests: (filter: RequestFilter) => {
          const method = filter.method.toUpperCase();
          return recorded.filter(
            (entry) =>
              entry.method.toUpperCase() === method &&
              (filter.path === undefined || entry.path === filter.path) &&
              pending.has(entry),
          );
        },
        release: (filter: { method: string; path: string }) => {
          const key = routeKey(filter.method, filter.path);
          const held = [...heldRequests].find(
            (candidate) =>
              candidate.reply.hold === "until-released" &&
              routeKey(candidate.entry.method, candidate.entry.path) === key,
          );
          if (held === undefined) return 0;
          held.timer = undefined;
          held.res.removeListener("close", held.onClose);
          heldRequests.delete(held);
          pending.delete(held.entry);
          if (!held.res.destroyed && !held.res.writableEnded) {
            writeReply(held.res, held.request, held.reply);
          }
          return 1;
        },
        reset: () => {
          for (const held of heldRequests) {
            if (held.timer !== undefined) clearTimeout(held.timer);
            held.res.removeListener("close", held.onClose);
            if (!held.res.destroyed && !held.res.writableEnded)
              held.res.destroy();
          }
          heldRequests.clear();
          routes.clear();
          recorded.length = 0;
          pending.clear();
        },
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            for (const held of heldRequests) {
              if (held.timer !== undefined) clearTimeout(held.timer);
              held.res.removeListener("close", held.onClose);
              if (!held.res.destroyed && !held.res.writableEnded)
                held.res.destroy();
            }
            heldRequests.clear();
            pending.clear();
            server.close((error) => {
              if (error) rejectClose(error);
              else resolveClose();
            });
          }),
      });
    });
  });
}
