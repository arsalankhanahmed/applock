// ColdChain Monitor dashboard: a dependency-free single page app (Chart.js for graphs).
"use strict";

const state = { token: localGet("cc_token"), user: JSON.parse(localGet("cc_user") || "null"), timer: null, chart: null };
const $app = document.getElementById("app");

function localGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localSet(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* private mode */ } }

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const isAdmin = () => state.user && state.user.role === "ADMIN";
const fmtVal = (v, unit) => (v === null || v === undefined ? "—" : `${Number(v).toFixed(1)}${unit || ""}`);
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
function ago(iso) {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 3500);
}

async function api(path, opts = {}) {
  const headers = { ...(opts.body ? { "Content-Type": "application/json" } : {}), ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) };
  const res = await fetch(path, { ...opts, headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (res.status === 401 && path !== "/api/auth/login") { logout(); throw new Error("Signed out"); }
  if (opts.raw) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = data.detail;
    throw new Error(Array.isArray(d) ? d.map((e) => e.msg).join("; ") : d || `Error ${res.status}`);
  }
  return data;
}

function logout() {
  state.token = null; state.user = null; localSet("cc_token", null); localSet("cc_user", null);
  location.hash = "#/login"; render();
}
document.getElementById("logout").onclick = logout;

// --- Router --------------------------------------------------------------------------------------------------

