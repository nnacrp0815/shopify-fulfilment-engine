import { z } from "zod";

export const API_VERSION = "2026-10";
export const READ_FULFILMENT_ORDER = `query ReadFulfilmentOrder($id: ID!) {
  fulfillmentOrder(id: $id) {
    id
    status
    requestStatus
    assignedLocation { location { id } }
    lineItems(first: 250) {
      nodes { id remainingQuantity lineItem { id sku } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
export const MOVE_FULFILMENT_ORDER = `mutation PlanFulfilmentOrderMove($id: ID!, $newLocationId: ID!, $lines: [FulfillmentOrderLineItemInput!]!) {
  fulfillmentOrderMove(id: $id, newLocationId: $newLocationId, fulfillmentOrderLineItems: $lines) {
    movedFulfillmentOrder { id status }
    userErrors { field message }
  }
}`;

const gid = (resource: string) =>
  z.string().regex(new RegExp(`^gid://shopify/${resource}/[1-9][0-9]*$`));
const snapshotSchema = z.object({
  id: gid("FulfillmentOrder"),
  status: z.string(),
  requestStatus: z.string(),
  assignedLocation: z.object({
    location: z.object({ id: gid("Location") }).nullable(),
  }),
  lineItems: z.object({
    nodes: z.array(
      z.object({
        id: gid("FulfillmentOrderLineItem"),
        remainingQuantity: z.number().int().nonnegative(),
        lineItem: z.object({ id: gid("LineItem"), sku: z.string().nullable() }),
      }),
    ),
    pageInfo: z.object({
      hasNextPage: z.boolean(),
      endCursor: z.string().nullable(),
    }),
  }),
});
export type FulfilmentSnapshot = z.infer<typeof snapshotSchema>;

/** Optional read-only integration. Access tokens stay in memory; errors contain no body or credentials. */
export class ShopifyReader {
  constructor(
    private readonly shop: string,
    private readonly token: string,
    private readonly transport: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) || !token)
      throw new Error("INVALID_SHOPIFY_CONFIGURATION");
  }
  async readFulfilmentOrder(id: string): Promise<FulfilmentSnapshot> {
    gid("FulfillmentOrder").parse(id);
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try {
        response = await this.transport(
          `https://${this.shop}/admin/api/${API_VERSION}/graphql.json`,
          {
            method: "POST",
            redirect: "error",
            headers: {
              "content-type": "application/json",
              "x-shopify-access-token": this.token,
            },
            body: JSON.stringify({
              query: READ_FULFILMENT_ORDER,
              variables: { id },
            }),
            signal: AbortSignal.timeout(5000),
          },
        );
      } catch {
        if (attempt === 2) throw new Error("SHOPIFY_NETWORK_ERROR");
        await this.sleep(250 * 2 ** attempt);
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt === 2) throw new Error("SHOPIFY_RETRIES_EXHAUSTED");
        const retry = Number(response.headers.get("retry-after"));
        await response.body?.cancel();
        await this.sleep(
          Math.min(
            5000,
            Math.max(
              250 * 2 ** attempt,
              Number.isFinite(retry) ? retry * 1000 : 0,
            ),
          ),
        );
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("SHOPIFY_HTTP_ERROR");
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new Error("SHOPIFY_INVALID_RESPONSE");
      }
      const envelope = z
        .object({
          data: z
            .object({ fulfillmentOrder: snapshotSchema.nullable() })
            .nullish(),
          errors: z
            .array(
              z.object({
                extensions: z
                  .object({ code: z.string().optional() })
                  .optional(),
              }),
            )
            .optional(),
        })
        .safeParse(body);
      if (!envelope.success) throw new Error("SHOPIFY_INVALID_RESPONSE");
      if (envelope.data.errors?.length) {
        if (
          envelope.data.errors.every(
            (e) => e.extensions?.code === "THROTTLED",
          ) &&
          attempt < 2
        ) {
          await this.sleep(250 * 2 ** attempt);
          continue;
        }
        throw new Error("SHOPIFY_GRAPHQL_ERROR");
      }
      const snapshot = envelope.data.data?.fulfillmentOrder;
      if (!snapshot) throw new Error("FULFILMENT_ORDER_NOT_FOUND");
      if (snapshot.lineItems.pageInfo.hasNextPage)
        throw new Error("PAGINATION_REQUIRED");
      return snapshot;
    }
    throw new Error("SHOPIFY_RETRIES_EXHAUSTED");
  }
}

/** Build a schema-valid proposal only. There is deliberately no mutation transport in this MVP. */
export function buildMoveProposal(
  snapshot: FulfilmentSnapshot,
  locationId: string,
  lines: { id: string; quantity: number }[],
) {
  snapshot = snapshotSchema.parse(snapshot);
  gid("Location").parse(locationId);
  if (
    snapshot.status !== "OPEN" ||
    !["UNSUBMITTED", "REJECTED", "CANCELLATION_ACCEPTED"].includes(
      snapshot.requestStatus,
    )
  )
    throw new Error("FULFILMENT_ORDER_NOT_MOVABLE");
  if (snapshot.lineItems.pageInfo.hasNextPage)
    throw new Error("PAGINATION_REQUIRED");
  if (!lines.length || new Set(lines.map((l) => l.id)).size !== lines.length)
    throw new Error("INVALID_MOVE_LINES");
  for (const line of lines) {
    gid("FulfillmentOrderLineItem").parse(line.id);
    const current = snapshot.lineItems.nodes.find((l) => l.id === line.id);
    if (
      !current ||
      !Number.isSafeInteger(line.quantity) ||
      line.quantity < 1 ||
      line.quantity > current.remainingQuantity
    )
      throw new Error("INVALID_MOVE_QUANTITY");
  }
  return {
    mode: "proposal" as const,
    apiVersion: API_VERSION,
    query: MOVE_FULFILMENT_ORDER,
    variables: { id: snapshot.id, newLocationId: locationId, lines },
  };
}
