import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { normalizeOrder, type Rules } from "./model.js";
import { Store } from "./store.js";
import { verify, sign, tokenMatches } from "./security.js";
import { scenario, scenarioNames, type Scenario } from "./demo-data.js";

export type AppOptions = {
  store: Store;
  rules: Rules;
  shop: string;
  secrets: readonly string[];
  mode: "demo" | "service";
  adminToken: string;
  maxBodyBytes?: number;
};
const topics = new Set([
  "orders/create",
  "orders/paid",
  "orders/updated",
  "orders/cancelled",
]);
class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
const header = (req: IncomingMessage, name: string) =>
  typeof req.headers[name] === "string" ? req.headers[name] : "";
const cleanId = (v: string) => /^[A-Za-z0-9_-]{1,200}$/.test(v);

export function ingest(
  body: Buffer,
  headers: {
    shop: string;
    topic: string;
    deliveryId: string;
    eventId: string;
    signature: string;
  },
  options: AppOptions,
): { status: number; body: unknown } {
  if (!verify(body, headers.signature, options.secrets))
    throw new HttpError(401, "INVALID_SIGNATURE");
  if (headers.shop !== options.shop)
    throw new HttpError(403, "SHOP_NOT_ALLOWED");
  if (!topics.has(headers.topic)) throw new HttpError(400, "UNSUPPORTED_TOPIC");
  if (
    !cleanId(headers.deliveryId) ||
    (headers.eventId && !cleanId(headers.eventId))
  )
    throw new HttpError(400, "INVALID_EVENT_METADATA");
  let order;
  try {
    order = normalizeOrder(JSON.parse(body.toString("utf8")));
    if (headers.topic === "orders/cancelled" && !order.cancelled)
      throw new Error("INCONSISTENT_CANCELLATION");
  } catch {
    throw new HttpError(422, "INVALID_ORDER_PAYLOAD");
  }
  const state = options.store.enqueue({
    shop: headers.shop,
    topic: headers.topic,
    deliveryId: headers.deliveryId,
    eventId: headers.eventId,
    bodyHash: createHash("sha256").update(body).digest("hex"),
    order,
  });
  if (state === "conflict")
    throw new HttpError(409, "DELIVERY_PAYLOAD_CONFLICT");
  return { status: state === "accepted" ? 202 : 200, body: { status: state } };
}

async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk as Buffer);
    if (size > max) throw new HttpError(413, "BODY_TOO_LARGE");
    chunks.push(Buffer.from(chunk as Buffer));
  }
  return Buffer.concat(chunks);
}
function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export function createApp(options: AppOptions) {
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(options.shop))
    throw new Error("Invalid shop domain");
  if (!options.secrets.length || options.secrets.some((s) => !s))
    throw new Error("A webhook secret is required");
  if (options.mode === "service" && options.adminToken.length < 32)
    throw new Error("ADMIN_TOKEN must have at least 32 characters");
  const publicFiles = new Map([
    ["/", ["public/index.html", "text/html"]],
    ["/app.js", ["public/app.js", "text/javascript"]],
    ["/style.css", ["public/style.css", "text/css"]],
  ]);
  return createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader(
      "content-security-policy",
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    );
    try {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (req.method === "GET" && publicFiles.has(path)) {
        const [file, type] = publicFiles.get(path)!;
        res.writeHead(200, { "content-type": `${type}; charset=utf-8` });
        res.end(readFileSync(file!));
        return;
      }
      if (req.method === "GET" && path === "/healthz") {
        respond(res, options.store.healthy() ? 200 : 503, { status: "ok" });
        return;
      }
      if (req.method === "POST" && path === "/webhooks/orders") {
        if (!/^application\/json(?:\s*;|$)/i.test(header(req, "content-type")))
          throw new HttpError(415, "JSON_REQUIRED");
        const body = await readBody(req, options.maxBodyBytes ?? 1048576);
        const result = ingest(
          body,
          {
            shop: header(req, "x-shopify-shop-domain"),
            topic: header(req, "x-shopify-topic"),
            deliveryId: header(req, "x-shopify-webhook-id"),
            eventId: header(req, "x-shopify-event-id"),
            signature: header(req, "x-shopify-hmac-sha256"),
          },
          options,
        );
        respond(res, result.status, result.body);
        return;
      }
      if (path.startsWith("/api/")) {
        if (
          options.mode !== "demo" &&
          !tokenMatches(
            header(req, "authorization"),
            `Bearer ${options.adminToken}`,
          )
        )
          throw new HttpError(401, "ADMIN_AUTH_REQUIRED");
        if (req.method === "GET" && path === "/api/state") {
          respond(res, 200, {
            mode: options.mode,
            ...options.store.snapshot(),
          });
          return;
        }
        if (
          req.method === "POST" &&
          path.startsWith("/api/demo/") &&
          options.mode === "demo"
        ) {
          const name = path.slice("/api/demo/".length);
          if (!scenarioNames.includes(name as Scenario))
            throw new HttpError(404, "UNKNOWN_SCENARIO");
          const body = Buffer.from(JSON.stringify(scenario(name as Scenario)));
          const result = ingest(
            body,
            {
              shop: options.shop,
              topic: "orders/updated",
              deliveryId: randomUUID(),
              eventId: randomUUID(),
              signature: sign(body, options.secrets[0]!),
            },
            options,
          );
          respond(res, result.status, result.body);
          return;
        }
      }
      throw new HttpError(404, "NOT_FOUND");
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 503;
      respond(res, status, {
        error:
          error instanceof HttpError ? error.code : "TEMPORARILY_UNAVAILABLE",
      });
    }
  });
}