const routes = [
  [/^#\/login$/, viewLogin], [/^#\/?$/, viewOverview], [/^#\/sensor\/(\d+)$/, viewSensor],
  [/^#\/alerts$/, viewAlerts], [/^#\/alerts\/(\d+)$/, viewAlert], [/^#\/devices$/, viewDevices],
  [/^#\/contacts$/, viewContacts], [/^#\/audit$/, viewAudit], [/^#\/users$/, viewUsers],
];

async function render() {
  clearInterval(state.timer); state.timer = null;
  if (state.chart) { state.chart.destroy(); state.chart = null; }
  const hash = location.hash || "#/";
  if (!state.token && hash !== "#/login") { location.hash = "#/login"; return; }
  document.getElementById("topbar").hidden = !state.token;
  if (state.user) document.getElementById("who").textContent = `${state.user.email} (${state.user.role.toLowerCase()})`;
  document.querySelectorAll("[data-admin]").forEach((el) => (el.hidden = !isAdmin()));
  document.querySelectorAll("#nav a").forEach((a) => {
    const h = a.getAttribute("href");
    a.classList.toggle("active", h === "#/" ? hash === "#/" || hash === "#" : hash.startsWith(h));
  });
  for (const [re, view] of routes) {
    const m = hash.match(re);
    if (m) {
      try { await view(...m.slice(1)); } catch (e) { if (e.message !== "Signed out") $app.innerHTML = `<p class="error">${esc(e.message)}</p>`; }
      return;
    }
  }
  $app.innerHTML = "<p>Not found.</p>";
}
window.addEventListener("hashchange", render);

async function refreshBadge() {
  if (!state.token) return;
  try {
    const active = await api("/api/alerts?status=active");
    const open = active.filter((a) => a.status === "OPEN").length;
    const b = document.getElementById("alert-badge");
    b.textContent = open; b.hidden = open === 0;
  } catch { /* ignore */ }
}
setInterval(refreshBadge, 20000);

// --- Login ---------------------------------------------------------------------------------------------------

function viewLogin() {
  $app.innerHTML = `
    <div class="login panel">
      <h1>❄ ColdChain Monitor</h1>
      <form id="f">
        <label>Email <input name="email" type="email" required autocomplete="username"></label>
        <label>Password <input name="password" type="password" required autocomplete="current-password"></label>
        <button>Sign in</button>
        <p class="error" id="err"></p>
      </form>
    </div>`;
  document.getElementById("f").onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const r = await api("/api/auth/login", { method: "POST", body: { email: fd.get("email"), password: fd.get("password") } });
      state.token = r.token; state.user = r.user;
      localSet("cc_token", r.token); localSet("cc_user", JSON.stringify(r.user));
      location.hash = "#/";
      refreshBadge();
    } catch (err) { document.getElementById("err").textContent = err.message; }
  };
}

// --- Overview ------------------------------------------------------------------------------------------------

function deviceChips(d) {
  const c = [d.online ? `<span class="chip ok">online</span>` : `<span class="chip bad">${d.last_seen_at ? "offline" : "never connected"}</span>`];
  if (d.mains_power === false) c.push(`<span class="chip bad">on battery</span>`);
  else if (d.mains_power === true) c.push(`<span class="chip ok">mains</span>`);
  if (d.battery_pct !== null) c.push(`<span class="chip ${d.battery_pct < 20 ? "warn" : ""}">🔋 ${Math.round(d.battery_pct)}%</span>`);
  if (d.rssi !== null) c.push(`<span class="chip">${esc(d.network || "signal")} ${d.rssi} dBm</span>`);
  return c.join("");
}

function sensorTile(s, online) {
  const limits = s.min_value === null && s.max_value === null ? "no limits set"
    : `${s.min_value ?? "−∞"} … ${s.max_value ?? "∞"} ${esc(s.unit)}`;
  const note = s.state === "breach" ? `${s.breach_kind === "HIGH" ? "above max" : "below min"} since ${fmtTime(s.breach_since)}` : limits;
  return `<a class="sensor ${s.state} ${online ? "" : "stale"}" href="#/sensor/${s.id}">
      <div><div>${esc(s.label)}</div><div class="meta">${esc(note)}</div></div>
      <div class="v">${fmtVal(s.last_value, s.unit)}</div></a>`;
}

function alertTable(alerts, withActions = true) {
  if (!alerts.length) return `<p class="muted">No alerts.</p>`;
  return `<div class="table-wrap"><table><tr><th>#</th><th>Status</th><th>What</th><th>Started</th><th>Level</th>${withActions ? "<th></th>" : ""}</tr>
    ${alerts.map((a) => `<tr class="alert-row ${a.status}">
      <td><a href="#/alerts/${a.id}">${a.id}</a></td>
      <td><span class="chip ${a.status === "OPEN" ? "bad" : a.status === "ACKED" ? "warn" : "ok"}">${a.status.toLowerCase()}</span></td>
      <td>${esc(a.summary)}${a.acked_by ? `<div class="meta">Ack: ${esc(a.acked_by)} ${esc(a.ack_note)}</div>` : ""}</td>
      <td>${fmtTime(a.started_at)}</td><td>${a.level}</td>
      ${withActions ? `<td>${a.status === "OPEN" ? `<button data-ack="${a.id}">Acknowledge</button>` : ""}</td>` : ""}</tr>`).join("")}
    </table></div>`;
}

function bindAck(after) {
  $app.querySelectorAll("[data-ack]").forEach((b) => (b.onclick = async () => {
    const note = prompt("What is being done? (recorded in the audit trail)", "");
    if (note === null) return;
    try { await api(`/api/alerts/${b.dataset.ack}/ack`, { method: "POST", body: { note } }); toast("Acknowledged"); after(); refreshBadge(); }
    catch (e) { toast(e.message); }
  }));
}

async function viewOverview() {
  const draw = async () => {
    const o = await api("/api/overview");
    const c = o.counts;
    $app.innerHTML = `
      <div class="kpis">
        <div class="panel kpi"><div class="n">${c.devices}</div><div class="l">devices at ${c.sites} site(s)</div></div>
        <div class="panel kpi"><div class="n" style="color:var(${c.online < c.devices ? "--bad" : "--ok"})">${c.online}/${c.devices}</div><div class="l">online</div></div>
        <div class="panel kpi"><div class="n" style="color:var(${c.open_alerts ? "--bad" : "--ok"})">${c.open_alerts}</div><div class="l">open alerts</div></div>
        <div class="panel kpi"><div class="n">${c.acked_alerts}</div><div class="l">acknowledged</div></div>
      </div>
      ${o.alerts.length ? `<h2>Active alerts</h2><div class="panel">${alertTable(o.alerts)}</div>` : ""}
      ${o.sites.length ? "" : `<div class="panel"><p>No sites yet.</p>${isAdmin() ? `<a href="#/devices">Add a site and your first device →</a>` : ""}</div>`}
      ${o.sites.map((s) => `
        <h2>${esc(s.name)} <span class="meta">${esc(s.address)}</span></h2>
        <div class="grid">${s.devices.map((d) => `
          <div class="panel">
            <div class="device-head"><span class="name">${esc(d.name)}</span><span class="meta">${esc(d.serial)}</span></div>
            <div class="chips">${deviceChips(d)}</div>
            ${d.sensors.map((x) => sensorTile(x, d.online)).join("") || `<p class="muted">Waiting for first reading…</p>`}
            <div class="meta" style="margin-top:8px">Last data ${ago(d.last_seen_at)} · every ${d.interval_seconds}s</div>
          </div>`).join("") || `<p class="muted">No devices at this site.</p>`}
        </div>`).join("")}
      <p class="meta">Auto-refreshes every 15 seconds.</p>`;
    bindAck(draw);
  };
  await draw();
  state.timer = setInterval(() => draw().catch(() => {}), 15000);
}

// --- Sensor detail -------------------------------------------------------------------------------------------

async function viewSensor(id) {
  const ranges = { "6h": 6, "24h": 24, "7d": 168, "30d": 720 };
  let range = "24h";
  $app.innerHTML = `<p class="muted">Loading…</p>`;

  const draw = async () => {
    const end = new Date(), start = new Date(end - ranges[range] * 3600e3);
    const q = `start=${start.toISOString()}&end=${end.toISOString()}`;
    const [data, report] = await Promise.all([api(`/api/sensors/${id}/readings?${q}`), api(`/api/sensors/${id}/report?${q}`)]);
    const s = data.sensor, sum = report.summary;
    $app.innerHTML = `
      <div class="row"><h1 style="margin:0">${esc(s.label)}</h1><span class="meta">${esc(report.site)} / ${esc(report.device)} · ${esc(s.kind)}</span>
        <span class="spacer"></span>
        ${Object.keys(ranges).map((r) => `<button class="${r === range ? "" : "secondary"}" data-range="${r}">${r}</button>`).join("")}
        <button class="secondary" id="csv">Export CSV</button></div>
      <div class="panel" style="margin-top:12px"><div class="chart-box"><canvas id="chart"></canvas></div></div>
      <h2>Summary for this period</h2>
      <div class="panel stats">${sum.count ? `
        <div><b>${fmtVal(sum.min, s.unit)}</b><span>minimum</span></div>
        <div><b>${fmtVal(sum.max, s.unit)}</b><span>maximum</span></div>
        <div><b>${fmtVal(sum.avg, s.unit)}</b><span>average</span></div>
        ${sum.mkt !== undefined ? `<div><b>${fmtVal(sum.mkt, s.unit)}</b><span>mean kinetic temp. (MKT)</span></div>` : ""}
        <div><b>${sum.pct_in_range ?? "—"}%</b><span>time in range</span></div>
        <div><b>${sum.minutes_out_of_range} min</b><span>out of range</span></div>
        <div><b>${sum.count}</b><span>readings</span></div>` : `<p class="muted">No readings in this period.</p>`}</div>
      <h2>Excursions in this period</h2>
      <div class="panel">${alertTable(report.excursions, false)}</div>
      ${isAdmin() ? `<h2>Alert limits</h2>
      <form class="panel inline" id="limits">
        <label>Label <input name="label" value="${esc(s.label)}"></label>
        <label>Type <select name="kind">${["temperature", "humidity", "other"].map((k) => `<option ${k === s.kind ? "selected" : ""}>${k}</option>`).join("")}</select></label>
        <label>Unit <input name="unit" value="${esc(s.unit)}" size="4"></label>
        <label>Minimum <input name="min_value" type="number" step="0.1" value="${s.min_value ?? ""}" placeholder="none"></label>
        <label>Maximum <input name="max_value" type="number" step="0.1" value="${s.max_value ?? ""}" placeholder="none"></label>
        <label>Alert after (min) <input name="delay_minutes" type="number" min="0" max="240" value="${s.delay_minutes}"></label>
        <label class="checks"><input type="checkbox" name="enabled" ${s.enabled ? "checked" : ""}> Alerts on</label>
        <button>Save limits</button>
      </form>
      <p class="meta">Typical: vaccines / fridges 2…8 °C · freezers −25…−15 °C · ambient pharma store 15…25 °C, humidity ≤ 60 % · server room 18…27 °C, humidity 20…80 %.</p>` : ""}`;

    const pts = data.points.map(([t, v]) => ({ x: new Date(t).getTime(), y: v }));
    const lines = [];
    const xs = [start.getTime(), end.getTime()];
    if (s.max_value !== null) lines.push({ label: "max", data: xs.map((x) => ({ x, y: s.max_value })), borderColor: "#c62828", borderDash: [6, 4], pointRadius: 0, borderWidth: 1 });
    if (s.min_value !== null) lines.push({ label: "min", data: xs.map((x) => ({ x, y: s.min_value })), borderColor: "#0b6bcb", borderDash: [6, 4], pointRadius: 0, borderWidth: 1 });
    if (window.Chart) {
      const muted = getComputedStyle(document.documentElement).getPropertyValue("--muted");
      state.chart = new Chart(document.getElementById("chart"), {
        type: "line",
        data: { datasets: [{ label: s.label, data: pts, borderColor: "#1a7f4b", pointRadius: pts.length > 200 ? 0 : 2, borderWidth: 2, tension: 0.2 }, ...lines] },
        options: {
          animation: false, maintainAspectRatio: false, parsing: false,
          interaction: { mode: "nearest", intersect: false },
          scales: {
            x: { type: "linear", min: xs[0], max: xs[1], ticks: { color: muted, maxTicksLimit: 8, callback: (v) => fmtTime(new Date(v).toISOString()) } },
            y: { ticks: { color: muted, callback: (v) => `${v}${s.unit}` } },
          },
          plugins: { legend: { labels: { color: muted } }, tooltip: { callbacks: { title: (i) => fmtTime(new Date(i[0].parsed.x).toISOString()), label: (i) => `${i.dataset.label}: ${fmtVal(i.parsed.y, s.unit)}` } } },
        },
      });
    }
    $app.querySelectorAll("[data-range]").forEach((b) => (b.onclick = () => { range = b.dataset.range; if (state.chart) { state.chart.destroy(); state.chart = null; } draw(); }));
    document.getElementById("csv").onclick = async () => {
      const res = await api(`/api/sensors/${id}/export.csv?${q}`, { raw: true });
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement("a"), { href: url, download: `${s.key}-${range}.csv` });
      a.click(); URL.revokeObjectURL(url);
    };
    const f = document.getElementById("limits");
    if (f) f.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(f);
      const num = (k) => (fd.get(k) === "" ? null : Number(fd.get(k)));
      const body = { label: fd.get("label"), kind: fd.get("kind"), unit: fd.get("unit"), delay_minutes: Number(fd.get("delay_minutes")), enabled: fd.get("enabled") === "on" };
      if (num("min_value") === null) body.clear_min = true; else body.min_value = num("min_value");
      if (num("max_value") === null) body.clear_max = true; else body.max_value = num("max_value");
      try { await api(`/api/sensors/${id}`, { method: "PATCH", body }); toast("Limits saved"); if (state.chart) { state.chart.destroy(); state.chart = null; } draw(); }
      catch (err) { toast(err.message); }
    };
  };
  await draw();
}

