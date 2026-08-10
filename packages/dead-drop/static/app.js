/**
 * The dashboard page.
 *
 * It polls the read-only API that `ddrop dashboard` proxies from the control
 * socket and renders it. There is no build step: this file and the vendored
 * lume-js beside it are what the browser loads.
 *
 * Two rules run through everything below.
 *
 * 1. Say when a number is unknown. `read === 0` in a queue or peer report means
 *    "no store transport could be listed", which is not the same answer as
 *    "nothing is there". The CLI already exits 1 rather than print the
 *    reassuring line; the page hides the reassuring line and says why.
 * 2. Nothing is written with innerHTML. Peer names, channel names and log
 *    messages come from the workspace, so every one of them lands in a text
 *    node.
 */

import { state, effect, bindDom, batch } from '/lume.min.mjs';

const POLL_MS = 5000;

const store = state({
  version: '…',
  uptime: '…',
  peerId: '…',
  connection: 'connecting',
  connectionError: '',
  hideConnectionError: true,
  updatedAt: 'never',

  workspaces: [],
  workspace: '',

  waiting: '…',
  inflight: '…',
  retrying: '…',
  peerCount: '…',
  transportSummary: '…',
  pollInterval: '…',
  mailboxNote: '',

  queues: [],
  queuesProblem: '',
  hideQueuesProblem: true,
  hideQueuesTruncated: true,
  hideQueuesEmpty: true,

  peers: [],
  peersProblem: '',
  hidePeersProblem: true,
  hidePeersEmpty: true,

  transports: [],
  logs: [],
});

// ------------------------------------------------------------------ rendering

bindDom(document.body, store);

const connectionEl = document.getElementById('connection');
const workspaceEl = document.getElementById('workspace');

effect(() => {
  // A live figure that is quietly ten minutes old is worse than no figure, so
  // the indicator carries the state of the last poll, not of the page.
  connectionEl.className = `status ${store.connection === 'live' ? '' : 'down'}`.trim();
});

effect(() => {
  const names = store.workspaces;
  const selected = store.workspace;
  if (names.length === optionValues(workspaceEl).length && sameValues(names, workspaceEl)) {
    workspaceEl.value = selected;
    return;
  }
  workspaceEl.replaceChildren(
    ...names.map((name) => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      return option;
    }),
  );
  workspaceEl.value = selected;
});

effect(() => {
  fill('queues', store.queues, (queue) => [
    cell(queue.peerId + (queue.self ? '  (this peer)' : ''), 'mono'),
    cell(String(queue.count), 'num'),
    cell(bytes(queue.bytes), 'num'),
    cell(queue.oldestAt ? `${duration(Date.now() - queue.oldestAt)} ago` : 'unknown'),
  ]);
});

effect(() => {
  fill('peers', store.peers, (peer) => [
    cell(peer.peerId, 'mono'),
    cell(peer.services.join(', ') || '—'),
    cell(peer.exposures.join(', ') || '—'),
    cell(peer.announcedAt ? `${duration(Date.now() - peer.announcedAt)} ago` : 'unknown'),
  ]);
});

effect(() => {
  fill('transports', store.transports, (transport) => [
    cell(transport.name, 'mono'),
    cell(transport.kind),
    pill(transport.status, transport.message),
    cell(transport.breaker),
    cell(transport.score.toFixed(2), 'num'),
    cell(transport.latencyMs === undefined ? '?' : `${transport.latencyMs}ms`, 'num'),
    cell(`${Math.round(transport.errorRate * 100)}%`, 'num'),
  ]);
});

effect(() => {
  const list = document.getElementById('logs');
  list.replaceChildren(
    ...store.logs.map((record) => {
      const item = document.createElement('li');
      item.append(
        span('level ' + record.level, record.level),
        span('at', new Date(record.time).toLocaleTimeString()),
        span('message', record.message),
      );
      return item;
    }),
  );
});

function fill(id, items, cells) {
  const body = document.getElementById(id);
  body.replaceChildren(
    ...items.map((item) => {
      const row = document.createElement('tr');
      row.append(...cells(item));
      return row;
    }),
  );
}

function cell(text, className = '') {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function pill(status, message) {
  const td = document.createElement('td');
  const tone = status === 'healthy' ? 'ok' : status === 'degraded' ? 'warn' : 'bad';
  const badge = document.createElement('span');
  badge.className = `pill ${tone}`;
  badge.textContent = status;
  td.append(badge);
  // The health message is where a lazily-resolved transport reports a repo that
  // does not exist, so it belongs on screen rather than only in the log.
  if (message) {
    const detail = document.createElement('div');
    detail.className = 'note';
    detail.textContent = message;
    td.append(detail);
  }
  return td;
}

function span(className, text) {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = text;
  return element;
}

function optionValues(select) {
  return [...select.options].map((option) => option.value);
}

function sameValues(names, select) {
  return optionValues(select).every((value, index) => value === names[index]);
}

// ------------------------------------------------------------------- polling

/** Serialised values already in the store, so an unchanged table is not rebuilt. */
const rendered = {};
let busy = false;

/** Replaces an array or object only when it really changed. */
function put(key, value) {
  const encoded = JSON.stringify(value);
  if (rendered[key] === encoded) return;
  rendered[key] = encoded;
  store[key] = value;
}

async function read(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body?.error?.message ?? `the dashboard answered ${response.status}`);
  }
  return body;
}

