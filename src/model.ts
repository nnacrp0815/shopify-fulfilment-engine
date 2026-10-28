import { z } from "zod";

const safeId = z
  .union([z.string().regex(/^\d+$/), z.number().int().positive().safe()])
  .transform(String);
const money = z
  .string()
  .regex(/^\d{1,10}(\.\d{1,2})?$/)
  .transform((v) => {
    const [whole, fraction = ""] = v.split(".");
    return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  });
const rawOrder = z.object({
  id: safeId,
  updated_at: z.iso.datetime({ offset: true }),
  financial_status: z.string(),
  cancelled_at: z.string().nullable().optional(),
  fulfillment_status: z.string().nullable().optional(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  current_subtotal_price: money,
  shipping_address: z
    .object({ country_code: z.string().regex(/^[A-Z]{2}$/) })
    .nullable()
    .optional(),
  note_attributes: z
    .array(z.object({ name: z.string(), value: z.string() }))
    .default([]),
  line_items: z
    .array(
      z.object({
        id: safeId,
        sku: z.string().nullable(),
        quantity: z.number().int().min(1).max(100000),
        fulfillable_quantity: z.number().int().min(0).max(100000),
        requires_shipping: z.boolean(),
      }),
    )
    .min(1)
    .max(500),
});

export type Order = {
  id: string;
  updatedAt: string;
  financialStatus: string;
  cancelled: boolean;
  fulfilled: boolean;
  currency: string;
  subtotalCents: number;
  country: string | null;
  method: string;
  pickupDate: string | null;
  pickupLocation: string | null;
  lines: {
    id: string;
    sku: string;
    quantity: number;
    requiresShipping: boolean;
  }[];
};

/** Strip customer names, emails, addresses, notes and all unrelated fields before persistence. */
export function normalizeOrder(input: unknown): Order {
  const raw = rawOrder.parse(input);
  if (new Set(raw.line_items.map((l) => l.id)).size !== raw.line_items.length)
    throw new Error("DUPLICATE_LINE_ID");
  if (raw.line_items.some((l) => l.fulfillable_quantity > l.quantity))
    throw new Error("INVALID_REMAINING_QUANTITY");
  const attributes = new Map<string, string>();
  for (const a of raw.note_attributes) {
    if (!["delivery_method", "pickup_date", "pickup_location"].includes(a.name))
      continue;
    if (attributes.has(a.name)) throw new Error("DUPLICATE_ATTRIBUTE");
    attributes.set(a.name, a.value);
  }
  return {
    id: raw.id,
    updatedAt: new Date(raw.updated_at).toISOString(),
    financialStatus: raw.financial_status,
    cancelled: Boolean(raw.cancelled_at),
    fulfilled: raw.fulfillment_status === "fulfilled",
    currency: raw.currency,
    subtotalCents: raw.current_subtotal_price,
    country: raw.shipping_address?.country_code ?? null,
    method: attributes.get("delivery_method") ?? "shipping",
    pickupDate: attributes.get("pickup_date") ?? null,
    pickupLocation: attributes.get("pickup_location") ?? null,
    lines: raw.line_items.map((l) => ({
      id: l.id,
      sku: l.sku ?? "",
      quantity: l.fulfillable_quantity,
      requiresShipping: l.requires_shipping,
    })),
  };
}

const stock = z.record(z.string().min(1), z.number().int().min(0).max(1000000));
export const rulesSchema = z
  .object({
    version: z.string().min(1),
    currency: z.string().regex(/^[A-Z]{3}$/),
    timezone: z.string().refine((v) => {
      try {
        new Intl.DateTimeFormat("en", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    }, "Invalid timezone"),
    allowedCountries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1),
    minimumSubtotalCents: z.number().int().nonnegative().safe(),
    maxOrderUnits: z.number().int().min(1).max(100000),
    allowSplitShipping: z.boolean(),
    pickupLocations: z.array(z.string().min(1)),
    catalog: z.record(
      z.string().min(1),
      z
        .object({ kind: z.enum(["shippable", "pickup-only", "digital"]) })
        .strict(),
    ),
    warehouses: z
      .array(
        z
          .object({
            id: z.string().min(1),
            priority: z.number().int(),
            countries: z.array(z.string()),
            stock,
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((r, ctx) => {
    const ids = r.warehouses.map((w) => w.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", message: "Duplicate warehouse id" });
    if (r.pickupLocations.some((id) => !ids.includes(id)))
      ctx.addIssue({ code: "custom", message: "Unknown pickup warehouse" });
    for (const w of r.warehouses)
      if (Object.keys(w.stock).some((sku) => !Object.hasOwn(r.catalog, sku)))
        ctx.addIssue({ code: "custom", message: "Unknown warehouse SKU" });
  });
export type Rules = z.infer<typeof rulesSchema>;
export type Task = {
  type: "warehouse-pick" | "prepare-pickup" | "digital-delivery";
  destination: string;
  lines: { id: string; sku: string; quantity: number }[];
};
export type Decision = {
  status: "routed" | "held" | "ignored";
  reasons: string[];
  tasks: Task[];
  rulesVersion: string;
};