// --- Alerts --------------------------------------------------------------------------------------------------

async function viewAlerts() {
  let filter = "active";
  const draw = async () => {
    const alerts = await api(`/api/alerts?status=${filter}`);
    $app.innerHTML = `<div class="row"><h1 style="margin:0">Alerts</h1><span class="spacer"></span>
      ${["active", "resolved", "all"].map((f) => `<button class="${f === filter ? "" : "secondary"}" data-f="${f}">${f}</button>`).join("")}</div>
      <div class="panel" style="margin-top:12px">${alertTable(alerts)}</div>`;
    $app.querySelectorAll("[data-f]").forEach((b) => (b.onclick = () => { filter = b.dataset.f; draw(); }));
    bindAck(draw);
  };
  await draw();
}

async function viewAlert(id) {
  const a = await api(`/api/alerts/${id}`);
  $app.innerHTML = `
    <h1>Alert #${a.id} <span class="chip ${a.status === "OPEN" ? "bad" : a.status === "ACKED" ? "warn" : "ok"}">${a.status.toLowerCase()}</span></h1>
    <div class="panel">
      <p><b>${esc(a.summary)}</b></p>
      <table>
        <tr><th>Site / device</th><td>${esc(a.site_name)} / ${esc(a.device_name)} (${esc(a.serial)})</td></tr>
        ${a.sensor_id ? `<tr><th>Sensor</th><td><a href="#/sensor/${a.sensor_id}">${esc(a.sensor_label)}</a> · limit ${fmtVal(a.threshold, a.unit)} · worst ${fmtVal(a.peak_value, a.unit)}</td></tr>` : ""}
        <tr><th>Condition began</th><td>${fmtTime(a.started_at)}</td></tr>
        <tr><th>Alert opened</th><td>${fmtTime(a.opened_at)} · escalation level ${a.level}</td></tr>
        <tr><th>Acknowledged</th><td>${a.acked_by ? `${esc(a.acked_by)} at ${fmtTime(a.acked_at)}` : "—"}</td></tr>
        <tr><th>Notes</th><td style="white-space:pre-wrap">${esc(a.ack_note) || "—"}</td></tr>
        <tr><th>Resolved</th><td>${fmtTime(a.resolved_at)}</td></tr>
      </table>
      <div class="row" style="margin-top:12px">
        ${a.status === "OPEN" ? `<button data-ack="${a.id}">Acknowledge</button>` : ""}
        ${isAdmin() && a.status !== "RESOLVED" ? `<button class="danger" id="close">Close manually</button>` : ""}
      </div>
    </div>
    <h2>Messages sent</h2>
    <div class="panel table-wrap">${a.notifications.length ? `<table><tr><th>When</th><th>Event</th><th>Channel</th><th>To</th><th>Result</th></tr>
      ${a.notifications.map((n) => `<tr><td>${fmtTime(n.sent_at)}</td><td>${esc(n.event)}</td><td>${esc(n.channel)}</td><td>${esc(n.recipient)}</td>
        <td>${n.ok ? `<span class="chip ok">sent via ${esc(n.provider)}</span>` : `<span class="chip bad">failed</span> <span class="meta">${esc(n.error)}</span>`}</td></tr>`).join("")}</table>`
      : `<p class="muted">No messages yet. Add contacts so alerts reach someone.</p>`}</div>`;
  bindAck(() => viewAlert(id));
  const close = document.getElementById("close");
  if (close) close.onclick = async () => {
    const note = prompt("Why is this being closed by hand?", "");
    if (note === null) return;
    try { await api(`/api/alerts/${id}/resolve`, { method: "POST", body: { note } }); viewAlert(id); refreshBadge(); } catch (e) { toast(e.message); }
  };
}

