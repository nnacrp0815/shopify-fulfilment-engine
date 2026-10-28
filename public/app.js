let token = "";
let refreshTimer;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 500);
}
const element = (name, text, className) => {
  const node = document.createElement(name);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const message = document.querySelector("#message");
async function request(path, method = "GET") {
  const response = await fetch(path, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (response.status === 401) {
    document.querySelector("#mode").textContent = "SERVICE / SIGN IN";
    document.querySelector("#auth").hidden = false;
    document.querySelector("#scenarios").hidden = true;
    throw new Error("Enter your service access token to inspect decisions.");
  }
  if (!response.ok)
    throw new Error(`Request could not complete (${response.status}).`);
  return response.json();
}
function render(data) {
  document.querySelector("#mode").textContent =
    data.mode === "demo" ? "LOCAL DEMO" : "SERVICE / PROPOSALS";
  document.querySelector("#scenarios").hidden = data.mode !== "demo";
  const stats = document.querySelector("#stats");
  stats.replaceChildren();
  for (const status of ["routed", "held", "ignored"]) {
    const card = element("div", undefined, "stat");
    card.append(
      element(
        "strong",
        String(data.orders.filter((o) => o.decision.status === status).length),
      ),
      element("span", status),
    );
    stats.append(card);
  }
  const orders = document.querySelector("#orders");
  orders.replaceChildren();
  if (!data.orders.length)
    orders.append(
      element("p", "No decisions yet. Send a sample order above.", "empty"),
    );
  for (const order of data.orders) {
    const card = element("article", undefined, "order");
    const title = element("div", undefined, "order-title");
    title.append(
      element("h3", `Order #${order.order_id}`),
      element("span", order.decision.status, `status ${order.decision.status}`),
    );
    const reasons = element("ul");
    for (const reason of order.decision.reasons)
      reasons.append(element("li", reason.replaceAll("_", " ").toLowerCase()));
    card.append(
      title,
      reasons,
      element(
        "p",
        `${order.decision.tasks.length} proposed task(s) · rules ${order.decision.rulesVersion}`,
        "subtle",
      ),
    );
    const details = element("details");
    details.append(
      element("summary", "Inspect decision"),
      element("pre", JSON.stringify(order.decision, null, 2)),
    );
    card.append(details);
    orders.append(card);
  }
  const deliveries = document.querySelector("#deliveries");
  deliveries.replaceChildren();
  if (!data.deliveries.length)
    deliveries.append(element("p", "The inbox is empty.", "subtle"));
  for (const delivery of data.deliveries) {
    const row = element("div", undefined, "audit-row");
    row.append(
      element("span", delivery.topic),
      element("strong", delivery.state),
      element(
        "small",
        `${delivery.attempts} attempt(s) · ${delivery.outcome || delivery.error_code || "waiting"}`,
      ),
    );
    deliveries.append(row);
  }
  const outbox = document.querySelector("#outbox");
  outbox.replaceChildren();
  if (!data.outbox.length)
    outbox.append(element("p", "No proposed work.", "subtle"));
  for (const task of data.outbox) {
    const row = element("div", undefined, "audit-row");
    row.append(
      element("span", `${task.task.type} → ${task.task.destination}`),
      element("strong", task.state),
      element(
        "small",
        task.task.lines.map((l) => `${l.quantity} × ${l.sku}`).join(", "),
      ),
    );
    outbox.append(row);
  }
}
async function refresh() {
  clearTimeout(refreshTimer);
  try {
    const data = await request("/api/state");
    render(data);
    if (data.deliveries.some((d) => ["queued", "processing"].includes(d.state)))
      scheduleRefresh();
    message.textContent =
      "Connected. Decisions and proposed work update below.";
  } catch (error) {
    message.textContent = error.message;
  }
}
document.querySelector("#refresh").addEventListener("click", refresh);
document.querySelector("#auth").addEventListener("submit", (event) => {
  event.preventDefault();
  token = document.querySelector("#token").value;
  document.querySelector("#token").value = "";
  void refresh();
});
document.querySelectorAll("[data-scenario]").forEach((button) =>
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      await request(`/api/demo/${button.dataset.scenario}`, "POST");
      message.textContent = "Order accepted. Waiting for its decision…";
      scheduleRefresh();
    } catch (error) {
      message.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }),
);
void refresh();
