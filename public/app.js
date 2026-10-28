/* The client preview uses the shared routing engine. Service data is requested only on connection. */
const $ = (selector) => document.querySelector(selector);
const make = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const icon = (name, className) => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  if (className) svg.setAttribute("class", className);
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
};
const examples = {
  "split-shipping": {
    title: "Split shipment",
    summary: "T-shirts & sauce · 3 items",
    description: "One order, two warehouses. See how the work is split.",
    icon: "truck",
    delivery: "Shipping",
  },
  pickup: {
    title: "Local pickup",
    summary: "Workshop booking · 1 item",
    description: "A pickup order with a confirmed location and date.",
    icon: "pin",
    delivery: "Pickup",
  },
  "unknown-sku": {
    title: "Unfamiliar product",
    summary: "Unrecognised product · 1 item",
    description: "An unknown product is held for your team to check.",
    icon: "alert",
    delivery: "Shipping",
  },
  unpaid: {
    title: "Awaiting payment",
    summary: "T-shirts & sauce · 3 items",
    description: "An unpaid order waits before any work is proposed.",
    icon: "alert",
    delivery: "Shipping",
  },
  digital: {
    title: "Digital order",
    summary: "Digital guide · 1 item",
    description: "A digital product gets its own delivery queue.",
    icon: "digital",
    delivery: "Digital",
  },
  cancelled: {
    title: "Cancelled order",
    summary: "T-shirts & sauce · 3 items",
    description: "A cancellation stops the order from moving forward.",
    icon: "stop",
    delivery: "Shipping",
  },
};
const statusNames = {
  routed: "Ready to route",
  held: "Needs review",
  ignored: "No action",
};
const statusIcons = { routed: "check", held: "alert", ignored: "stop" };
const destinations = {
  "west-3pl": "West warehouse",
  studio: "Studio",
  "digital-queue": "Digital delivery",
};
let data = { mode: "preview", orders: [], deliveries: [], outbox: [] };
let connected = false;
let token = "";
let selectedId;
let filter = "all";
let sequence = 1100;
let refreshTimer;
let toastTimer;
let sending = false;
const preview = window.FulfilmentPreview;