// --- Sites & devices -----------------------------------------------------------------------------------------

async function viewDevices() {
  const o = await api("/api/overview");
  const admin = isAdmin();
  $app.innerHTML = `
    <h1>Sites &amp; devices</h1>
    <div id="secret"></div>
    ${admin ? `<form class="panel inline" id="site-form">
      <label>New site name <input name="name" required placeholder="Karachi Warehouse"></label>
      <label>Address <input name="address" placeholder="optional"></label>
      <button>Add site</button></form>` : ""}
    ${o.sites.map((s) => `
      <h2>${esc(s.name)} ${admin ? `<button class="link" data-del-site="${s.id}">delete</button>` : ""}</h2>
      <div class="panel table-wrap">
        <table><tr><th>Device</th><th>Serial</th><th>Status</th><th>Interval</th><th>Firmware</th>${admin ? "<th></th>" : ""}</tr>
        ${s.devices.map((d) => `<tr>
          <td>${esc(d.name)}</td><td><code>${esc(d.serial)}</code></td><td>${deviceChips(d)}<div class="meta">${ago(d.last_seen_at)}</div></td>
          <td>${admin ? `<select data-interval="${d.id}">${[10, 30, 60, 120, 300, 600, 900].map((v) => `<option value="${v}" ${v === d.interval_seconds ? "selected" : ""}>${v < 60 ? v + " s" : v / 60 + " min"}</option>`).join("")}</select>` : `${d.interval_seconds}s`}</td>
          <td>${esc(d.firmware) || "—"}</td>
          ${admin ? `<td class="row"><button class="secondary" data-rotate="${d.id}">New key</button><button class="danger" data-del-dev="${d.id}">Delete</button></td>` : ""}
        </tr>`).join("")}</table>
        ${admin ? `<form class="inline" data-dev-form="${s.id}" style="margin-top:12px">
          <label>New device name <input name="name" required placeholder="Cold Room 1 / Server Rack A"></label>
          <button>Add device</button></form>` : ""}
      </div>`).join("")}`;

  const showSecret = (serial, secret) => {
    document.getElementById("secret").innerHTML = `<div class="panel" style="margin-bottom:16px">
      <b>Device credentials — copy them now, the key is shown only once.</b>
      <div class="secret">Serial: ${esc(serial)}\nKey:    ${esc(secret)}\nServer: ${esc(location.origin)}</div>
      <p class="meta">Power on the device; it opens a Wi-Fi network named <b>ColdChain-Setup</b>. Connect with your phone, choose the site's Wi-Fi and enter the server, serial and key above.</p></div>`;
    window.scrollTo(0, 0);
  };
  const reload = () => viewDevices().catch((e) => toast(e.message));
  const sf = document.getElementById("site-form");
  if (sf) sf.onsubmit = async (e) => {
    e.preventDefault(); const fd = new FormData(sf);
    try { await api("/api/sites", { method: "POST", body: { name: fd.get("name"), address: fd.get("address") } }); reload(); } catch (err) { toast(err.message); }
  };
  $app.querySelectorAll("[data-dev-form]").forEach((f) => (f.onsubmit = async (e) => {
    e.preventDefault(); const fd = new FormData(f);
    try {
      const d = await api("/api/devices", { method: "POST", body: { site_id: Number(f.dataset.devForm), name: fd.get("name") } });
      await reload(); showSecret(d.serial, d.secret);
    } catch (err) { toast(err.message); }
  }));
  $app.querySelectorAll("[data-interval]").forEach((sel) => (sel.onchange = async () => {
    try { await api(`/api/devices/${sel.dataset.interval}`, { method: "PATCH", body: { interval_seconds: Number(sel.value) } }); toast("Interval saved; the device picks it up on its next upload"); } catch (err) { toast(err.message); }
  }));
  $app.querySelectorAll("[data-rotate]").forEach((b) => (b.onclick = async () => {
    if (!confirm("Issue a new key? The device stops reporting until it is set up with the new key.")) return;
    try { const r = await api(`/api/devices/${b.dataset.rotate}/rotate-key`, { method: "POST" }); showSecret(r.serial, r.secret); } catch (err) { toast(err.message); }
  }));
  $app.querySelectorAll("[data-del-dev]").forEach((b) => (b.onclick = async () => {
    if (!confirm("Delete this device and ALL of its readings? This cannot be undone.")) return;
    try { await api(`/api/devices/${b.dataset.delDev}`, { method: "DELETE" }); reload(); } catch (err) { toast(err.message); }
  }));
  $app.querySelectorAll("[data-del-site]").forEach((b) => (b.onclick = async () => {
    if (!confirm("Delete this site?")) return;
    try { await api(`/api/sites/${b.dataset.delSite}`, { method: "DELETE" }); reload(); } catch (err) { toast(err.message); }
  }));
}