/** A failed section reports itself rather than blanking the whole page. */
const asProblem = (error) => ({ problem: error.message });

async function poll() {
  if (busy) return;
  busy = true;
  try {
    const status = await read('/api/status');
    const names = status.workspaces.map((workspace) => workspace.name);
    const name = names.includes(store.workspace) ? store.workspace : (names[0] ?? '');
    const query = `?workspace=${encodeURIComponent(name)}`;
    const current = status.workspaces.find((workspace) => workspace.name === name);

    const [peers, queues, logs] = await Promise.all([
      read(`/api/peers${query}`).catch(asProblem),
      read(`/api/queues${query}`).catch(asProblem),
      read('/api/logs?limit=60').catch(() => ({ records: [] })),
    ]);

    batch(() => {
      store.version = status.version;
      store.uptime = duration(status.uptimeMs);
      store.connection = 'live';
      store.connectionError = '';
      store.hideConnectionError = true;
      store.updatedAt = new Date().toLocaleTimeString();
      put('workspaces', names);
      store.workspace = name;
      applyWorkspace(current);
      applyPeers(peers);
      applyQueues(queues);
      put('logs', [...(logs.records ?? [])].reverse());
    });
  } catch (error) {
    batch(() => {
      store.connection = 'unreachable';
      // Dating the figures matters more than the failure itself: a page left
      // open reads as live, and everything below it is as old as this stamp.
      store.connectionError =
        store.updatedAt === 'never'
          ? `${error.message} Nothing has been read yet.`
          : `${error.message} The figures below are from ${store.updatedAt}.`;
      store.hideConnectionError = false;
    });
  } finally {
    busy = false;
  }
}

function applyWorkspace(workspace) {
  if (!workspace) return;
  const healthy = workspace.transports.filter((entry) => entry.status === 'healthy').length;
  store.peerId = workspace.peerId;
  store.inflight = String(workspace.mailbox.inflight);
  store.retrying = String(workspace.mailbox.retrying);
  store.transportSummary = `${healthy}/${workspace.transports.length}`;
  store.pollInterval = `${workspace.mailbox.pollIntervalMs}ms`;
  store.mailboxNote =
    `concurrency ${workspace.mailbox.concurrency} · ` +
    `${workspace.mailbox.pendingChunkGroups} partial message(s) · ` +
    `${workspace.mailbox.dedupeSize} ids remembered` +
    (workspace.exposures.length ? ` · exposures: ${workspace.exposures.join(', ')}` : '') +
    (workspace.handlers.length ? ` · channels: ${workspace.handlers.join(', ')}` : '');
  put('transports', workspace.transports);
}

function applyPeers(report) {
  if (report.problem) {
    store.peersProblem = report.problem;
    store.hidePeersProblem = false;
    store.hidePeersEmpty = true;
    store.peerCount = '?';
    put('peers', []);
    return;
  }
  const known = report.read > 0;
  store.peersProblem = known
    ? unreadable(report.unreadable, 'A peer only these transports can see is missing below.')
    : `No store transport could be listed, so no peer can be seen. ${unreadable(report.unreadable, '')}`;
  store.hidePeersProblem = known && report.unreadable.length === 0;
  store.peerCount = known ? String(report.peers.length) : '?';
  // The empty line stays hidden when nothing could be read: "nobody has
  // announced" and "I could not look" are opposite answers that read alike.
  store.hidePeersEmpty = !known || report.peers.length > 0;
  put('peers', known ? report.peers : []);
}

function applyQueues(report) {
  if (report.problem) {
    store.queuesProblem = report.problem;
    store.hideQueuesProblem = false;
    store.hideQueuesEmpty = true;
    store.hideQueuesTruncated = true;
    store.waiting = '?';
    put('queues', []);
    return;
  }
  const known = report.read > 0;
  const rows = known
    ? report.queues.map((queue) => ({ ...queue, self: queue.peerId === report.peerId }))
    : [];
  store.queuesProblem = known
    ? unreadable(report.unreadable, 'The counts below leave out whatever they hold.')
    : `No store transport could be listed, so queue depth is unknown. ${unreadable(report.unreadable, '')}`;
  store.hideQueuesProblem = known && report.unreadable.length === 0;
  store.hideQueuesTruncated = !report.truncated;
  store.hideQueuesEmpty = !known || rows.length > 0;
  store.waiting = known ? String(rows.reduce((total, queue) => total + queue.count, 0)) : '?';
  put('queues', rows);
}

function unreadable(problems, suffix) {
  if (!problems || problems.length === 0) return suffix;
  const named = problems.map((problem) => `${problem.transport} (${problem.message})`).join('; ');
  return `Could not list ${named}. ${suffix}`.trim();
}

// -------------------------------------------------------------------- helpers

function duration(ms) {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function bytes(value) {
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(1)} ${units[unit]}`;
}

// ---------------------------------------------------------------------- wiring

workspaceEl.addEventListener('change', () => {
  store.workspace = workspaceEl.value;
  void poll();
});
document.getElementById('refresh').addEventListener('click', () => void poll());
// Each poll lists every store transport, which on git and github means a fetch.
// A tab nobody is looking at has no business spending that.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void poll();
});
setInterval(() => {
  if (!document.hidden) void poll();
}, POLL_MS);

void poll();