function toast(text) {
  clearTimeout(toastTimer);
  $("#message").textContent = text;
  $("#message").hidden = false;
  toastTimer = setTimeout(() => {
    $("#message").hidden = true;
  }, 5500);
}
function statusBadge(status) {
  const badge = make("span", undefined, `status ${status}`);
  badge.append(
    icon(statusIcons[status] || "box"),
    make("span", statusNames[status] || status),
  );
  return badge;
}
function presentation(order) {
  const known =
    order.example ||
    (data.mode === "demo"
      ? Object.keys(examples)[Number(order.order_id) - 1001]
      : null);
  if (known && examples[known]) return { ...examples[known], key: known };
  const tasks = order.decision.tasks;
  const first = tasks[0];
  const delivery =
    first?.type === "prepare-pickup"
      ? "Pickup"
      : first?.type === "digital-delivery"
        ? "Digital"
        : first
          ? "Shipping"
          : "To review";
  return {
    key: "order",
    icon:
      delivery === "Pickup"
        ? "pin"
        : delivery === "Digital"
          ? "digital"
          : "box",
    delivery,
    summary: tasks.length
      ? `${tasks.reduce((n, t) => n + t.lines.reduce((q, l) => q + l.quantity, 0), 0)} item(s) planned`
      : "View order decision",
  };
}
function previewOrder(name, id, at = new Date()) {
  const order = preview.createScenario(name, at);
  order.id = String(id);
  const decision = preview.routeOrder(order, preview.rules, at);
  return {
    shop: "fictional-preview",
    order_id: order.id,
    updated_at: order.updatedAt,
    example: name,
    decision,
  };
}
function addPreview(name, id) {
  const order = previewOrder(name, id);
  data.orders.unshift(order);
  data.deliveries.unshift({
    delivery_id: `preview-${id}`,
    topic: examples[name].title,
    state: "evaluated",
    attempts: 0,
    outcome: "Browser preview · routing rules evaluated",
  });
  for (const [index, task] of order.decision.tasks.entries())
    data.outbox.unshift({
      id: `preview-${id}-${index}`,
      order_key: JSON.stringify(["fictional-preview", String(id)]),
      task,
      state: "proposed",
    });
  return order;
}
function seedPreview() {
  data = { mode: "preview", orders: [], deliveries: [], outbox: [] };
  for (const [index, name] of Object.keys(examples).entries())
    addPreview(name, 1001 + index);
  data.orders.reverse();
  selectedId = "1001";
  filter = "all";
  $("#search").value = "";
}
function reasonText(reason) {
  const text = {
    PAYMENT_NOT_PAID:
      "Payment hasn’t been completed. Wait for payment before preparing this order.",
    CURRENCY_NOT_SUPPORTED:
      "This currency isn’t included in the current rules. Review it before continuing.",
    BELOW_MINIMUM_SUBTOTAL:
      "The order is below the configured minimum. Your team needs to review it.",
    ORDER_UNIT_LIMIT:
      "The order exceeds the configured item limit and needs a manual check.",
    UNKNOWN_DELIVERY_METHOD:
      "The delivery method isn’t recognised. Confirm how the order should be fulfilled.",
    PICKUP_ITEM_CANNOT_SHIP:
      "This cart includes a pickup-only product. Confirm the delivery choice.",
    DESTINATION_NOT_SUPPORTED:
      "The shipping destination is missing or outside the configured service area.",
    INVALID_PICKUP_LOCATION:
      "Choose a pickup location included in the fulfilment rules.",
    INVALID_PICKUP_DATE:
      "The pickup date needs checking. It must be today or later in the store’s timezone.",
    NO_SINGLE_LOCATION_STOCK:
      "No single eligible location has enough advisory stock for this cart.",
    INSUFFICIENT_STOCK:
      "The configured stock snapshot can’t cover this order. Check availability before proceeding.",
    ORDER_CANCELLED:
      "This order has been cancelled. No fulfilment work is proposed.",
    NOTHING_TO_FULFIL:
      "There is nothing left to fulfil. No new work is needed.",
    CONFLICTING_ORDER_SNAPSHOT:
      "Two different order updates share a timestamp. Review a newer authoritative order before continuing.",
    DIGITAL_ONLY:
      "This order contains digital goods, so it goes to the digital delivery queue.",
    PICKUP_READY_TO_PLAN:
      "The pickup details check out, and the nominated location has enough advisory stock.",
    SHIPPING_READY_TO_PLAN:
      "Payment, products and delivery details pass the routing rules.",
    SPLIT_SHIPMENT:
      "The items are stocked across two locations, so each warehouse gets its own pick list.",
  };
  if (reason.startsWith("UNKNOWN_SKU:"))
    return "This product isn’t in the routing catalogue. Check its SKU before assigning any work.";
  if (reason.startsWith("SHIPPING_FLAG_MISMATCH:"))
    return "The product’s shipping setting doesn’t match its catalogue type. Check it before continuing.";
  return (
    text[reason] || "This order needs a check against the configured rules."
  );
}
function renderStats() {
  const stats = $("#stats");
  stats.replaceChildren();
  const definitions = [
    {
      label: "Total orders",
      count: data.orders.length,
      sub: connected ? "In the current workspace" : "Fictional sample orders",
      icon: "box",
      className: "",
    },
    {
      label: "Ready to route",
      count: data.orders.filter((o) => o.decision.status === "routed").length,
      sub: "A next step is proposed",
      icon: "check",
      className: "ready",
    },
    {
      label: "Needs review",
      count: data.orders.filter((o) => o.decision.status === "held").length,
      sub: "Waiting for a human check",
      icon: "alert",
      className: "review",
    },
    {
      label: "No action needed",
      count: data.orders.filter((o) => o.decision.status === "ignored").length,
      sub: "No fulfilment work proposed",
      icon: "stop",
      className: "",
    },
  ];
  for (const stat of definitions) {
    const card = make("div", undefined, `stat-card ${stat.className}`),
      top = make("div", undefined, "stat-top"),
      mark = make("span", undefined, "stat-icon");
    mark.append(icon(stat.icon));
    top.append(make("span", stat.label, "stat-label"), mark);
    card.append(
      top,
      make("strong", String(stat.count)),
      make("small", stat.sub),
    );
    stats.append(card);
  }
  $("#order-count").textContent = String(data.orders.length);
  $("#nav-count").textContent = String(data.orders.length);
}
function visibleOrders() {
  const search = $("#search").value.trim().toLowerCase();
  return data.orders.filter((order) => {
    const item = presentation(order);
    const text = [
      order.order_id,
      item.summary,
      item.delivery,
      statusNames[order.decision.status],
      ...order.decision.tasks.flatMap((t) => t.lines.map((l) => l.sku)),
    ]
      .join(" ")
      .toLowerCase();
    return (
      (filter === "all" || order.decision.status === filter) &&
      (!search || text.includes(search))
    );
  });
}
function renderList() {
  const orders = $("#orders");
  const focusedOrder = document.activeElement?.dataset?.orderId;
  orders.replaceChildren();
  const visible = visibleOrders();
  for (const order of visible) {
    const item = presentation(order),
      row = make("button", undefined, "order-row");
    row.type = "button";
    row.dataset.orderId = order.order_id;
    row.setAttribute("aria-pressed", String(selectedId === order.order_id));
    row.setAttribute(
      "aria-label",
      `Order #${order.order_id}, ${item.summary}, ${statusNames[order.decision.status]}. View decision`,
    );
    const summary = make("span", undefined, "order-summary"),
      mark = make("span", undefined, `item-icon ${item.key}`),
      copy = make("span");
    mark.append(icon(item.icon));
    copy.append(
      make("strong", `#${order.order_id}`),
      make("small", item.summary),
    );
    summary.append(mark, copy);
    const delivery = make("span", undefined, "delivery-cell");
    delivery.append(icon(item.icon), make("span", item.delivery));
    row.append(
      summary,
      delivery,
      statusBadge(order.decision.status),
      icon("chevron", "row-arrow"),
    );
    row.addEventListener("click", () => {
      selectedId = order.order_id;
      renderList();
      renderDetail();
      if (window.matchMedia("(max-width:960px)").matches)
        $("#order-detail").scrollIntoView({
          behavior: window.matchMedia("(prefers-reduced-motion:reduce)").matches
            ? "auto"
            : "smooth",
          block: "start",
        });
    });
    orders.append(row);
  }
  if (!visible.length) {
    const empty = make("div", undefined, "empty-state");
    empty.append(
      icon("search"),
      make(
        "strong",
        data.orders.length
          ? "No orders match this view"
          : "Your engine is ready for an order",
      ),
      make(
        "p",
        data.orders.length
          ? "Try a different search or choose All orders."
          : data.mode === "service"
            ? "Signed order events will appear here after processing."
            : "Choose Try a scenario to send a sample through the engine.",
      ),
    );
    orders.append(empty);
  }
  $("#list-summary").textContent =
    `Showing ${visible.length} of ${data.orders.length} ${connected ? "orders" : "sample orders"}`;
  if (focusedOrder)
    [...orders.querySelectorAll("[data-order-id]")]
      .find((row) => row.dataset.orderId === focusedOrder)
      ?.focus({ preventScroll: true });
}
function renderDetail() {
  const panel = $("#order-detail");
  panel.replaceChildren();
  const order = data.orders.find((o) => o.order_id === selectedId);
  if (!order) {
    const empty = make("div", undefined, "empty-state");
    empty.append(
      icon("box"),
      make("strong", "Select an order"),
      make("p", "Its decision and next steps will appear here."),
    );
    panel.append(empty);
    return;
  }
  const item = presentation(order),
    decision = order.decision;
  const eyebrow = make("div", undefined, "detail-eyebrow");
  eyebrow.append(make("span", "ORDER DETAILS"), icon("box"));
  const header = make("div", undefined, "detail-header"),
    mark = make("span", undefined, `item-icon ${item.key}`),
    heading = make("div");
  mark.append(icon(item.icon));
  heading.append(
    make("h2", `Order #${order.order_id}`),
    make(
      "p",
      data.mode === "service"
        ? "Connected order · proposal mode"
        : "Sample order · AUD",
    ),
  );
  header.append(mark, heading);
  const status = make("div", undefined, "detail-status");
  status.append(statusBadge(decision.status));
  const copy = make("div", undefined, "detail-copy");
  copy.append(
    make(
      "h3",
      decision.status === "routed"
        ? "Why this route?"
        : decision.status === "held"
          ? "What needs attention?"
          : "Why no action?",
    ),
  );
  const reasons = decision.reasons.includes("SPLIT_SHIPMENT")
    ? ["SPLIT_SHIPMENT"]
    : decision.reasons;
  for (const reason of reasons) copy.append(make("p", reasonText(reason)));
  const flow = make("div", undefined, "route-flow");
  const steps = [
    "Order received",
    "Rules checked",
    decision.status === "routed"
      ? "Next steps proposed"
      : decision.status === "held"
        ? "Held for review"
        : "No work needed",
  ];
  for (const [index, text] of steps.entries()) {
    const step = make("div", undefined, "flow-step"),
      dot = make("span");
    dot.append(icon(index === 2 ? statusIcons[decision.status] : "check"));
    step.append(dot, make("span", text));
    flow.append(step);
  }
  copy.append(flow);
  const tasks = make("div", undefined, "tasks-wrap"),
    taskHeading = make("h3", undefined, "task-heading");
  taskHeading.append(
    make(
      "strong",
      decision.tasks.length
        ? "Suggested next steps"
        : decision.status === "held"
          ? "Before you continue"
          : "You’re all set",
    ),
    make("span", "PROPOSAL"),
  );
  tasks.append(taskHeading);
  const taskList = make("div", undefined, "tasks-list");
  if (decision.tasks.length)
    for (const task of decision.tasks) {
      const card = make("div", undefined, "task-card"),
        text = make("div");
      const verb =
        task.type === "warehouse-pick"
          ? "Prepare shipment"
          : task.type === "prepare-pickup"
            ? "Prepare pickup"
            : "Queue digital delivery";
      text.append(
        make("strong", destinations[task.destination] || task.destination),
        make("small", verb),
      );
      card.append(
        icon(
          task.type === "prepare-pickup"
            ? "pin"
            : task.type === "digital-delivery"
              ? "digital"
              : "box",
        ),
        text,
        make(
          "span",
          `${task.lines.reduce((n, l) => n + l.quantity, 0)} item(s)`,
          "quantity",
        ),
      );
      taskList.append(card);
    }
  else {
    const card = make("div", undefined, "task-card"),
      text = make("div");
    text.append(
      make(
        "strong",
        decision.status === "held" ? "Review this order" : "No task created",
      ),
      make(
        "small",
        decision.status === "held"
          ? "Resolve the check above, then re-evaluate."
          : "The engine won’t propose fulfilment.",
      ),
    );
    card.append(icon(decision.status === "held" ? "alert" : "check"), text);
    taskList.append(card);
  }
  tasks.append(taskList);
  const note = make("p", undefined, "detail-note");
  note.append(
    icon("shield"),
    make(
      "span",
      "Proposed work only. Stock is an advisory snapshot; no shipment or reservation is made.",
    ),
  );
  panel.append(eyebrow, header, status, copy, tasks, note);
}
function renderAudit() {
  const deliveries = $("#deliveries");
  deliveries.replaceChildren();
  for (const delivery of data.deliveries.slice(0, 12)) {
    const row = make("div", undefined, "audit-row");
    row.append(
      make("span", delivery.topic),
      make("strong", delivery.state),
      make(
        "small",
        data.mode === "preview"
          ? delivery.outcome
          : `${delivery.attempts} attempt(s) · ${delivery.outcome || delivery.error_code || "waiting"}`,
      ),
    );
    deliveries.append(row);
  }
  if (!data.deliveries.length)
    deliveries.append(make("p", "No events received yet."));
  const outbox = $("#outbox");
  outbox.replaceChildren();
  for (const entry of data.outbox.slice(0, 16)) {
    const row = make("div", undefined, "audit-row");
    row.append(
      make(
        "span",
        destinations[entry.task.destination] || entry.task.destination,
      ),
      make("strong", entry.state),
      make(
        "small",
        entry.task.lines.map((l) => `${l.quantity} × ${l.sku}`).join(", "),
      ),
    );
    outbox.append(row);
  }
  if (!data.outbox.length) outbox.append(make("p", "No work proposed."));
}
function render() {
  const modeText =
    data.mode === "preview"
      ? "Interactive preview"
      : data.mode === "demo"
        ? "Local engine · sample data"
        : "Connected engine";
  $("#mode").replaceChildren(
    make("span", undefined, "live-dot"),
    make("span", modeText),
  );
  $("#connect-engine").replaceChildren(
    make(
      "span",
      connected
        ? "Return to interactive preview"
        : location.protocol === "file:"
          ? "Open connected engine"
          : "Connect to local engine",
    ),
    icon("arrow"),
  );
  $("#activity-heading").textContent = connected
    ? "Webhook inbox"
    : "Preview activity";
  $("#processing-note").textContent = connected
    ? "Events are verified and stored by the local engine before the worker evaluates them. The tasks below are proposals, not completed fulfilments."
    : "This browser preview runs the shared routing rules on fictional orders. Webhook delivery and database persistence are available in the connected engine.";
  const service = data.mode === "service";
  $(".sidebar-bottom strong").textContent = service
    ? "Review before fulfilment"
    : "A safe place to explore";
  $(".sidebar-bottom p").textContent = service
    ? "Connected order data. Proposed work only."
    : "Fictional orders. Real routing logic.";
  $(".sandbox-tag").replaceChildren(
    make("span"),
    document.createTextNode(service ? "Service workspace" : "Demo workspace"),
  );
  document.querySelectorAll('[data-open="scenarios"]').forEach((button) => {
    button.hidden = service;
  });
  $(".welcome-banner strong").textContent = service
    ? "Connected to your fulfilment workspace."
    : "Meet your next smoother workflow.";
  $(".welcome-banner p").textContent = service
    ? "Select an order to review its decision and proposed next steps."
    : connected
      ? "You’re viewing the local engine. Try a scenario to send a signed sample order through its queue."
      : "Explore the sample orders below, or try a scenario to see the engine make a decision.";
  $(".sample-label").hidden = service;
  renderStats();
  renderList();
  renderDetail();
  renderAudit();
}
async function request(path, method = "GET") {
  const response = await fetch(path, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (response.status === 401) {
    if (!$("#auth-dialog").open) $("#auth-dialog").showModal();
    const error = new Error("A service access token is required.");
    error.auth = true;
    throw error;
  }
  if (!response.ok)
    throw new Error(
      `The engine couldn’t complete that request (${response.status}). Please try again.`,
    );
  return response.json();
}
async function refreshEngine() {
  clearTimeout(refreshTimer);
  try {
    const next = await request("/api/state");
    data = next;
    connected = true;
    if (!data.orders.some((o) => o.order_id === selectedId))
      selectedId = data.orders[0]?.order_id;
    render();
    if (data.deliveries.some((d) => ["queued", "processing"].includes(d.state)))
      refreshTimer = setTimeout(refreshEngine, 500);
    return true;
  } catch (error) {
    if (!error.auth)
      toast(
        "The local engine is unavailable. Start it with npm start, then connect again.",
      );
    return false;
  }
}
for (const [name, item] of Object.entries(examples)) {
  const button = make("button", undefined, "scenario-option");
  button.type = "button";
  button.dataset.scenario = name;
  const mark = make("span", undefined, `item-icon ${name}`),
    text = make("span");
  mark.append(icon(item.icon));
  text.append(make("strong", item.title), make("small", item.description));
  button.append(mark, text, icon("chevron", "row-arrow"));
  button.addEventListener("click", async () => {
    if (sending) return;
    sending = true;
    button.disabled = true;
    try {
      filter = "all";
      $("#search").value = "";
      updateFilterButtons();
      if (connected) {
        await request(`/api/demo/${name}`, "POST");
        selectedId = String(1001 + Object.keys(examples).indexOf(name));
        await refreshEngine();
        toast("Sample order accepted. Its decision will appear shortly.");
      } else {
        const added = addPreview(name, ++sequence);
        selectedId = added.order_id;
        render();
        toast(
          `Order #${selectedId} added — ${statusNames[added.decision.status].toLowerCase()}.`,
        );
      }
      $("#scenario-dialog").close();
    } catch (error) {
      if (!error.auth) toast(error.message);
    } finally {
      button.disabled = false;
      sending = false;
    }
  });
  $("#scenarios").append(button);
}
function updateFilterButtons() {
  document
    .querySelectorAll("[data-filter]")
    .forEach((button) =>
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.filter === filter),
      ),
    );
}
document.querySelectorAll("[data-filter]").forEach((button) =>
  button.addEventListener("click", () => {
    filter = button.dataset.filter;
    updateFilterButtons();
    selectedId = visibleOrders()[0]?.order_id;
    renderList();
    renderDetail();
  }),
);
$("#search").addEventListener("input", () => {
  const visible = visibleOrders();
  if (!visible.some((order) => order.order_id === selectedId))
    selectedId = visible[0]?.order_id;
  renderList();
  renderDetail();
});
document
  .querySelectorAll("[data-open]")
  .forEach((button) =>
    button.addEventListener("click", () =>
      $(
        `#${button.dataset.open === "scenarios" ? "scenario" : "about"}-dialog`,
      ).showModal(),
    ),
  );
document
  .querySelectorAll(".close-dialog")
  .forEach((button) =>
    button.addEventListener("click", () => button.closest("dialog").close()),
  );
$("#refresh").addEventListener("click", () => {
  if (connected) void refreshEngine();
  else {
    render();
    toast("Your sample orders are up to date.");
  }
});
$("#connect-engine").addEventListener("click", () => {
  if (connected) {
    connected = false;
    clearTimeout(refreshTimer);
    seedPreview();
    updateFilterButtons();
    render();
    toast("Returned to the interactive preview.");
  } else if (location.protocol === "file:")
    location.href = "http://127.0.0.1:3000/?engine=1";
  else void refreshEngine();
});
$("#auth").addEventListener("submit", async (event) => {
  event.preventDefault();
  token = $("#token").value;
  $("#token").value = "";
  if (await refreshEngine()) $("#auth-dialog").close();
});
if (preview) {
  seedPreview();
  render();
  if (
    new URLSearchParams(location.search).get("engine") === "1" &&
    location.protocol !== "file:"
  )
    void refreshEngine();
} else
  toast(
    "The preview assets are missing. Run npm run build from the project folder, then reload this page.",
  );