// --- Contacts ------------------------------------------------------------------------------------------------

async function viewContacts() {
  const [contacts, sites, cfg] = await Promise.all([api("/api/contacts"), api("/api/sites"), api("/api/config")]);
  const admin = isAdmin();
  const siteName = (id) => (id ? sites.find((s) => s.id === id)?.name || "?" : "All sites");
  const form = (c = {}) => `
    <form class="panel inline" id="contact-form" data-id="${c.id || ""}">
      <label>Name <input name="name" required value="${esc(c.name)}"></label>
      <label>Email <input name="email" type="email" value="${esc(c.email)}"></label>
      <label>Mobile <input name="phone" value="${esc(c.phone)}" placeholder="+923001234567"></label>
      <label>Channels <span class="checks">${["email", "whatsapp", "sms"].map((ch) => `<label class="checks"><input type="checkbox" name="ch_${ch}" ${(c.channels || ["email"]).includes(ch) ? "checked" : ""}>${ch}</label>`).join("")}</span></label>
      <label>Level <select name="level">${[1, 2, 3, 4].map((l) => `<option ${l === (c.level || 1) ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label>Site <select name="site_id"><option value="">All sites</option>${sites.map((s) => `<option value="${s.id}" ${s.id === c.site_id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>
      <label class="checks"><input type="checkbox" name="active" ${c.active === false ? "" : "checked"}> Active</label>
      <button>${c.id ? "Save" : "Add contact"}</button>${c.id ? `<button type="button" class="secondary" id="cancel">Cancel</button>` : ""}
    </form>`;
  $app.innerHTML = `
    <h1>Alert contacts</h1>
    <p class="muted">Level 1 is told first. If nobody acknowledges within ${cfg.escalation_minutes} minutes the alert escalates to level 2, then 3…
      Channels on this server: email ${esc(cfg.channels.email)}, WhatsApp ${esc(cfg.channels.whatsapp)}, SMS ${esc(cfg.channels.sms)}.</p>
    <div id="form-slot">${admin ? form() : ""}</div>
    <div class="panel table-wrap" style="margin-top:12px">${contacts.length ? `<table><tr><th>Level</th><th>Name</th><th>Email</th><th>Mobile</th><th>Channels</th><th>Site</th>${admin ? "<th></th>" : ""}</tr>
      ${contacts.map((c) => `<tr style="${c.active ? "" : "opacity:.5"}"><td>${c.level}</td><td>${esc(c.name)}</td><td>${esc(c.email)}</td><td>${esc(c.phone)}</td>
        <td>${c.channels.map((x) => `<span class="chip">${esc(x)}</span>`).join(" ")}</td><td>${esc(siteName(c.site_id))}</td>
        ${admin ? `<td class="row"><button class="secondary" data-test="${c.id}">Send test</button><button class="secondary" data-edit="${c.id}">Edit</button><button class="danger" data-del="${c.id}">Delete</button></td>` : ""}</tr>`).join("")}</table>`
      : `<p class="muted">No contacts yet — alerts will not reach anyone.</p>`}</div>`;

  const bindForm = () => {
    const f = document.getElementById("contact-form");
    if (!f) return;
    const cancel = document.getElementById("cancel");
    if (cancel) cancel.onclick = () => viewContacts();
    f.onsubmit = async (e) => {
      e.preventDefault(); const fd = new FormData(f);
      const body = {
        name: fd.get("name"), email: fd.get("email"), phone: fd.get("phone"), level: Number(fd.get("level")),
        site_id: fd.get("site_id") ? Number(fd.get("site_id")) : null, active: fd.get("active") === "on",
        channels: ["email", "whatsapp", "sms"].filter((ch) => fd.get(`ch_${ch}`) === "on"),
      };
      try {
        await api(f.dataset.id ? `/api/contacts/${f.dataset.id}` : "/api/contacts", { method: f.dataset.id ? "PUT" : "POST", body });
        toast("Saved"); viewContacts();
      } catch (err) { toast(err.message); }
    };
  };
  bindForm();
  $app.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => {
    document.getElementById("form-slot").innerHTML = form(contacts.find((c) => c.id === Number(b.dataset.edit)));
    bindForm(); window.scrollTo(0, 0);
  }));
  $app.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
    if (!confirm("Delete this contact?")) return;
    try { await api(`/api/contacts/${b.dataset.del}`, { method: "DELETE" }); viewContacts(); } catch (err) { toast(err.message); }
  }));
  $app.querySelectorAll("[data-test]").forEach((b) => (b.onclick = async () => {
    try {
      const r = await api(`/api/contacts/${b.dataset.test}/test`, { method: "POST" });
      toast(r.map((x) => `${x.channel}: ${x.ok ? "sent (" + x.provider + ")" : "failed — " + x.error}`).join(" · ") || "No channels");
    } catch (err) { toast(err.message); }
  }));
}

// --- Audit trail & users -------------------------------------------------------------------------------------

async function viewAudit() {
  const rows = await api("/api/audit?limit=500");
  $app.innerHTML = `<h1>Audit trail</h1><p class="muted">Every change to devices, limits, contacts and alerts, newest first. Entries cannot be edited or deleted from the dashboard.</p>
    <div class="panel table-wrap"><table><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr>
    ${rows.map((r) => `<tr><td>${fmtTime(r.at)}</td><td>${esc(r.actor)}</td><td><code>${esc(r.action)}</code></td><td>${esc(r.details)}</td></tr>`).join("")}</table></div>`;
}

async function viewUsers() {
  const users = await api("/api/users");
  $app.innerHTML = `<h1>Users</h1>
    <form class="panel inline" id="uf">
      <label>Email <input name="email" type="email" required></label>
      <label>Name <input name="full_name"></label>
      <label>Password <input name="password" type="password" minlength="8" required></label>
      <label>Role <select name="role"><option>OPERATOR</option><option>ADMIN</option></select></label>
      <button>Add user</button></form>
    <p class="meta">Operators can view everything and acknowledge alerts. Admins can also change devices, limits, contacts and users.</p>
    <div class="panel table-wrap"><table><tr><th>Email</th><th>Name</th><th>Role</th><th></th></tr>
    ${users.map((u) => `<tr><td>${esc(u.email)}</td><td>${esc(u.full_name)}</td><td>${esc(u.role)}</td>
      <td>${u.id !== state.user.id ? `<button class="danger" data-del="${u.id}">Delete</button>` : ""}</td></tr>`).join("")}</table></div>`;
  document.getElementById("uf").onsubmit = async (e) => {
    e.preventDefault(); const fd = new FormData(e.target);
    try { await api("/api/users", { method: "POST", body: Object.fromEntries(fd) }); viewUsers(); } catch (err) { toast(err.message); }
  };
  $app.querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => {
    if (!confirm("Delete this user?")) return;
    try { await api(`/api/users/${b.dataset.del}`, { method: "DELETE" }); viewUsers(); } catch (err) { toast(err.message); }
  }));
}

render();
refreshBadge();
