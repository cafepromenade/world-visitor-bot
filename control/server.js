const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const crypto = require('crypto');

const PROJECT_DIR = process.env.PROJECT_DIR || path.resolve(__dirname, '..');
const PORT = parseInt(process.env.PORT || '80');
const PORT2 = parseInt(process.env.PORT2 || '3000');
const DOMAIN = process.env.DOMAIN || 'bigheados.com';
const BLUEMAP_PORT = '8100';
const MC_PORT = '25565';
const envPath = path.join(PROJECT_DIR, '.env');
const stateDir = path.join(PROJECT_DIR, 'state');
const logsDir = path.join(PROJECT_DIR, 'logs');
const bugWatcherDir = path.join(logsDir, 'bug-watcher');
const bugReportsDir = path.join(bugWatcherDir, 'reports');
const bugSessionsDir = path.join(bugWatcherDir, 'sessions');
const bugWorktreesDir = path.join(bugWatcherDir, 'worktrees');
const bugStatePath = path.join(bugWatcherDir, 'watcher-state.json');
const bluemapWebDir = path.join(PROJECT_DIR, 'web');
const bluemapMarkersJson = path.join(bluemapWebDir, 'maps', 'overworld', 'live', 'markers.json');
const bluemapBackupMarkersJson = path.join(bluemapWebDir, 'maps', 'overworld', 'live', 'bot-markers.backup.json');
const BOT_MARKER_SET = 'world-visitor-bots';
const BOT_BACKUP_MARKER_SET = 'world-visitor-bot-backups';
const COMPOSE_PROJECT = process.env.COMPOSE_PROJECT_NAME || path.basename(PROJECT_DIR);
const ALL_VISITOR_SERVICES = ['visitor', 'visitor1', 'visitor2', 'visitor3'];
const ALL_MANAGED_SERVICES = ['mc', ...ALL_VISITOR_SERVICES, 'bluemap'];
const PLAYER_NAME_RE = /^[A-Za-z0-9_]{1,16}$/;
const BUG_WATCHER_ENABLED = envFlag('BUG_WATCHER_ENABLED', true);
const BUG_WATCHER_INTERVAL_MS = Math.max(30000, parseInt(process.env.BUG_WATCHER_INTERVAL_MS || '60000', 10) || 60000);
const BUG_WATCHER_TREAT_WARNINGS = envFlag('BUG_WATCHER_TREAT_WARNINGS_AS_ERRORS', true);
const BUG_WATCHER_MAX_ATTEMPTS = Math.max(1, parseInt(process.env.BUG_WATCHER_MAX_ATTEMPTS || '5', 10) || 5);
const BUG_WATCHER_RETRY_DELAY_MS = Math.max(60000, parseInt(process.env.BUG_WATCHER_RETRY_DELAY_MS || '1800000', 10) || 1800000);
const OPENCODE_AUTOFIX = envFlag('OPENCODE_AUTOFIX', true);
const OPENCODE_SKIP_PERMISSIONS = envFlag('OPENCODE_SKIP_PERMISSIONS', true);
const OPENCODE_ALLOW_SUDO = envFlag('OPENCODE_ALLOW_SUDO', true);
const OPENCODE_AUTO_PR = envFlag('OPENCODE_AUTO_PR', true);
const OPENCODE_AUTO_PUSH = envFlag('OPENCODE_AUTO_PUSH', true);
const OPENCODE_CMD = process.env.OPENCODE_CMD || 'opencode';
const OPENCODE_TIMEOUT_MS = Math.max(60000, parseInt(process.env.OPENCODE_TIMEOUT_MS || '1800000', 10) || 1800000);
const BUG_WATCHER_AUTO_MERGE = envFlag('BUG_WATCHER_AUTO_MERGE', true);
const BUG_WATCHER_AUTO_MERGE_MS = Math.max(60000, parseInt(process.env.BUG_WATCHER_AUTO_MERGE_MS || '300000', 10) || 300000);
const BUG_WATCHER_MERGE_BRANCH = process.env.BUG_WATCHER_MERGE_BRANCH || 'main';

let etaData = { regionsStarted: 0, firstRegionAt: null, lastRegionAt: null, wpTotal: 0, wpDone: 0, wpStart: null };
let seenMcLogs = [];
let seenBmLogs = [];
let seenVisitorLogs = [];
let logBotStatuses = new Map();
let HOST_PROJECT_DIR = process.env.HOST_PROJECT_DIR || '';
let bugWatcherState = { queue: [], reports: [], completed: [], current: null, lastCheckAt: '', lastCheckLog: '', baseBranch: '' };
let bugWatcherRunning = false;
let bugAutoMergeRunning = false;
let bugWatcherWritable = true;
let activeBugWatcherChild = null;

function getLocalIP() {
  const provided = process.env.HOST_IP;
  if (provided) return provided;
  const candidates = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) candidates.push(address.address);
    }
  }
  return candidates.find(ip => !ip.startsWith('172.')) || candidates[0] || 'localhost';
}
const LOCAL_IP = getLocalIP();

function envFlag(name, defaultValue) {
  const value = process.env[name];
  if (value === undefined || value === '') return defaultValue;
  return !/^(0|false|no|off)$/i.test(String(value).trim());
}

function nowIso() {
  return new Date().toISOString();
}

function getConnectionInfo(status = {}) {
  const online = Boolean(status.mcOnline || status.mc === 'running');
  return { primary: DOMAIN, fallback: LOCAL_IP, port: MC_PORT, online };
}

function getBlueMapUrls() {
  return {
    primary: `http://${DOMAIN}:${BLUEMAP_PORT}`,
    fallback: `http://${LOCAL_IP}:${BLUEMAP_PORT}`,
    port: BLUEMAP_PORT,
    staticUrl: '/bluemap/'
  };
}

function getBotCount() {
  const parsed = parseInt(readEnv().BOT_COUNT || process.env.BOT_COUNT || '1', 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(1, Math.min(4, parsed));
}

function visitorServices(count = getBotCount()) {
  return ALL_VISITOR_SERVICES.slice(0, count);
}

function botStackServices(count = getBotCount()) {
  return ['mc', ...visitorServices(count)];
}

function composeProfile(count = getBotCount()) {
  return count > 1 ? '--profile multi ' : '';
}

function parseComposeStatus(out) {
  const status = out.trim().toLowerCase();
  if (!status) return 'stopped';
  if (status.includes('health: starting') || status.includes('starting')) return 'starting';
  if (status.includes('up')) return 'running';
  return 'stopped';
}

function aggregateComposeStatus(out) {
  const statuses = out.split('\n').filter(Boolean).map(parseComposeStatus);
  if (statuses.includes('running')) return 'running';
  if (statuses.includes('starting')) return 'starting';
  return 'stopped';
}

function compose(args) {
  const cmd = `docker compose --project-directory ${PROJECT_DIR} ${args}`;
  console.log(`[compose] ${cmd}`);
  return new Promise(resolve => {
    const env = { ...process.env, HOST_PROJECT_DIR: HOST_PROJECT_DIR || PROJECT_DIR };
    const cfg = readEnv();
    if (cfg.WORLD_PATH && !path.isAbsolute(cfg.WORLD_PATH)) env.WORLD_PATH = path.join(env.HOST_PROJECT_DIR, cfg.WORLD_PATH);
    exec(cmd, { timeout: 180000, maxBuffer: 1024*1024*10, env }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout||'', stderr: stderr||'' });
    });
  });
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function gitSafe(dir, args) {
  return `git -c safe.directory=${shQuote(path.resolve(dir))} ${args}`;
}

function run(cmd, quiet) {
  if (!quiet) console.log(`[run] ${cmd}`);
  return new Promise(resolve => {
    exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout||'', stderr: stderr||'' });
    });
  });
}

function runShell(cmd, options = {}) {
  const timeout = options.timeout || 180000;
  const cwd = options.cwd || PROJECT_DIR;
  const env = options.env || process.env;
  return new Promise(resolve => {
    exec(cmd, { cwd, env, timeout, maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code || 0, stdout: stdout || '', stderr: stderr || '', cmd });
    });
  });
}

function appendSession(file, text) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, text);
}

async function runShellLogged(cmd, options = {}) {
  const logFile = options.logFile;
  if (logFile) appendSession(logFile, `\n$ ${cmd}\n`);
  const result = await runShell(cmd, options);
  if (logFile) {
    appendSession(logFile, result.stdout || '');
    appendSession(logFile, result.stderr || '');
    appendSession(logFile, `\n[exit ${result.ok ? 0 : result.code || 1}]\n`);
  }
  return result;
}

async function ensureGitSafeDirectory(dir, logFile = '') {
  const full = path.resolve(dir);
  const list = await runShell('git config --global --get-all safe.directory', { cwd: PROJECT_DIR, timeout: 30000 });
  const known = list.stdout.split(/\r?\n/).map(line => path.resolve(line.trim())).filter(Boolean);
  if (known.includes(full)) return;
  const add = await runShell(`git config --global --add safe.directory ${shQuote(full)}`, { cwd: PROJECT_DIR, timeout: 30000 });
  if (!add.ok && logFile) appendSession(logFile, `\n[git] global safe.directory is not writable for ${full}; per-command safe.directory will be used.\n`);
}

function spawnLogged(command, args, options = {}) {
  const logFile = options.logFile;
  if (logFile) appendSession(logFile, `\n$ ${[command, ...args].map(shQuote).join(' ')}\n`);
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: options.cwd || PROJECT_DIR, env: options.env || process.env, shell: false, detached: false });
    if (options.onChild) options.onChild(child);
    let output = '';
    let timedOut = false;
    let killTimer = null;
    const killChild = signal => {
      try { child.kill(signal); } catch {}
    };
    const onData = data => {
      const text = data.toString();
      output += text;
      if (logFile) appendSession(logFile, text);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      timedOut = true;
      if (logFile) appendSession(logFile, `\n[timed out after ${options.timeout || OPENCODE_TIMEOUT_MS}ms]\n`);
      killChild('SIGTERM');
      killTimer = setTimeout(() => {
        if (logFile) appendSession(logFile, '\n[timeout] forcing process group stop\n');
        killChild('SIGKILL');
      }, 10000);
      if (killTimer.unref) killTimer.unref();
    }, options.timeout || OPENCODE_TIMEOUT_MS);
    child.on('error', err => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (logFile) appendSession(logFile, `\n[spawn failed] ${err.message}\n`);
      resolve({ ok: false, code: 1, stdout: output, stderr: err.message, timedOut });
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (logFile) appendSession(logFile, `\n[exit ${code}]\n`);
      resolve({ ok: code === 0, code, stdout: output, stderr: '', timedOut });
    });
  });
}

function prepareWritableDirs() {
  const dirs = ['data', 'web', 'state', 'config'].map(d => shQuote(path.join(PROJECT_DIR, d))).join(' ');
  const cmd = `mkdir -p ${dirs} && chown -R 1000:1000 ${dirs} 2>/dev/null || true; chmod -R u+rwX,g+rwX ${dirs} 2>/dev/null || true`;
  console.log('[run] preparing writable BlueMap/bot directories');
  return new Promise(resolve => {
    exec(cmd, { timeout: 180000, maxBuffer: 1024*1024*10 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout||'', stderr: stderr||'' });
    });
  });
}

async function resolveHostProjectDir() {
  if (HOST_PROJECT_DIR && HOST_PROJECT_DIR !== '.') return HOST_PROJECT_DIR;
  const id = process.env.HOSTNAME || '';
  if (!id) return PROJECT_DIR;
  const { stdout } = await run(`docker inspect ${shQuote(id)} --format '{{json .Mounts}}' 2>/dev/null`, true);
  try {
    const mounts = JSON.parse(stdout.trim() || '[]');
    const match = mounts.find(m => m.Destination === PROJECT_DIR || PROJECT_DIR.startsWith(`${m.Destination}/`));
    if (match?.Source) {
      const suffix = PROJECT_DIR === match.Destination ? '' : PROJECT_DIR.slice(match.Destination.length);
      HOST_PROJECT_DIR = `${match.Source}${suffix}`;
      process.env.HOST_PROJECT_DIR = HOST_PROJECT_DIR;
      console.log(`[run] host project dir: ${HOST_PROJECT_DIR}`);
      return HOST_PROJECT_DIR;
    }
  } catch {}
  HOST_PROJECT_DIR = PROJECT_DIR;
  process.env.HOST_PROJECT_DIR = HOST_PROJECT_DIR;
  return HOST_PROJECT_DIR;
}

async function commandExists(bin) {
  const result = await runShell(`command -v ${shQuote(bin)} >/dev/null 2>&1`, { timeout: 10000 });
  return result.ok;
}

async function installMissingDependencies() {
  const required = ['git', 'node', 'npm', 'docker', 'unzip'];
  if (OPENCODE_AUTO_PR) required.push('gh');
  if (OPENCODE_ALLOW_SUDO && process.getuid && process.getuid() !== 0) required.push('sudo');
  const missing = [];
  for (const bin of required) if (!(await commandExists(bin))) missing.push(bin);
  if (missing.length) {
    const aptNames = missing.map(bin => bin === 'docker' ? 'docker-ce-cli' : bin).join(' ');
    const prefix = process.getuid && process.getuid() === 0 ? '' : OPENCODE_ALLOW_SUDO ? 'sudo ' : '';
    if (prefix || (process.getuid && process.getuid() === 0)) {
      await runShell(`${prefix}apt-get update && ${prefix}apt-get install -y --no-install-recommends ${aptNames}`, { timeout: 300000 });
    }
  }
  const localOpenCode = path.join(__dirname, 'node_modules', '.bin', 'opencode');
  if (!fs.existsSync(localOpenCode) && !(await commandExists(OPENCODE_CMD))) {
    const prefix = process.getuid && process.getuid() === 0 ? '' : OPENCODE_ALLOW_SUDO ? 'sudo ' : '';
    await runShell(`${prefix}npm install -g opencode-ai`, { timeout: 300000 });
  }
}

function isTcpOpen(host, port, timeout = 1200) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port, timeout }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

async function getServiceStatusByLabel(service, quiet) {
  const filters = `--filter ${shQuote(`label=com.docker.compose.project=${COMPOSE_PROJECT}`)} --filter ${shQuote(`label=com.docker.compose.service=${service}`)}`;
  const { stdout } = await run(`docker ps -a ${filters} --format '{{.Status}}' 2>/dev/null`, quiet);
  return aggregateComposeStatus(stdout);
}

async function getServiceContainerByLabel(service, quiet) {
  const filters = `--filter ${shQuote(`label=com.docker.compose.project=${COMPOSE_PROJECT}`)} --filter ${shQuote(`label=com.docker.compose.service=${service}`)}`;
  const { stdout } = await run(`docker ps -a ${filters} --format '{{.Names}}' 2>/dev/null`, quiet);
  return stdout.trim().split('\n').filter(Boolean)[0] || '';
}

async function getManagedContainerNames(quiet) {
  const names = [];
  for (const service of ALL_MANAGED_SERVICES) {
    const filters = `--filter ${shQuote(`label=com.docker.compose.project=${COMPOSE_PROJECT}`)} --filter ${shQuote(`label=com.docker.compose.service=${service}`)}`;
    const { stdout } = await run(`docker ps -a ${filters} --format '{{.Names}}' 2>/dev/null`, quiet);
    names.push(...stdout.trim().split('\n').filter(Boolean));
  }
  return [...new Set(names)];
}

async function getContainerWritableBytes(names, quiet) {
  if (!names.length) return 0;
  const { stdout } = await run(`docker inspect --size --format '{{.SizeRw}}' ${names.map(shQuote).join(' ')} 2>/dev/null`, quiet);
  return stdout.split('\n').reduce((sum, line) => sum + (parseInt(line, 10) || 0), 0);
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function safeSlug(value, fallback = 'task') {
  return String(value || fallback).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 52) || fallback;
}

function safeBranchName(value, fallback = 'task') {
  const parts = String(value || '').split('/').map(part => safeSlug(part, fallback)).filter(Boolean);
  const branch = (parts.length ? parts : ['autofix', safeSlug(fallback, 'task')]).join('/');
  return branch.includes('/') ? branch : `autofix/${branch}`;
}

function normalizeTaskBranch(task) {
  if (!task) return;
  const fallback = `${task.title || 'task'}-${hashText(task.signature || task.id || task.title || 'task').slice(0, 10)}`;
  const next = safeBranchName(task.branch || `autofix/${safeSlug(fallback)}`, fallback);
  if (task.branch === next) return;
  const previous = task.branch;
  task.branch = next;
  for (const reportId of task.reportIds || []) {
    const report = bugWatcherState.reports.find(r => r.id === reportId);
    if (report?.branch === previous) report.branch = next;
  }
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function sessionStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function normalizeBugState() {
  bugWatcherState.queue = Array.isArray(bugWatcherState.queue) ? bugWatcherState.queue : [];
  bugWatcherState.reports = Array.isArray(bugWatcherState.reports) ? bugWatcherState.reports : [];
  bugWatcherState.completed = Array.isArray(bugWatcherState.completed) ? bugWatcherState.completed : [];
  [bugWatcherState.current, ...bugWatcherState.queue, ...bugWatcherState.completed].filter(Boolean).forEach(normalizeTaskBranch);
  if (bugWatcherState.current && ['completed', 'failed'].includes(bugWatcherState.current.status)) {
    bugWatcherState.completed.push(bugWatcherState.current);
    bugWatcherState.current = null;
  }
  if (bugWatcherState.current?.status === 'running') {
    if ((bugWatcherState.current.attempts || 0) >= BUG_WATCHER_MAX_ATTEMPTS) {
      bugWatcherState.current.status = 'failed';
      bugWatcherState.current.summary = `Stopped during a site restart after ${bugWatcherState.current.attempts || 0} attempts.`;
      bugWatcherState.current.updatedAt = nowIso();
      bugWatcherState.completed.push(bugWatcherState.current);
      updateReportsForTask(bugWatcherState.current, 'failed', { finishedAt: nowIso() });
    } else {
      bugWatcherState.current.status = 'retry';
      bugWatcherState.current.nextRetryAt = new Date(Date.now() + BUG_WATCHER_RETRY_DELAY_MS).toISOString();
      bugWatcherState.queue.unshift(bugWatcherState.current);
    }
    bugWatcherState.current = null;
  }
  dedupeBugQueue();
  const seenCompleted = new Set();
  bugWatcherState.completed = bugWatcherState.completed.filter(task => {
    if (!task?.id || seenCompleted.has(task.id)) return false;
    seenCompleted.add(task.id);
    return true;
  });
  bugWatcherState.completed = bugWatcherState.completed.slice(-100);
  bugWatcherState.current = bugWatcherState.current || null;
}

function retryDueMs(task) {
  if (!task?.nextRetryAt) return 0;
  const retryAt = Date.parse(task.nextRetryAt);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : 0;
}

function isBugTaskRunnable(task) {
  if (!task) return false;
  if (task.status === 'queued') return true;
  if (task.status !== 'retry') return false;
  return retryDueMs(task) <= 0;
}

function scheduleBugTaskRetry(task) {
  task.status = 'retry';
  task.nextRetryAt = new Date(Date.now() + BUG_WATCHER_RETRY_DELAY_MS).toISOString();
  task.updatedAt = nowIso();
}

function relatedTaskKey(task) {
  if (!task) return '';
  return `${task.source || 'watcher'}:${safeSlug(task.title || task.signature || 'task')}`;
}

function dedupeBugQueue() {
  const byKey = new Map();
  const next = [];
  for (const task of bugWatcherState.queue) {
    if (!task || ['completed', 'failed'].includes(task.status)) continue;
    const key = relatedTaskKey(task);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, task);
      next.push(task);
      continue;
    }
    existing.details = `${existing.details || ''}\n\nRelated queued task ${task.id}:\n${task.details || ''}`.slice(-16000);
    existing.reportIds = [...new Set([...(existing.reportIds || []), ...(task.reportIds || [])])];
    existing.updatedAt = nowIso();
    for (const reportId of task.reportIds || []) {
      updateReport(reportId, { taskId: existing.id, branch: existing.branch, status: existing.status || 'queued' });
      addReportComment(reportId, `Merged into related queued task ${existing.id} on branch ${existing.branch}.`, 'info');
    }
  }
  bugWatcherState.queue = next;
  mergeQueuedTasksIntoBatch();
}

function severityRank(severity) {
  return { critical: 4, error: 3, warning: 2, feature: 1 }[String(severity || '').toLowerCase()] || 1;
}

function mergeQueuedTasksIntoBatch() {
  const candidates = bugWatcherState.queue.filter(t => t && isBugTaskRunnable(t) && t.source !== 'health-check');
  if (candidates.length <= 1) return;
  let batch = candidates.find(t => t.source === 'batch');
  const now = nowIso();
  if (!batch) {
    const first = candidates[0];
    batch = first;
    batch.source = 'batch';
    batch.title = `Batch: ${candidates.length} queued fixes`;
    batch.signature = `batch:${Date.now()}:${hashText(candidates.map(t => t.id).join('|')).slice(0, 8)}`;
    batch.branch = `autofix/batch-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${hashText(candidates.map(t => t.branch).join('|')).slice(0, 8)}`;
    batch.status = 'queued';
  }
  const merged = [batch, ...candidates.filter(t => t.id !== batch.id)];
  batch.title = `Batch: ${merged.length} queued fixes`;
  batch.severity = merged.reduce((max, t) => severityRank(t.severity) > severityRank(max) ? t.severity : max, batch.severity || 'feature');
  batch.status = 'queued';
  batch.attempts = Math.max(0, ...merged.map(t => t.attempts || 0));
  delete batch.nextRetryAt;
  batch.reportIds = [...new Set(merged.flatMap(t => t.reportIds || []))];
  batch.details = merged.map(t => [
    `Task ${t.id}: ${t.title}`,
    `Severity: ${t.severity}`,
    `Source: ${t.source}`,
    `Original branch: ${t.branch}`,
    '',
    t.details || ''
  ].join('\n')).join('\n\n---\n\n').slice(-24000);
  batch.updatedAt = now;
  for (const task of merged) {
    for (const reportId of task.reportIds || []) {
      updateReport(reportId, { taskId: batch.id, branch: batch.branch, status: 'queued' });
      if (task.id !== batch.id) addReportComment(reportId, `Merged queued task ${task.id} into batch branch ${batch.branch} so multiple requests are processed together.`, 'info');
    }
  }
  const mergedIds = new Set(merged.map(t => t.id));
  bugWatcherState.queue = [batch, ...bugWatcherState.queue.filter(t => !mergedIds.has(t.id) && t.source === 'health-check')];
}

function findAnyTaskById(id) {
  if (!id) return null;
  if (bugWatcherState.current?.id === id) return bugWatcherState.current;
  return bugWatcherState.queue.find(t => t.id === id) || bugWatcherState.completed.find(t => t.id === id) || null;
}

function taskElapsedMs(task) {
  const start = Date.parse(task?.startedAt || task?.requeuedAt || task?.createdAt || '');
  if (!start) return 0;
  const end = Date.parse(task.finishedAt || task.mergedAt || (['completed', 'failed'].includes(task.status) ? task.updatedAt : '') || '') || Date.now();
  return Math.max(0, end - start);
}

function averageTaskMs() {
  const durations = bugWatcherState.completed
    .map(taskElapsedMs)
    .filter(ms => ms >= 30000 && ms <= OPENCODE_TIMEOUT_MS + 600000)
    .sort((a, b) => a - b);
  if (!durations.length) return Math.min(OPENCODE_TIMEOUT_MS, 15 * 60 * 1000);
  return durations[Math.floor(durations.length / 2)];
}

function enrichTaskEstimate(task, queueIndex = -1, currentRemaining = 0, avgMs = averageTaskMs()) {
  const elapsedMs = taskElapsedMs(task);
  const estimate = { elapsedMs };
  if (task.status === 'running') {
    const remaining = Math.max(60000, avgMs - elapsedMs);
    estimate.estimatedResolvedAt = new Date(Date.now() + remaining).toISOString();
    estimate.estimatedSeconds = Math.round(remaining / 1000);
  } else if (queueIndex >= 0) {
    const startIn = Math.max(currentRemaining + avgMs * queueIndex, retryDueMs(task));
    const resolvedIn = startIn + avgMs;
    estimate.estimatedStartAt = new Date(Date.now() + startIn).toISOString();
    estimate.estimatedResolvedAt = new Date(Date.now() + resolvedIn).toISOString();
    estimate.estimatedSeconds = Math.round(resolvedIn / 1000);
  }
  return estimate;
}

function saveBugWatcherState() {
  if (!bugWatcherWritable) return;
  try {
    ensureDir(bugWatcherDir);
    writeJson(bugStatePath, bugWatcherState);
  } catch (err) {
    bugWatcherWritable = false;
    console.error(`[bug-watcher] storage unavailable: ${err.message}`);
  }
}

function initBugWatcherState() {
  try {
    [logsDir, bugWatcherDir, bugReportsDir, bugSessionsDir, bugWorktreesDir].forEach(ensureDir);
    bugWatcherState = readJson(bugStatePath, bugWatcherState);
    normalizeBugState();
    saveBugWatcherState();
  } catch (err) {
    bugWatcherWritable = false;
    console.error(`[bug-watcher] storage unavailable: ${err.message}`);
  }
}

function publicBugTask(task, estimate = {}) {
  if (!task) return null;
  return {
    id: task.id,
    title: task.title,
    severity: task.severity,
    source: task.source,
    status: task.status,
    attempts: task.attempts || 0,
    branch: task.branch,
    prUrl: task.prUrl || '',
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    summary: task.summary || '',
    cause: task.cause || '',
    mergeStatus: task.mergeStatus || '',
    mergeAfter: task.mergeAfter || '',
    mergedAt: task.mergedAt || '',
    mergeTarget: task.mergeTarget || '',
    mergeRejected: Boolean(task.mergeRejected),
    startedAt: task.startedAt || '',
    requeuedAt: task.requeuedAt || '',
    finishedAt: task.finishedAt || '',
    nextRetryAt: task.nextRetryAt || '',
    retryInMs: retryDueMs(task),
    elapsedMs: estimate.elapsedMs || taskElapsedMs(task),
    estimatedStartAt: estimate.estimatedStartAt || '',
    estimatedResolvedAt: estimate.estimatedResolvedAt || '',
    estimatedSeconds: estimate.estimatedSeconds || 0,
    sessionLog: task.sessionLog ? path.relative(PROJECT_DIR, task.sessionLog) : '',
    agentFile: task.agentFile || '',
    details: String(task.details || '').slice(0, 1800)
  };
}

function publicBugReport(report, task = findAnyTaskById(report?.taskId)) {
  if (!report) return null;
  const estimate = task ? enrichTaskEstimate(task) : { elapsedMs: 0 };
  return {
    id: report.id,
    title: report.title,
    severity: report.severity,
    status: report.status || 'queued',
    approval: report.approval || '',
    approvedAt: report.approvedAt || '',
    processingAt: report.processingAt || '',
    finishedAt: report.finishedAt || '',
    taskId: report.taskId || '',
    branch: report.branch || '',
    prUrl: report.prUrl || '',
    sessionLog: report.sessionLog || '',
    agentFile: report.agentFile || '',
    cause: report.cause || '',
    summary: report.summary || '',
    mergeStatus: report.mergeStatus || '',
    mergeAfter: report.mergeAfter || '',
    nextRetryAt: report.nextRetryAt || '',
    mergedAt: report.mergedAt || '',
    mergeRejected: Boolean(report.mergeRejected),
    elapsedMs: estimate.elapsedMs || 0,
    estimatedStartAt: estimate.estimatedStartAt || '',
    estimatedResolvedAt: estimate.estimatedResolvedAt || '',
    comments: Array.isArray(report.comments) ? report.comments.slice(-10) : [],
    publicIpv4: report.publicIpv4 || '',
    observedIpv4: report.observedIpv4 || '',
    createdAt: report.createdAt,
    updatedAt: report.updatedAt || report.createdAt
  };
}

function getBugWatcherPublicStatus() {
  dedupeBugQueue();
  const avgMs = averageTaskMs();
  const currentEstimate = bugWatcherState.current ? enrichTaskEstimate(bugWatcherState.current, -1, 0, avgMs) : { estimatedSeconds: 0 };
  const currentRemaining = bugWatcherState.current ? Math.max(60000, (currentEstimate.estimatedSeconds || 0) * 1000) : 0;
  return {
    enabled: BUG_WATCHER_ENABLED,
    autoFix: OPENCODE_AUTOFIX,
    autoPush: OPENCODE_AUTO_PUSH,
    autoPr: OPENCODE_AUTO_PR,
    autoMerge: BUG_WATCHER_AUTO_MERGE,
    autoMergeMs: BUG_WATCHER_AUTO_MERGE_MS,
    mergeBranch: BUG_WATCHER_MERGE_BRANCH,
    maxAttempts: BUG_WATCHER_MAX_ATTEMPTS,
    retryDelayMs: BUG_WATCHER_RETRY_DELAY_MS,
    processor: 'opencode --prompt',
    storageWritable: bugWatcherWritable,
    skipPermissions: OPENCODE_SKIP_PERMISSIONS,
    sudo: OPENCODE_ALLOW_SUDO,
    treatWarningsAsErrors: BUG_WATCHER_TREAT_WARNINGS,
    intervalMs: BUG_WATCHER_INTERVAL_MS,
    running: bugWatcherRunning,
    current: publicBugTask(bugWatcherState.current, currentEstimate),
    queue: bugWatcherState.queue.map((task, i) => publicBugTask(task, enrichTaskEstimate(task, i, currentRemaining, avgMs))),
    failed: bugWatcherState.completed.filter(task => task.status === 'failed').slice(-40).reverse().map(task => publicBugTask(task, enrichTaskEstimate(task, -1, 0, avgMs))),
    completed: bugWatcherState.completed.slice(-20).reverse().map(task => publicBugTask(task, enrichTaskEstimate(task, -1, 0, avgMs))),
    reports: bugWatcherState.reports.slice(-40).reverse().map(report => publicBugReport(report)),
    lastCheckAt: bugWatcherState.lastCheckAt || '',
    lastCheckLog: bugWatcherState.lastCheckLog || ''
  };
}

function enqueueBugTask(input) {
  const title = String(input.title || 'Automated bug watcher task').trim().slice(0, 160);
  const details = String(input.details || '').trim();
  const signature = input.signature || (input.source === 'bug-report'
    ? `report:${safeSlug(title)}`
    : hashText(`${input.source || 'unknown'}\n${title}\n${details.replace(/\d{4}-\d{2}-\d{2}T[^\n]+/g, '<date>').slice(0, 4000)}`));
  const existing = [bugWatcherState.current, ...bugWatcherState.queue].filter(Boolean).find(t => t.signature === signature && !['completed', 'failed'].includes(t.status));
  if (existing) {
    existing.updatedAt = nowIso();
    existing.details = `${existing.details || ''}\n\nRelated occurrence at ${existing.updatedAt}:\n${details}`.trim().slice(-12000);
    existing.relatedCount = (existing.relatedCount || 1) + 1;
    if (input.reportId && !existing.reportIds?.includes(input.reportId)) {
      existing.reportIds = [...(existing.reportIds || []), input.reportId];
    }
    if (input.branch && !existing.branch) existing.branch = input.branch;
    normalizeTaskBranch(existing);
    saveBugWatcherState();
    return existing;
  }
  const short = hashText(signature).slice(0, 10);
  const task = {
    id: `${Date.now()}-${short}`,
    source: input.source || 'watcher',
    title,
    severity: input.severity || 'error',
    signature,
    branch: safeBranchName(input.branch || `autofix/${safeSlug(title)}-${short}`, title),
    status: 'queued',
    attempts: 0,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    details,
    reportIds: input.reportId ? [input.reportId] : []
  };
  bugWatcherState.queue.push(task);
  saveBugWatcherState();
  return task;
}

function findTaskById(id) {
  if (!id) return null;
  if (bugWatcherState.current?.id === id) return bugWatcherState.current;
  return bugWatcherState.queue.find(t => t.id === id) || null;
}

function attachFeedbackToTask(task, report, comment) {
  task.updatedAt = nowIso();
  task.details = `${task.details || ''}\n\nUser feedback on report ${report.id} at ${comment.at}:\n${comment.message}`.trim().slice(-16000);
  if (!task.reportIds?.includes(report.id)) task.reportIds = [...(task.reportIds || []), report.id];
  saveBugWatcherState();
}

function saveBugReport(report) {
  if (!bugWatcherWritable) return;
  try {
    ensureDir(bugReportsDir);
    writeJson(path.join(bugReportsDir, `${report.id}.json`), report);
  } catch (err) {
    bugWatcherWritable = false;
    console.error(`[bug-watcher] report storage unavailable: ${err.message}`);
  }
}

function updateReport(reportId, updates) {
  const idx = bugWatcherState.reports.findIndex(r => r.id === reportId);
  if (idx < 0) return null;
  const next = { ...bugWatcherState.reports[idx], ...updates, updatedAt: nowIso() };
  bugWatcherState.reports[idx] = next;
  saveBugReport(next);
  saveBugWatcherState();
  return next;
}

function addReportComment(reportId, message, kind = 'info') {
  const report = bugWatcherState.reports.find(r => r.id === reportId);
  if (!report) return null;
  const comments = Array.isArray(report.comments) ? report.comments : [];
  const comment = typeof message === 'object' && message ? { at: nowIso(), kind, ...message } : { at: nowIso(), kind, message };
  return updateReport(reportId, { comments: [...comments, comment].slice(-50) });
}

function updateReportsForTask(task, status, updates = {}) {
  for (const reportId of task.reportIds || []) {
    const report = updateReport(reportId, {
      status,
      taskId: task.id,
      branch: task.branch,
      prUrl: task.prUrl || '',
      sessionLog: task.sessionLog ? path.relative(PROJECT_DIR, task.sessionLog) : '',
      agentFile: task.agentFile || '',
      cause: task.cause || '',
      summary: task.summary || '',
      attempts: task.attempts || 0,
      ...updates
    });
    if (report) {
      const label = status === 'processing' ? 'Processing started or continued.' : status === 'finished' ? `Finished: ${task.summary || 'automated repair completed'}` : status === 'failed' ? `Failed: ${task.summary || 'automated repair did not finish'}` : `Status changed to ${status}.`;
      addReportComment(reportId, `${label} Branch: ${task.branch}. Next improvement: review the generated branch/PR and add a regression test if this issue can repeat.`, status === 'failed' ? 'error' : status === 'finished' ? 'done' : 'info');
    }
  }
}

function extractIpv4(value) {
  const text = String(value || '');
  const match = text.match(/(?:^|[^\d])((?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3})(?:[^\d]|$)/);
  return match ? match[1] : '';
}

function requestIpv4(req) {
  const candidates = [
    req.headers['cf-connecting-ip'],
    req.headers['x-real-ip'],
    req.headers['x-forwarded-for'],
    req.socket?.remoteAddress,
    req.ip
  ];
  for (const candidate of candidates) {
    const ip = extractIpv4(candidate);
    if (ip) return ip;
  }
  return '';
}

function fetchServerPublicIpv4(timeout = 3500) {
  return new Promise(resolve => {
    const req = https.get('https://api.ipify.org?format=json', { timeout }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try { resolve(extractIpv4(JSON.parse(body).ip)); }
        catch { resolve(extractIpv4(body)); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.on('error', () => resolve(''));
  });
}

function appendChangelogEntry(entry, dir = PROJECT_DIR) {
  const file = path.join(dir, 'CHANGELOG.json');
  const current = readJson(file, []);
  const list = Array.isArray(current) ? current : [];
  const item = {
    date: entry.date || nowIso(),
    severity: entry.severity || 'feature',
    title: entry.title || 'Update',
    summary: entry.summary || '',
    cause: entry.cause || '',
    fixed: Array.isArray(entry.fixed) ? entry.fixed : [],
    features: Array.isArray(entry.features) ? entry.features : [],
    comments: Array.isArray(entry.comments) ? entry.comments : [],
    branch: entry.branch || '',
    prUrl: entry.prUrl || '',
    sessionLog: entry.sessionLog || '',
    agentFile: entry.agentFile || ''
  };
  const next = [item, ...list].slice(0, 200);
  writeJson(file, next);
  return item;
}

function appendRuntimeChangelogEntry(entry) {
  const file = path.join(logsDir, 'changelog.json');
  const current = readJson(file, []);
  const list = Array.isArray(current) ? current : [];
  const item = {
    date: entry.date || nowIso(),
    severity: entry.severity || 'fix',
    title: entry.title || 'Automated fix',
    summary: entry.summary || '',
    cause: entry.cause || '',
    fixed: Array.isArray(entry.fixed) ? entry.fixed : [],
    features: Array.isArray(entry.features) ? entry.features : [],
    comments: Array.isArray(entry.comments) ? entry.comments : [],
    branch: entry.branch || '',
    prUrl: entry.prUrl || '',
    sessionLog: entry.sessionLog || '',
    agentFile: entry.agentFile || ''
  };
  writeJson(file, [item, ...list].slice(0, 500));
  return item;
}

function readChangelog() {
  const tracked = readJson(path.join(PROJECT_DIR, 'CHANGELOG.json'), []);
  const runtime = readJson(path.join(logsDir, 'changelog.json'), []);
  return [...(Array.isArray(runtime) ? runtime : []), ...(Array.isArray(tracked) ? tracked : [])]
    .sort((a, b) => Date.parse(b.date || 0) - Date.parse(a.date || 0))
    .slice(0, 200);
}

async function getBlueMapMode(status, quiet) {
  if (await isTcpOpen('mc', parseInt(BLUEMAP_PORT, 10))) return 'web';
  const container = await getServiceContainerByLabel('bluemap', quiet);
  if (!container || status.bluemap !== 'running') return '';
  const { stdout } = await run(`docker inspect --format '{{json .Config.Cmd}}' ${shQuote(container)} 2>/dev/null`, quiet);
  let cmd = [];
  try { cmd = JSON.parse(stdout.trim() || '[]'); } catch {}
  return cmd.includes('-w') ? 'web' : 'cli';
}

async function getBlueMapInfo(status, quiet) {
  const urls = getBlueMapUrls();
  const staticAvailable = fs.existsSync(path.join(bluemapWebDir, 'index.html'));
  const mode = await getBlueMapMode(status, quiet);
  if (mode === 'web') {
    return { available: true, mode, label: 'Live BlueMap', ...urls };
  }
  if (mode === 'cli') {
    return { available: staticAvailable, mode, label: 'CLI BlueMap render output', ...urls };
  }
  if (staticAvailable) {
    return { available: true, mode: 'static', label: 'Last BlueMap render output', ...urls };
  }
  return { available: false, mode: 'none', label: 'BlueMap is not available yet', ...urls };
}

async function getStatus(quiet) {
  const [mc, vis, bmLabel] = await Promise.all([
    run(`docker compose --project-directory ${PROJECT_DIR} ps mc --format '{{.Status}}' 2>/dev/null`, quiet),
    run(`docker compose --project-directory ${PROJECT_DIR} ps ${ALL_VISITOR_SERVICES.join(' ')} --format '{{.Status}}' 2>/dev/null`, quiet),
    getServiceStatusByLabel('bluemap', quiet),
  ]);
  let mcStatus = parseComposeStatus(mc.stdout);
  const mcOnline = mcStatus === 'running' && await isTcpOpen('mc', 25565);
  if (mcStatus === 'running' && !mcOnline) mcStatus = 'starting';
  const liveBlueMap = await isTcpOpen('mc', parseInt(BLUEMAP_PORT, 10));
  return { mc: mcStatus, mcOnline: mcOnline && mcStatus === 'running', visitor: aggregateComposeStatus(vis.stdout), bluemap: liveBlueMap ? 'running' : bmLabel };
}

async function getStats(quiet) {
  const { stdout } = await run(`docker stats --no-stream --format '{{.Name}}:{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}' 2>/dev/null`, quiet);
  const s = {};
  for (const line of stdout.split('\n').filter(Boolean)) {
    const [n, r] = line.split(':');
    const service = (n.match(/-([^-]+)-\d+$/) || [])[1] || '';
    if (r && (service === 'mc' || /^visitor\d*$/.test(service) || service === 'bluemap')) {
      const [cpu, mem, mp, net] = r.split('|');
      const k = service === 'mc' ? 'mc' : service.startsWith('visitor') ? 'visitor' : service === 'bluemap' ? 'bluemap' : null;
      if (k) s[k] = { cpu, mem, memPct: mp, net };
    }
  }
  return s;
}

function getProgress() {
  try {
    if (!fs.existsSync(stateDir)) return { regions:0,total:0,rx:0,rz:0,pct:0 };
    const files = fs.readdirSync(stateDir).filter(f => f.startsWith('visited') && f.endsWith('.json'));
    const worldTotal = countWorldRegions();
    if (!files.length) return { regions:0,total:worldTotal,rx:0,rz:0,pct:0 };
    const visited = new Set(); let maxTotal=0, rx=0, rz=0;
    for (const f of files) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(stateDir,f),'utf8'));
        if (d.visited) for (const k of Object.keys(d.visited)) visited.add(k);
        if (d.total && d.total > maxTotal) maxTotal = d.total;
      } catch {}
    }
    if (visited.size > 0) {
      const parts = [...visited].pop().split(',');
      rx = parseInt(parts[0])||0; rz = parseInt(parts[1])||0;
    }
    const total = worldTotal || maxTotal || visited.size;
    const pct = total > 0 ? Math.min(100, Math.round(visited.size/Math.max(total,visited.size)*100)) : 0;
    return { regions: visited.size, total, rx, rz, pct };
  } catch { return { regions:0,total:0,rx:0,rz:0,pct:0 }; }
}

function countWorldRegions() {
  const cfg = readEnv();
  const rawWorldPath = cfg.WORLD_PATH || './mc-data/world';
  const worldPath = path.isAbsolute(rawWorldPath) ? rawWorldPath : path.resolve(PROJECT_DIR, rawWorldPath);
  const dirs = [
    path.join(worldPath, 'dimensions', 'minecraft', 'overworld', 'region'),
    path.join(worldPath, 'region')
  ];
  for (const dir of dirs) {
    try {
      if (fs.existsSync(dir)) return fs.readdirSync(dir).filter(f => /^r\.-?\d+\.-?\d+\.mca$/.test(f)).length;
    } catch {}
  }
  return 0;
}

function getBotStatuses() {
  const dir = path.join(stateDir, 'bots');
  try {
    const fallback = new Map(logBotStatuses);
    const merge = status => {
      if (!status?.id || !status?.position) return;
      const existing = fallback.get(status.id);
      if (!existing || Date.parse(status.updatedAt || '') >= Date.parse(existing.updatedAt || '')) {
        fallback.set(status.id, status);
      }
    };
    if (!fs.existsSync(dir)) return [...fallback.values()].sort((a, b) => (a.index || 0) - (b.index || 0));
    fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
        catch { return null; }
      })
      .forEach(merge);
    return [...fallback.values()].filter(s => s?.id && s?.position && Number.isFinite(s.position.x) && Number.isFinite(s.position.y) && Number.isFinite(s.position.z)).map(s => ({
        id: String(s.id),
        index: Number.isFinite(s.index) ? s.index : 0,
        username: String(s.username || s.id),
        status: String(s.status || 'unknown'),
        position: s.position,
        path: Array.isArray(s.path) ? s.path.slice(-80) : [],
        chunks: s.chunks || null,
        blackSpot: s.blackSpot || null,
        blackSpots: Array.isArray(s.blackSpots) ? s.blackSpots.slice(-20) : [],
        region: s.region || '',
        waypoint: s.waypoint || '',
        updatedAt: s.updatedAt || '',
      }))
      .sort((a, b) => a.index - b.index);
  } catch {
    return [...logBotStatuses.values()];
  }
}

function updateBotStatusFromLog(line) {
  const prefixed = line.match(/^([A-Za-z0-9_-]+)\s+\|\s+(.*)$/);
  const source = prefixed ? prefixed[1] : 'visitor';
  const msg = prefixed ? prefixed[2] : line;
  const serviceMatch = source.match(/visitor(\d*)/);
  if (!serviceMatch) return;
  const index = serviceMatch[1] ? parseInt(serviceMatch[1], 10) : 0;
  const id = `bot${index}`;
  const cfg = readEnv();
  const username = `${cfg.MC_USERNAME || 'Bot'}${getBotCount() > 1 ? index : ''}`;
  const current = logBotStatuses.get(id) || { id, index, username, status: 'running', position: null, updatedAt: '', region: '', waypoint: '' };
  const waypoint = msg.match(/waypoint\s+(\d+)\/(\d+)\s+@\s+\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/);
  const region = msg.match(/Region\s+\((-?\d+),\s*(-?\d+)\)\s+@\s+\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/);
  const match = waypoint || region;
  if (!match) return;
  const offset = waypoint ? 3 : 3;
  current.status = waypoint ? 'waypoint' : 'region';
  current.position = { x: parseFloat(match[offset]), y: parseFloat(match[offset + 1]), z: parseFloat(match[offset + 2]) };
  if (waypoint) current.waypoint = `${match[1]}/${match[2]}`;
  if (region) current.region = `${match[1]},${match[2]}`;
  current.updatedAt = new Date().toISOString();
  logBotStatuses.set(id, current);
}

function getMarkerInfo() {
  try {
    const markers = fs.existsSync(bluemapMarkersJson) ? JSON.parse(fs.readFileSync(bluemapMarkersJson, 'utf8')) : {};
    const backupMarkers = fs.existsSync(bluemapBackupMarkersJson) ? JSON.parse(fs.readFileSync(bluemapBackupMarkersJson, 'utf8')) : {};
    const statPath = fs.existsSync(bluemapMarkersJson) ? bluemapMarkersJson : fs.existsSync(bluemapBackupMarkersJson) ? bluemapBackupMarkersJson : '';
    if (!statPath) return { present: false, backupPresent: false, updatedAt: '', set: 'World Visitor Bots' };
    const stat = fs.statSync(statPath);
    return {
      present: Boolean(markers[BOT_MARKER_SET]),
      backupPresent: Boolean(markers[BOT_BACKUP_MARKER_SET] || backupMarkers[BOT_BACKUP_MARKER_SET]),
      updatedAt: stat.mtime.toISOString(),
      set: 'World Visitor Bots'
    };
  } catch {
    return { present: false, updatedAt: '', set: 'World Visitor Bots' };
  }
}

function getETA() {
  const now = Date.now();
  const d = etaData;
  const p = getProgress();
  const e = { wp: '', region: '', total: '', wpPct: 0, wpDone: d.wpDone, wpTotal: d.wpTotal };

  // Waypoint ETA
  if (d.wpStart && d.wpTotal > 0 && d.wpDone > 0) {
    const wpElapsed = (now - d.wpStart)/1000;
    const wpAvg = wpElapsed / d.wpDone;
    const wpRemaining = (d.wpTotal - d.wpDone) * wpAvg;
    e.wp = fmtEstimate(wpRemaining);
    e.wpPct = Math.min(100, Math.round(d.wpDone/d.wpTotal*100));
  }

  // Region ETA
  if (d.lastRegionAt && d.firstRegionAt && d.regionsStarted > 1) {
    const regElapsed = (d.lastRegionAt - d.firstRegionAt)/1000;
    const regAvg = regElapsed / (d.regionsStarted - 1);
    const regRemaining = Math.max(0, p.total - p.regions) * regAvg;
    e.region = fmtEstimate(regRemaining);
  }

  // Total ETA = same as region ETA if we don't have waypoint granularity
  if (e.wp) e.total = fmtEstimate(Math.max(0, (d.wpTotal - d.wpDone) * ((d.wpStart && d.wpDone > 0) ? (now - d.wpStart)/1000/d.wpDone : 60)));
  else if (e.region) e.total = e.region;

  return e;
}

function fmtDuration(sec) {
  if (sec <= 0) return '--';
  if (sec < 60) return Math.round(sec)+'s';
  if (sec < 3600) return Math.floor(sec/60)+'m '+Math.round(sec%60)+'s';
  const h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60);
  return h+'h '+m+'m';
}

function fmtEstimate(sec) {
  if (sec <= 0) return 'now';
  const when = new Date(Date.now() + Math.max(0, sec) * 1000).toLocaleString('en-GB', { hour12: false });
  return `${fmtDuration(sec)} @ ${when}`;
}

function readEnv() {
  const cfg = {};
  try { for (const line of fs.readFileSync(envPath,'utf8').split('\n')) { const m = line.match(/^([A-Z_]+)=(.*)$/); if (m) cfg[m[1]]=m[2]; } } catch {}
  return cfg;
}

function setting(settings, current, key, fallback) {
  return settings[key] ?? current[key] ?? fallback;
}

function bugArtifactPath(file) {
  const rel = String(file || '').replace(/\\/g, '/');
  if (!rel.startsWith('logs/bug-watcher/sessions/')) return '';
  const full = path.resolve(PROJECT_DIR, rel);
  const base = path.resolve(bugSessionsDir);
  if (full !== base && full.startsWith(`${base}${path.sep}`) && fs.existsSync(full)) return full;
  return '';
}

function normalizeFollowPlayers(value) {
  return [...new Set(String(value || '')
    .split(/[,\n\r\t ]+/)
    .map(name => name.trim())
    .filter(name => PLAYER_NAME_RE.test(name)))].join(',');
}

function safeStateName(name) {
  const base = String(name || '').trim().replace(/\.json$/i, '') || 'visited';
  const safe = base.replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^-+|-+$/g, '') || 'visited';
  return safe.endsWith('.json') ? safe : `${safe}.json`;
}

function statePathFor(name) {
  const file = safeStateName(name);
  const full = path.join(stateDir, file);
  if (!full.startsWith(`${stateDir}${path.sep}`)) throw new Error('Invalid state name');
  return { file, full };
}

function readStates() {
  const states = {};
  try {
    if (fs.existsSync(stateDir)) {
      for (const f of fs.readdirSync(stateDir).filter(x => x.endsWith('.json'))) {
        try { states[f] = JSON.parse(fs.readFileSync(path.join(stateDir, f), 'utf8')); }
        catch { states[f] = { error: 'invalid JSON' }; }
      }
    }
  } catch {}
  return states;
}

function parseStateBody(body) {
  if (typeof body.content === 'string') return JSON.parse(body.content || '{}');
  if (typeof body.data === 'object' && body.data !== null) return body.data;
  return {};
}

function writeEnv(settings) {
  const current = readEnv();
  const values = { ...current };
  Object.assign(values, {
    MC_HOST: 'mc',
    MC_PORT: '25565',
    MC_USERNAME: setting(settings, current, 'MC_USERNAME', 'Bot'),
    MC_AUTH: 'offline',
    RENDER_DISTANCE: setting(settings, current, 'RENDER_DISTANCE', '28'),
    FLY_Y: setting(settings, current, 'FLY_Y', '200'),
    GRID_STEP: setting(settings, current, 'GRID_STEP', '160'),
    BOT_COUNT: setting(settings, current, 'BOT_COUNT', '1'),
    WORLD_PATH: setting(settings, current, 'WORLD_PATH', './mc-data/world'),
    WP_DELAY: setting(settings, current, 'WP_DELAY', '2000'),
    REGION_DELAY: setting(settings, current, 'REGION_DELAY', '2000'),
    CHUNK_LOAD_TIMEOUT: setting(settings, current, 'CHUNK_LOAD_TIMEOUT', '60000'),
    CHUNK_CHECK_RADIUS: setting(settings, current, 'CHUNK_CHECK_RADIUS', '1'),
    MOVE_MODE: setting(settings, current, 'MOVE_MODE', 'smooth'),
    MOVE_STEP: setting(settings, current, 'MOVE_STEP', '32'),
    MOVE_DELAY: setting(settings, current, 'MOVE_DELAY', '150'),
    MC_MEMORY: setting(settings, current, 'MC_MEMORY', '12G'),
    BOT_MEMORY: setting(settings, current, 'BOT_MEMORY', '2G'),
    BLUEMAP_HOST: 'bluemap',
    BLUEMAP_PORT: '8100',
    BLUEMAP_MAP: 'overworld',
    FOLLOW_PLAYER: normalizeFollowPlayers(settings.FOLLOW_PLAYER ?? current.FOLLOW_PLAYER ?? '')
  });

  const ordered = [
    'MC_HOST', 'MC_PORT', 'MC_USERNAME', 'MC_AUTH', 'RENDER_DISTANCE', 'FLY_Y',
    'GRID_STEP', 'BOT_COUNT', 'WORLD_PATH', 'WP_DELAY', 'REGION_DELAY',
    'CHUNK_LOAD_TIMEOUT', 'CHUNK_CHECK_RADIUS', 'MOVE_MODE', 'MOVE_STEP',
    'MOVE_DELAY', 'MC_MEMORY', 'BOT_MEMORY', 'BLUEMAP_HOST', 'BLUEMAP_PORT',
    'BLUEMAP_MAP', 'FOLLOW_PLAYER'
  ];
  const known = new Set(ordered);
  const lines = ['# Overworld Visitor'];
  lines.push(...ordered.map(key => `${key}=${values[key]}`));
  lines.push(...Object.keys(values).filter(key => !known.has(key)).sort().map(key => `${key}=${values[key]}`));
  lines.push('');
  fs.writeFileSync(envPath, lines.join('\n'));

  if (settings.stateData) {
    const file = path.join(stateDir,'visited.json');
    let existing = {};
    try { if (fs.existsSync(file)) existing = JSON.parse(fs.readFileSync(file,'utf8')); } catch {}
    const merged = { ...existing, visited: { ...(existing.visited||{}), ...settings.stateData } };
    if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(merged, null, 2));
  }
}

async function runServerCommand(cmd) {
  const result = await compose(`exec -T mc rcon-cli ${shQuote(cmd)}`);
  if (result.ok) return (result.stdout || '(empty)').trim();
  return (result.stderr || result.stdout || 'Command failed').trim();
}

function uiScriptCheckCommand() {
  return `node -e ${shQuote("const fs=require('fs'),path=require('path'),vm=require('vm'); const files=[]; const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name); if(e.isDirectory())walk(p); else if(p.endsWith('.html'))files.push(p)}}; walk('control/public'); for(const file of files){const html=fs.readFileSync(file,'utf8'); const scripts=[...html.matchAll(/<script(?![^>]*src)[^>]*>([\\s\\S]*?)<\\/script>/g)].map(m=>m[1]); for(const script of scripts)new vm.Script(script,{filename:file})}")}`;
}

async function runBugChecks(dir = PROJECT_DIR, logFile = '') {
  await ensureGitSafeDirectory(dir, logFile);
  const env = { ...process.env, HOST_PROJECT_DIR: dir, COMPOSE_PROJECT_NAME: `${COMPOSE_PROJECT}-check` };
  const checks = [
    { name: 'Control server syntax', severity: 'error', cmd: 'node --check control/server.js' },
    { name: 'Bot syntax', severity: 'error', cmd: 'node --check bot/index.js' },
    { name: 'Panel script syntax', severity: 'error', cmd: uiScriptCheckCommand() },
    { name: 'Bot tests', severity: 'error', cmd: 'npm test --prefix bot', timeout: 180000 },
    { name: 'Control dependencies', severity: 'warning', cmd: 'npm ls --package-lock-only --omit=dev --prefix control', timeout: 120000 },
    { name: 'Bot dependencies', severity: 'warning', cmd: 'npm ls --package-lock-only --omit=dev --prefix bot', timeout: 120000 },
    { name: 'Git whitespace', severity: 'warning', cmd: `git -c safe.directory=${shQuote(dir)} diff --check` },
    { name: 'Compose default config', severity: 'error', cmd: `docker compose --project-directory ${shQuote(dir)} config`, timeout: 180000 },
    { name: 'Compose multi config', severity: 'error', cmd: `docker compose --project-directory ${shQuote(dir)} --profile multi config`, timeout: 180000 },
    { name: 'Compose cli config', severity: 'error', cmd: `docker compose --project-directory ${shQuote(dir)} --profile cli config`, timeout: 180000 },
    { name: 'Control compose config', severity: 'error', cmd: 'docker compose -f compose.web.yml config', timeout: 180000 },
    { name: 'New-world compose config', severity: 'error', cmd: 'docker compose -f compose.new.yml config', timeout: 180000 },
    { name: 'BlueMap compose config', severity: 'error', cmd: 'docker compose -f compose.bluemap.yml config', timeout: 180000 },
    { name: 'BlueMap CLI compose config', severity: 'error', cmd: 'docker compose -f compose.bluemap-cli.yml config', timeout: 180000 }
  ];
  const results = [];
  for (const check of checks) {
    const result = await runShellLogged(check.cmd, { cwd: dir, env, timeout: check.timeout || 120000, logFile });
    const output = `${result.stdout}\n${result.stderr}`.trim();
    const hasWarning = /\b(warn|warning|deprecated|deprecation)\b/i.test(output);
    const failed = !result.ok || (BUG_WATCHER_TREAT_WARNINGS && hasWarning);
    results.push({ ...check, ok: result.ok, failed, hasWarning, output: output.slice(-8000), code: result.code });
  }
  const failed = results.filter(r => r.failed);
  return { ok: failed.length === 0, results, failed };
}

async function queueBugCheckFailures() {
  const logFile = path.join(bugSessionsDir, `health-${sessionStamp()}.log`);
  const checks = await runBugChecks(PROJECT_DIR, logFile);
  bugWatcherState.lastCheckAt = nowIso();
  bugWatcherState.lastCheckLog = path.relative(PROJECT_DIR, logFile);
  for (const check of checks.failed) {
    enqueueBugTask({
      source: 'health-check',
      title: `${check.name} ${check.ok ? 'warning' : 'failed'}`,
      severity: check.ok && check.hasWarning ? 'warning' : check.severity,
      signature: hashText(`${check.name}\n${check.output.replace(/\d+(\.\d+)?/g, '<n>').slice(0, 5000)}`),
      details: `${check.name}\nCommand: ${check.cmd}\nExit OK: ${check.ok}\nWarnings: ${check.hasWarning}\n\n${check.output}`
    });
  }
  if (checks.ok) saveBugWatcherState();
  return checks;
}

async function currentGitBranch(dir = PROJECT_DIR) {
  const result = await runShell(`git -c safe.directory=${shQuote(dir)} rev-parse --abbrev-ref HEAD`, { cwd: dir });
  return result.stdout.trim() || 'main';
}

async function ensureBugWorktree(task, logFile) {
  normalizeTaskBranch(task);
  const baseBranch = process.env.BUG_WATCHER_BASE_BRANCH || await currentGitBranch(PROJECT_DIR);
  bugWatcherState.baseBranch = baseBranch;
  const worktree = path.join(bugWorktreesDir, safeSlug(task.branch));
  ensureDir(bugWorktreesDir);
  await runShellLogged(`git -c safe.directory=${shQuote(PROJECT_DIR)} worktree prune --expire now`, { cwd: PROJECT_DIR, logFile, timeout: 120000 });
  if (fs.existsSync(path.join(worktree, '.git'))) {
    await ensureGitSafeDirectory(worktree, logFile);
    const current = await runShell(gitSafe(worktree, 'rev-parse --abbrev-ref HEAD'), { cwd: worktree, timeout: 120000 });
    if (current.ok && current.stdout.trim() === task.branch) {
      await runShellLogged(gitSafe(worktree, 'reset --hard'), { cwd: worktree, logFile, timeout: 120000 });
      await runShellLogged(gitSafe(worktree, 'clean -fd'), { cwd: worktree, logFile, timeout: 120000 });
      const merge = await runShellLogged(gitSafe(worktree, `merge --no-edit ${shQuote(baseBranch)}`), { cwd: worktree, logFile, timeout: 300000 });
      if (merge.ok) return { worktree, baseBranch };
    }
  }
  if (fs.existsSync(worktree)) {
    fs.rmSync(worktree, { recursive: true, force: true });
    await runShellLogged(`git -c safe.directory=${shQuote(PROJECT_DIR)} worktree prune --expire now`, { cwd: PROJECT_DIR, logFile, timeout: 120000 });
  }
  const branchExists = await runShell(`git -c safe.directory=${shQuote(PROJECT_DIR)} rev-parse --verify ${shQuote(task.branch)} 2>/dev/null`, { cwd: PROJECT_DIR, timeout: 120000 });
  let result = branchExists.ok
    ? await runShellLogged(`git -c safe.directory=${shQuote(PROJECT_DIR)} worktree add --force ${shQuote(worktree)} ${shQuote(task.branch)}`, { cwd: PROJECT_DIR, logFile, timeout: 180000 })
    : await runShellLogged(`git -c safe.directory=${shQuote(PROJECT_DIR)} worktree add -b ${shQuote(task.branch)} ${shQuote(worktree)} ${shQuote(baseBranch)}`, { cwd: PROJECT_DIR, logFile, timeout: 180000 });
  if (!result.ok) throw new Error(`Unable to create worktree for ${task.branch}`);
  await ensureGitSafeDirectory(worktree, logFile);
  if (branchExists.ok) {
    await runShellLogged(gitSafe(worktree, 'reset --hard'), { cwd: worktree, logFile, timeout: 120000 });
    await runShellLogged(gitSafe(worktree, 'clean -fd'), { cwd: worktree, logFile, timeout: 120000 });
    result = await runShellLogged(gitSafe(worktree, `merge --no-edit ${shQuote(baseBranch)}`), { cwd: worktree, logFile, timeout: 300000 });
    if (!result.ok) throw new Error((result.stderr || result.stdout || `Unable to merge ${baseBranch} into ${task.branch}`).slice(-1200));
  }
  return { worktree, baseBranch };
}

function resolveOpenCodeCommand() {
  const local = path.join(__dirname, 'node_modules', '.bin', 'opencode');
  if (fs.existsSync(local)) return local;
  return OPENCODE_CMD;
}

function buildAutofixPrompt(task, baseBranch) {
  return [
    'You are the fully automated bug watcher for this repository.',
    `Work only on branch ${task.branch}, based on ${baseBranch}.`,
    'Do not ask the user questions. Do not wait for interaction. Make the smallest correct fix.',
    'Treat warnings as small errors. If a dependency or tool is missing, install it automatically.',
    OPENCODE_ALLOW_SUDO ? 'You may use sudo without asking when a missing dependency or software package requires it.' : 'Do not use sudo because OPENCODE_ALLOW_SUDO is disabled.',
    'Keep changes project-scoped. Do not alter unrelated user data. Do not push; the watcher will commit, push, and create/comment on the PR.',
    '',
    `Task: ${task.title}`,
    `Severity: ${task.severity}`,
    `Source: ${task.source}`,
    '',
    'Failure/report details:',
    task.details || '(no details)',
    '',
    'Required final behavior:',
    '1. Fix the root cause, not just the symptom.',
    '2. Run relevant checks/tests if possible.',
    '3. Leave a concise summary in your final answer including cause and fix.'
  ].join('\n');
}

function summarizeFix(task, checks) {
  const failedNames = checks.failed.map(c => c.name).join(', ');
  const cause = task.source === 'bug-report'
    ? 'A site bug report or user report queued this repair.'
    : `Automated validation detected ${task.title}.`;
  const summary = checks.ok
    ? `Automated repair completed and validation passed for ${task.title}.`
    : `Automated repair attempt finished but validation still reports: ${failedNames || 'unknown failure'}.`;
  return { cause, summary };
}

function reportCommentsForTask(task) {
  const comments = [];
  for (const reportId of task.reportIds || []) {
    const report = bugWatcherState.reports.find(r => r.id === reportId);
    if (!report) continue;
    for (const comment of report.comments || []) {
      comments.push(`${report.title}: ${comment.message || ''}`.slice(0, 800));
    }
  }
  return comments.filter(Boolean).slice(-12);
}

async function createOrUpdatePullRequest(task, worktree, baseBranch, logFile) {
  if (!OPENCODE_AUTO_PR) return '';
  if (!(await commandExists('gh'))) {
    appendSession(logFile, '\n[pr] gh is not installed; skipping PR creation.\n');
    return '';
  }
  let view = await runShellLogged(`gh pr view ${shQuote(task.branch)} --json url --jq .url`, { cwd: worktree, logFile, timeout: 120000 });
  let prUrl = view.ok ? view.stdout.trim() : '';
  const body = [
    `Automated bug watcher repair for ${task.title}.`,
    '',
    `Severity: ${task.severity}`,
    `Cause: ${task.cause || 'Automated validation or report detected this issue.'}`,
    `Fix: ${task.summary || 'The watcher applied a project-scoped repair.'}`,
    '',
    'Public report comments:',
    ...(reportCommentsForTask(task).length ? reportCommentsForTask(task).map(c => `- ${c}`) : ['- None yet']),
    '',
    `Session log: ${task.sessionLog ? path.relative(PROJECT_DIR, task.sessionLog) : 'logs/bug-watcher/sessions'}`
  ].join('\n');
  if (!prUrl) {
    const create = await runShellLogged(`gh pr create --base ${shQuote(baseBranch)} --head ${shQuote(task.branch)} --title ${shQuote(task.title)} --body ${shQuote(body)}`, { cwd: worktree, logFile, timeout: 180000 });
    prUrl = create.stdout.trim().split('\n').find(line => /^https?:\/\//.test(line)) || '';
  }
  if (prUrl) {
    const comments = reportCommentsForTask(task).map(c => `- ${c}`).join('\n') || '- None yet';
      await runShellLogged(`gh pr comment ${shQuote(prUrl)} --body ${shQuote(`Automated watcher update:\n\nCause: ${task.cause || 'detected by validation/report'}\n\nFixed: ${task.summary || 'repair applied'}\n\nBranch: ${task.branch}\n\nPublic report comments:\n${comments}`)}`, { cwd: worktree, logFile, timeout: 120000 });
  }
  return prUrl;
}

function taskHasUserRejection(task) {
  for (const reportId of task.reportIds || []) {
    const report = bugWatcherState.reports.find(r => r.id === reportId);
    if (!report) continue;
    if (report.mergeRejected) return true;
    if ((report.comments || []).some(c => c.kind === 'rejection')) return true;
  }
  return false;
}

function scheduleAutoMerge(task) {
  if (task.noCodeRepair) {
    task.mergeStatus = 'not-needed';
    task.mergedAt = task.mergedAt || nowIso();
    updateReportsForTask(task, 'finished', { mergeStatus: task.mergeStatus, mergedAt: task.mergedAt });
    return;
  }
  if (!BUG_WATCHER_AUTO_MERGE || !task.branch) {
    task.mergeStatus = 'manual';
    return;
  }
  if (!task.mergeAfter) task.mergeAfter = new Date(Date.now() + BUG_WATCHER_AUTO_MERGE_MS).toISOString();
  task.mergeStatus = taskHasUserRejection(task) ? 'blocked' : 'pending';
  task.mergeTarget = BUG_WATCHER_MERGE_BRANCH;
  updateReportsForTask(task, 'finished', { mergeStatus: task.mergeStatus, mergeAfter: task.mergeAfter, mergeTarget: task.mergeTarget });
  const waitMin = Math.round(BUG_WATCHER_AUTO_MERGE_MS / 60000);
  for (const reportId of task.reportIds || []) {
    addReportComment(reportId, `Auto-merge is ${task.mergeStatus} for ${task.branch}. If not rejected within ${waitMin} minute${waitMin === 1 ? '' : 's'}, it will merge to ${BUG_WATCHER_MERGE_BRANCH} and push automatically.`, 'info');
  }
}

function completeBugTask(task, status = 'completed') {
  task.status = status;
  task.updatedAt = nowIso();
  if (status === 'completed') scheduleAutoMerge(task);
  if (!bugWatcherState.completed.some(t => t.id === task.id)) bugWatcherState.completed.push(task);
  bugWatcherState.completed = bugWatcherState.completed.slice(-100);
  if (bugWatcherState.current?.id === task.id) bugWatcherState.current = null;
  saveBugWatcherState();
}

function requeueFailedBugTasks(ids) {
  const wanted = new Set((Array.isArray(ids) ? ids : [ids]).map(id => String(id || '')).filter(Boolean));
  if (!wanted.size) return [];
  const requeued = [];
  const keepCompleted = [];
  for (const task of bugWatcherState.completed) {
    if (!wanted.has(task.id) || !['failed', 'completed', 'removed'].includes(task.status)) {
      keepCompleted.push(task);
      continue;
    }
    const at = nowIso();
    task.status = 'queued';
    task.attempts = 0;
    task.requeuedAt = at;
    task.updatedAt = at;
    task.startedAt = '';
    task.finishedAt = '';
    task.summary = 'Requeued by user request.';
    delete task.nextRetryAt;
    delete task.mergeStatus;
    delete task.mergeAfter;
    delete task.mergeTarget;
    bugWatcherState.queue.push(task);
    updateReportsForTask(task, 'approved', { summary: task.summary, finishedAt: '', nextRetryAt: '' });
    for (const reportId of task.reportIds || []) addReportComment(reportId, `Failed task ${task.id} was requeued for processing.`, 'info');
    requeued.push(task);
  }
  bugWatcherState.completed = keepCompleted;
  saveBugWatcherState();
  return requeued;
}

function processAllBugTasksNow() {
  let queued = 0;
  for (const task of bugWatcherState.queue) {
    if (!task || !['queued', 'retry'].includes(task.status)) continue;
    task.status = 'queued';
    task.updatedAt = nowIso();
    task.summary = `${task.summary || 'Queued for processing.'} Processing requested now.`.trim();
    delete task.nextRetryAt;
    normalizeTaskBranch(task);
    updateReportsForTask(task, 'approved', { summary: task.summary, nextRetryAt: '' });
    queued += 1;
  }
  const failedIds = bugWatcherState.completed.filter(task => task.status === 'failed').map(task => task.id);
  const requeued = requeueFailedBugTasks(failedIds);
  dedupeBugQueue();
  saveBugWatcherState();
  return { queued, requeued: requeued.length };
}

function finishCancelledBugTask(task) {
  task.status = 'removed';
  task.finishedAt = nowIso();
  task.updatedAt = nowIso();
  task.summary = 'Cancelled by user request.';
  updateReportsForTask(task, 'removed', { summary: task.summary, finishedAt: task.finishedAt });
  completeBugTask(task, 'removed');
}

async function processAutoMerges(ios) {
  if (bugAutoMergeRunning || !BUG_WATCHER_AUTO_MERGE) return;
  const task = bugWatcherState.completed.find(t => t.status === 'completed' && t.mergeStatus === 'pending' && t.mergeAfter && Date.parse(t.mergeAfter) <= Date.now());
  if (!task) return;
  bugAutoMergeRunning = true;
  const logFile = path.join(bugSessionsDir, `${task.id}-merge-${sessionStamp()}.log`);
  let mergeDir = '';
  try {
    if (taskHasUserRejection(task)) {
      task.mergeStatus = 'blocked';
      task.updatedAt = nowIso();
      updateReportsForTask(task, 'finished', { mergeStatus: 'blocked' });
      for (const reportId of task.reportIds || []) addReportComment(reportId, `Auto-merge blocked by user rejection for ${task.branch}.`, 'warn');
      saveBugWatcherState();
      return;
    }
    task.mergeStatus = 'merging';
    task.updatedAt = nowIso();
    updateReportsForTask(task, 'finished', { mergeStatus: 'merging' });
    saveBugWatcherState();
    elog(ios, `Auto-merging ${task.branch} to ${BUG_WATCHER_MERGE_BRANCH}`, 'info');
    mergeDir = path.join(bugWorktreesDir, `merge-${safeSlug(task.id)}`);
    if (fs.existsSync(mergeDir)) fs.rmSync(mergeDir, { recursive: true, force: true });
    let result = await runShellLogged(`git -c safe.directory=${shQuote(PROJECT_DIR)} fetch origin ${shQuote(BUG_WATCHER_MERGE_BRANCH)} ${shQuote(task.branch)}`, { cwd: PROJECT_DIR, timeout: 300000, logFile });
    if (!result.ok) throw new Error((result.stderr || result.stdout || 'Fetch failed').slice(-1200));
    result = await runShellLogged(`git -c safe.directory=${shQuote(PROJECT_DIR)} worktree prune`, { cwd: PROJECT_DIR, timeout: 120000, logFile });
    if (!result.ok) throw new Error((result.stderr || result.stdout || 'Worktree prune failed').slice(-1200));
    result = await runShellLogged(`git -c safe.directory=${shQuote(PROJECT_DIR)} worktree add --detach ${shQuote(mergeDir)} ${shQuote(`origin/${BUG_WATCHER_MERGE_BRANCH}`)}`, { cwd: PROJECT_DIR, timeout: 180000, logFile });
    if (!result.ok) throw new Error((result.stderr || result.stdout || 'Worktree add failed').slice(-1200));
    await ensureGitSafeDirectory(mergeDir, logFile);
    result = await runShellLogged(gitSafe(mergeDir, `merge --no-ff ${shQuote(`origin/${task.branch}`)} -m ${shQuote(`merge: ${task.title}`)}`), { cwd: mergeDir, timeout: 300000, logFile });
    if (!result.ok) throw new Error((result.stderr || result.stdout || 'Merge failed').slice(-1200));
    result = await runShellLogged(gitSafe(mergeDir, `push origin ${shQuote(`HEAD:${BUG_WATCHER_MERGE_BRANCH}`)}`), { cwd: mergeDir, timeout: 300000, logFile });
    if (!result.ok) throw new Error((result.stderr || result.stdout || 'Push failed').slice(-1200));
    await runShellLogged(gitSafe(mergeDir, `push origin --delete ${shQuote(task.branch)}`), { cwd: mergeDir, timeout: 180000, logFile });
    task.mergeStatus = 'merged';
    task.mergedAt = nowIso();
    task.updatedAt = nowIso();
    task.mergeLog = path.relative(PROJECT_DIR, logFile);
    updateReportsForTask(task, 'merged', { mergeStatus: 'merged', mergedAt: task.mergedAt });
    for (const reportId of task.reportIds || []) addReportComment(reportId, `Auto-merged ${task.branch} into ${BUG_WATCHER_MERGE_BRANCH}, pushed, and deleted the remote fix branch.`, 'done');
    saveBugWatcherState();
    elog(ios, `Auto-merged ${task.branch}`, 'done');
  } catch (err) {
    task.mergeStatus = 'merge-failed';
    task.summary = `${task.summary || ''} Auto-merge failed: ${err.message}`.trim();
    task.updatedAt = nowIso();
    task.mergeLog = path.relative(PROJECT_DIR, logFile);
    updateReportsForTask(task, 'finished', { mergeStatus: 'merge-failed', summary: task.summary });
    for (const reportId of task.reportIds || []) addReportComment(reportId, `Auto-merge failed for ${task.branch}: ${err.message}`, 'error');
    saveBugWatcherState();
    elog(ios, `Auto-merge failed: ${err.message}`, 'error');
  } finally {
    if (mergeDir) {
      const cleanup = await runShellLogged(`git -c safe.directory=${shQuote(PROJECT_DIR)} worktree remove ${shQuote(mergeDir)} --force`, { cwd: PROJECT_DIR, timeout: 120000, logFile });
      if (!cleanup.ok) {
        if (fs.existsSync(mergeDir)) fs.rmSync(mergeDir, { recursive: true, force: true });
        await runShellLogged(`git -c safe.directory=${shQuote(PROJECT_DIR)} worktree prune`, { cwd: PROJECT_DIR, timeout: 120000, logFile });
      }
    }
    bugAutoMergeRunning = false;
  }
}

async function rebuildSiteAfterFix(task, logFile) {
  const env = {
    ...process.env,
    HOST_PROJECT_DIR: HOST_PROJECT_DIR || PROJECT_DIR,
    COMPOSE_PROJECT_NAME: COMPOSE_PROJECT,
    COMPOSE_IGNORE_ORPHANS: 'true',
    HOST_IP: LOCAL_IP
  };
  task.siteRestartStartedAt = nowIso();
  updateReportsForTask(task, 'finished', { summary: `${task.summary || ''} Site rebuild/restart started.`.trim() });
  saveBugWatcherState();
  appendSession(logFile, '\n[site] rebuilding control image after automated fix\n');
  await runShellLogged('docker compose -f compose.web.yml build control', { cwd: PROJECT_DIR, env, timeout: 600000, logFile });
  appendSession(logFile, '\n[site] scheduling control restart with helper container\n');
  const hostDir = HOST_PROJECT_DIR || PROJECT_DIR;
  const helperName = `${safeSlug(COMPOSE_PROJECT, 'project')}-control-restarter-${Date.now()}`;
  const helperScript = 'sleep 2; docker compose -f compose.web.yml up -d control';
  const helperCmd = [
    'docker run --rm -d',
    `--name ${shQuote(helperName)}`,
    '-v /var/run/docker.sock:/var/run/docker.sock',
    `-v ${shQuote(`${hostDir}:/workspace`)}`,
    '-w /workspace',
    `-e HOST_PROJECT_DIR=${shQuote(hostDir)}`,
    `-e COMPOSE_PROJECT_NAME=${shQuote(COMPOSE_PROJECT)}`,
    '-e COMPOSE_IGNORE_ORPHANS=true',
    `-e HOST_IP=${shQuote(LOCAL_IP)}`,
    shQuote(`${COMPOSE_PROJECT}-control`),
    'sh -lc',
    shQuote(helperScript)
  ].join(' ');
  const helper = await runShellLogged(helperCmd, { cwd: PROJECT_DIR, env, timeout: 120000, logFile });
  if (!helper.ok) await runShellLogged('docker compose -f compose.web.yml up -d control', { cwd: PROJECT_DIR, env, timeout: 300000, logFile });
  task.siteRestartedAt = nowIso();
  updateReportsForTask(task, 'finished', { summary: `${task.summary || ''} Site restart scheduled.`.trim() });
  saveBugWatcherState();
}

async function processNextBugTask(ios) {
  if (bugWatcherRunning || !BUG_WATCHER_ENABLED || !OPENCODE_AUTOFIX) return;
  dedupeBugQueue();
  const task = bugWatcherState.queue.find(isBugTaskRunnable);
  if (!task) return;
  bugWatcherRunning = true;
  bugWatcherState.queue = bugWatcherState.queue.filter(t => t.id !== task.id);
  if ((task.attempts || 0) >= BUG_WATCHER_MAX_ATTEMPTS) {
    task.status = 'failed';
    task.summary = `Maximum attempts reached before another run (${task.attempts || 0}/${BUG_WATCHER_MAX_ATTEMPTS}).`;
    task.finishedAt = nowIso();
    updateReportsForTask(task, 'failed', { finishedAt: task.finishedAt });
    completeBugTask(task, 'failed');
    bugWatcherRunning = false;
    return;
  }
  task.status = 'running';
  task.attempts = (task.attempts || 0) + 1;
  delete task.nextRetryAt;
  task.startedAt = task.startedAt || nowIso();
  task.updatedAt = nowIso();
  task.sessionLog = path.join(bugSessionsDir, `${task.id}-attempt-${task.attempts}-${sessionStamp()}.log`);
  bugWatcherState.current = task;
  updateReportsForTask(task, 'processing', { processingAt: task.updatedAt });
  saveBugWatcherState();
  elog(ios, `Bug watcher started: ${task.title}`, 'info');
  try {
    const finishIfCancelled = () => {
      if (!task.cancelRequested) return false;
      finishCancelledBugTask(task);
      elog(ios, `Bug watcher cancelled: ${task.title}`, 'warn');
      return true;
    };
    if (finishIfCancelled()) return;
    if (task.source === 'health-check') {
      const checkName = String(task.details || '').split('\n')[0].trim();
      const recheck = await runBugChecks(PROJECT_DIR, task.sessionLog);
      if (finishIfCancelled()) return;
      const stillFailed = recheck.failed.find(check => check.name === checkName);
      if (!stillFailed) {
        task.finishedAt = nowIso();
        task.summary = `No code repair needed. ${checkName || task.title} now passes with the current validation rules.`;
        task.cause = `A prior automated health check queued ${task.title}, but a fresh recheck passed before opencode ran.`;
        task.noCodeRepair = true;
        completeBugTask(task, 'completed');
        elog(ios, `Bug watcher skipped stale task: ${task.title}`, 'done');
        return;
      }
      task.details = `${task.details}\n\nFresh recheck still failed:\n${stillFailed.output}`.slice(-12000);
    }
    await installMissingDependencies();
    if (finishIfCancelled()) return;
    const { worktree, baseBranch } = await ensureBugWorktree(task, task.sessionLog);
    if (finishIfCancelled()) return;
    const prompt = buildAutofixPrompt(task, baseBranch);
    const promptFile = path.join(bugSessionsDir, `${task.id}-agent-prompt-${sessionStamp()}.txt`);
    ensureDir(path.dirname(promptFile));
    fs.writeFileSync(promptFile, prompt);
    task.agentFile = path.relative(PROJECT_DIR, promptFile);
    const args = [worktree, '--prompt', prompt];
    if (OPENCODE_SKIP_PERMISSIONS) appendSession(task.sessionLog, '\n[opencode] --dangerously-skip-permissions is only available on opencode run; using opencode --prompt without that flag.\n');
    const opencodeResult = await spawnLogged(resolveOpenCodeCommand(), args, {
      cwd: worktree,
      logFile: task.sessionLog,
      timeout: OPENCODE_TIMEOUT_MS,
      env: { ...process.env, BUG_WATCHER_TASK_ID: task.id },
      onChild: child => { activeBugWatcherChild = { taskId: task.id, child }; }
    });
    if (activeBugWatcherChild?.taskId === task.id) activeBugWatcherChild = null;
    if (opencodeResult.timedOut) {
      task.details = `${task.details}\n\nopencode --prompt timed out after ${OPENCODE_TIMEOUT_MS}ms; validation will decide whether enough changes were applied.`.slice(-24000);
      appendSession(task.sessionLog, '\n[opencode] timed out; continuing to validation checks\n');
    } else if (!opencodeResult.ok) {
      throw new Error(`opencode --prompt exited with code ${opencodeResult.code || 1}`);
    }
    if (finishIfCancelled()) return;
    const checks = await runBugChecks(worktree, task.sessionLog);
    const fix = summarizeFix(task, checks);
    task.cause = fix.cause;
    task.summary = fix.summary;
    if (checks.ok) {
      const comments = [
        `How it went: automated opencode ran non-interactively on ${task.branch} and validation passed.`,
        'How it should improve: add or keep regression coverage for this signature so the watcher catches repeat issues sooner.'
      ];
      const artifactFields = { sessionLog: path.relative(PROJECT_DIR, task.sessionLog), agentFile: task.agentFile || '' };
      appendChangelogEntry({ severity: task.severity === 'warning' ? 'warning' : 'fix', title: task.title, summary: task.summary, cause: task.cause, fixed: [task.details.slice(0, 300)], comments, branch: task.branch, ...artifactFields }, worktree);
      appendRuntimeChangelogEntry({ severity: task.severity === 'warning' ? 'warning' : 'fix', title: task.title, summary: task.summary, cause: task.cause, fixed: [task.details.slice(0, 300)], comments, branch: task.branch, ...artifactFields });
      const status = await runShellLogged(gitSafe(worktree, 'status --short'), { cwd: worktree, logFile: task.sessionLog });
      if (!status.ok) throw new Error((status.stderr || status.stdout || 'Git status failed').slice(-1200));
      if (status.stdout.trim()) {
        let result = await runShellLogged(gitSafe(worktree, 'add -A'), { cwd: worktree, logFile: task.sessionLog });
        if (!result.ok) throw new Error((result.stderr || result.stdout || 'Git add failed').slice(-1200));
        result = await runShellLogged(`git -c safe.directory=${shQuote(path.resolve(worktree))} -c user.name=${shQuote(process.env.GIT_AUTHOR_NAME || 'Overworld Visitor Bot')} -c user.email=${shQuote(process.env.GIT_AUTHOR_EMAIL || 'overworld-visitor-bot@example.invalid')} commit -m ${shQuote(`fix: auto repair ${task.title}`)}`, { cwd: worktree, logFile: task.sessionLog, timeout: 180000 });
        if (!result.ok) throw new Error((result.stderr || result.stdout || 'Git commit failed').slice(-1200));
        if (OPENCODE_AUTO_PUSH) {
          result = await runShellLogged(gitSafe(worktree, `push -u origin ${shQuote(task.branch)}`), { cwd: worktree, logFile: task.sessionLog, timeout: 300000 });
          if (!result.ok) throw new Error((result.stderr || result.stdout || 'Git push failed').slice(-1200));
        }
        task.prUrl = await createOrUpdatePullRequest(task, worktree, baseBranch, task.sessionLog);
      }
      task.finishedAt = nowIso();
      updateReportsForTask(task, 'finished', { finishedAt: task.finishedAt });
      completeBugTask(task, 'completed');
      await rebuildSiteAfterFix(task, task.sessionLog);
      elog(ios, `Bug watcher fixed: ${task.title}`, 'done');
    } else if (task.attempts < BUG_WATCHER_MAX_ATTEMPTS) {
      scheduleBugTaskRetry(task);
      task.details = `${task.details}\n\nRetry needed after attempt ${task.attempts}:\n${checks.failed.map(c => `${c.name}: ${c.output.slice(-1200)}`).join('\n\n')}`.slice(-12000);
      task.summary = `${task.summary} Retrying in ${Math.round(BUG_WATCHER_RETRY_DELAY_MS / 60000)} minutes.`;
      updateReportsForTask(task, 'processing', { summary: task.summary, nextRetryAt: task.nextRetryAt });
      bugWatcherState.queue.push(task);
      elog(ios, `Bug watcher queued retry in ${Math.round(BUG_WATCHER_RETRY_DELAY_MS / 60000)} minutes: ${task.title}`, 'warn');
    } else {
      task.status = 'failed';
      task.finishedAt = nowIso();
      task.summary = `${task.summary} Maximum attempts reached.`;
      updateReportsForTask(task, 'failed', { finishedAt: task.finishedAt });
      completeBugTask(task, 'failed');
      elog(ios, `Bug watcher failed after ${task.attempts} attempts: ${task.title}`, 'error');
    }
  } catch (err) {
    task.status = task.attempts < BUG_WATCHER_MAX_ATTEMPTS ? 'retry' : 'failed';
    task.summary = `Watcher error: ${err.message}`;
    if (task.status === 'retry') scheduleBugTaskRetry(task);
    if (task.status === 'failed') task.finishedAt = nowIso();
    updateReportsForTask(task, task.status === 'retry' ? 'processing' : 'failed', task.status === 'failed' ? { finishedAt: task.finishedAt } : { nextRetryAt: task.nextRetryAt });
    if (task.status === 'retry') bugWatcherState.queue.push(task);
    else completeBugTask(task, 'failed');
    elog(ios, `Bug watcher error: ${err.message}`, 'error');
    if (task.sessionLog) appendSession(task.sessionLog, `\n[watcher error] ${err.stack || err.message}\n`);
  } finally {
    task.updatedAt = nowIso();
    if (activeBugWatcherChild?.taskId === task.id) activeBugWatcherChild = null;
    bugWatcherState.current = null;
    saveBugWatcherState();
    bugWatcherRunning = false;
  }
}

function parseByteLimit(value, fallback) {
  const raw = String(value || '').trim().toLowerCase();
  const match = raw.match(/^(\d+(?:\.\d+)?)(kb|mb|gb|tb)?$/);
  if (!match) return fallback;
  const units = { kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 };
  return Math.round(parseFloat(match[1]) * (units[match[2]] || 1));
}

function saveUpload(req, file) {
  const maxBytes = parseByteLimit(process.env.WORLD_UPLOAD_LIMIT || '80gb', 80 * 1024 ** 3);
  return new Promise((resolve, reject) => {
    ensureDir(path.dirname(file));
    const out = fs.createWriteStream(file);
    let bytes = 0;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        out.destroy();
        reject(new Error(`Upload exceeds limit ${formatBytes(maxBytes)}`));
        req.destroy();
      }
    });
    req.on('error', reject);
    out.on('error', reject);
    out.on('finish', () => resolve(bytes));
    req.pipe(out);
  });
}

function getWorldTargetPath() {
  const cfg = readEnv();
  const raw = cfg.WORLD_PATH || './mc-data/world';
  return path.isAbsolute(raw) ? raw : path.resolve(PROJECT_DIR, raw);
}

function countRegionFiles(dir) {
  try { return fs.readdirSync(dir).filter(f => /^r\.-?\d+\.-?\d+\.mca$/.test(f)).length; }
  catch { return 0; }
}

function scoreWorldRoot(dir) {
  const oldRegion = countRegionFiles(path.join(dir, 'region'));
  const newRegion = countRegionFiles(path.join(dir, 'dimensions', 'minecraft', 'overworld', 'region'));
  const hasLevel = fs.existsSync(path.join(dir, 'level.dat'));
  const score = (hasLevel ? 20 : 0) + (newRegion ? 12 : 0) + (oldRegion ? 10 : 0) + Math.min(8, Math.max(oldRegion, newRegion));
  if (score < 10) return null;
  return { dir, score, format: newRegion ? 'new dimensions' : 'classic region', regions: Math.max(oldRegion, newRegion), hasLevel };
}

function findWorldRoots(root) {
  const found = [];
  const visit = (dir, depth) => {
    if (depth > 8) return;
    const scored = scoreWorldRoot(dir);
    if (scored) found.push(scored);
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (ent.name === '__MACOSX' || ent.name.startsWith('.')) continue;
      visit(path.join(dir, ent.name), depth + 1);
    }
  };
  visit(root, 0);
  return found.sort((a, b) => b.score - a.score || a.dir.length - b.dir.length);
}

function moveDir(src, dest) {
  ensureDir(path.dirname(dest));
  try { fs.renameSync(src, dest); return; }
  catch {}
  fs.cpSync(src, dest, { recursive: true, force: true });
  fs.rmSync(src, { recursive: true, force: true });
}

async function importWorldZip(req, ios) {
  await installMissingDependencies();
  if (!(await commandExists('unzip'))) throw new Error('unzip is required to import world archives');
  const importId = sessionStamp();
  const importDir = path.join(logsDir, 'world-imports', importId);
  const zipPath = path.join(importDir, 'world.zip');
  const extractDir = path.join(importDir, 'extract');
  const bytes = await saveUpload(req, zipPath);
  ensureDir(extractDir);
  const unzip = await runShellLogged(`unzip -q ${shQuote(zipPath)} -d ${shQuote(extractDir)}`, { timeout: 60 * 60 * 1000, logFile: path.join(importDir, 'import.log') });
  if (!unzip.ok) throw new Error((unzip.stderr || unzip.stdout || 'Failed to unzip world archive').slice(-1000));
  const matches = findWorldRoots(extractDir);
  if (!matches.length) throw new Error('No Minecraft world root found in zip. Expected level.dat plus region/ or dimensions/minecraft/overworld/region/.');
  const chosen = matches[0];
  const target = getWorldTargetPath();
  const status = await getStatus(true);
  if (status.mc !== 'stopped' || status.visitor !== 'stopped' || status.bluemap !== 'stopped') {
    elog(ios, 'World import: stopping stack before replacing world files', 'warn');
    await compose('stop ' + ALL_MANAGED_SERVICES.join(' '));
  }
  let backup = '';
  if (fs.existsSync(target)) {
    backup = path.join(logsDir, 'world-import-backups', `${path.basename(target)}-${importId}`);
    moveDir(target, backup);
  }
  ensureDir(path.dirname(target));
  fs.cpSync(chosen.dir, target, { recursive: true, force: true });
  appendRuntimeChangelogEntry({
    severity: 'feature',
    title: 'Imported Minecraft world zip',
    summary: `Imported ${formatBytes(bytes)} world archive into ${path.relative(PROJECT_DIR, target)}.`,
    cause: `Detected ${chosen.format} world root at ${path.relative(extractDir, chosen.dir) || '.'}.`,
    features: ['Auto-detected world root inside zip', 'Backed up previous world before replacement']
  });
  elog(ios, `World import complete: ${chosen.format}, ${chosen.regions} regions`, 'done');
  return { bytes, target, backup, detected: chosen, matches: matches.slice(0, 8) };
}

function elog(target, msg, level) {
  const ios = Array.isArray(target) ? target : [target];
  ios.forEach(io => io.emit('log', { msg, level: level||'m' }));
}
function emc(io, msg) { io.emit('mclog', { msg, level: 'm' }); }
function ebm(io, msg) { io.emit('bmlog', { msg, level: 'm' }); }

async function syncVisitorLogs(ios) {
  try {
    const { stdout } = await run(`docker compose --project-directory ${PROJECT_DIR} logs ${ALL_VISITOR_SERVICES.join(' ')} --tail 12 2>/dev/null`, true);
    if (!stdout.trim()) return;
    const lines = stdout.trim().split('\n');
    for (const line of lines.slice(-8)) {
      if (seenVisitorLogs.includes(line)) continue;
      seenVisitorLogs.push(line);
      if (seenVisitorLogs.length > 200) seenVisitorLogs.shift();
      updateBotStatusFromLog(line);
      ios.forEach(io => io.emit('visitor-log', { msg: line.slice(0,500) }));

      // Parse waypoint progress: "waypoint 3/9 @"
      const wpMatch = line.match(/waypoint\s+(\d+)\/(\d+)/);
      if (wpMatch) {
        etaData.wpDone = parseInt(wpMatch[1]);
        etaData.wpTotal = parseInt(wpMatch[2]);
        etaData.wpStart = etaData.wpStart || Date.now();
      }

      // Parse region start: "Region (rx, rz) @"
      const regStart = line.match(/Region\s+\((-?\d+),\s*(-?\d+)\)\s+@/);
      if (regStart) {
        if (!etaData.firstRegionAt) etaData.firstRegionAt = Date.now();
        etaData.lastRegionAt = Date.now();
        etaData.regionsStarted++;
        etaData.wpDone = 0; etaData.wpTotal = 0; etaData.wpStart = null;
      }

      // Parse region complete: "Region ... complete in"
      const regDone = line.match(/Region\s+\((-?\d+),\s*(-?\d+)\)\s+complete/);
      if (regDone) {
        etaData.lastRegionAt = Date.now();
      }
    }
  } catch {}
}

async function doPrune(ios) {
  const emit = (step, total, msg, detail) => {
    ios.forEach(io => io.emit('prune-step', { step, total, msg, detail: detail||'' }));
  };

  emit(1, 5, 'Checking running containers...', '');
  elog(ios, 'Prune: scanning containers', 'info');
  const beforeNames = await getManagedContainerNames(true);
  const beforeBytes = await getContainerWritableBytes(beforeNames, true);
  const status = await getStatus();
  const running = Object.entries(status).filter(([,s]) => s === 'running');

  if (running.length > 0) {
    const names = running.map(([k]) => k).join(', ');
    emit(2, 5, 'Stopping: ' + names, 'docker compose stop ' + names);
    elog(ios, 'Prune: stopping ' + names, 'info');
    const r = await compose('stop ' + ALL_MANAGED_SERVICES.join(' '));
    emit(2, 5, 'Stopped: ' + names, r.stdout.slice(0,300) || r.stderr.slice(0,300) || 'done');
  } else {
    emit(2, 5, 'No running containers', 'nothing to stop');
  }

  emit(3, 5, 'Removing containers...', 'docker compose rm -sf ' + ALL_MANAGED_SERVICES.join(' '));
  elog(ios, 'Prune: removing containers', 'info');
  const dr = await compose('rm -sf ' + ALL_MANAGED_SERVICES.join(' '));
  emit(3, 5, 'Removed', dr.stdout.slice(0,200) || 'done');

  emit(4, 5, 'Building bot image...', 'docker compose build visitor');
  elog(ios, 'Prune: building bot image', 'info');
  const br = await compose('build visitor');
  emit(4, 5, br.ok ? 'Build complete' : 'Build FAILED', br.stdout.slice(-300) || br.stderr.slice(-300));

  const reclaimed = formatBytes(beforeBytes);
  emit(5, 5, 'Prune complete', `Estimated container writable space cleared: ${reclaimed}`);
  ios.forEach(io => io.emit('prune-done', { ok: br.ok, reclaimed }));
  elog(ios, br.ok ? `Prune complete - ${reclaimed} cleared, services not started` : 'Prune FAILED', br.ok ? 'done' : 'error');
}

async function doStop(ios, force = false) {
  const emit = (step, total, msg, detail) => ios.forEach(io => io.emit('op-step', { step, total, msg, detail: detail || '' }));
  emit(1, 4, force ? 'Force stopping visitor bots...' : 'Stopping visitor bots...', 'This prevents duplicate actions while containers shut down.');
  elog(ios, force ? 'Force stopping stack...' : 'Stopping stack...', 'info');
  const stopCmd = force ? 'kill' : 'stop';
  let r = await compose(`${stopCmd} ${ALL_VISITOR_SERVICES.join(' ')} 2>/dev/null`);
  emit(2, 4, 'Visitor bots stopped', r.stdout.slice(-500) || r.stderr.slice(-500) || 'done');
  r = await compose(`${stopCmd} mc 2>/dev/null`);
  emit(3, 4, 'Minecraft server stopped', r.stdout.slice(-500) || r.stderr.slice(-500) || 'done');
  r = await compose(`${stopCmd} bluemap 2>/dev/null`);
  if (force) await compose('rm -sf ' + ALL_MANAGED_SERVICES.join(' '));
  emit(4, 4, 'Stop complete', r.stdout.slice(-500) || r.stderr.slice(-500) || 'BlueMap CLI was not running');
  ios.forEach(io => io.emit('op-done', { ok: true, msg: 'Stop complete' }));
  elog(ios, 'Stop complete', 'done');
  await pushAllClients(ios);
}

async function doAction(ios, cmd) {
  console.log(`[action] ${cmd}`);
  if (cmd.startsWith('cmd:')) {
    const mcCmd = cmd.slice(4); elog(ios, '$ '+mcCmd, 'info');
    const result = await runServerCommand(mcCmd);
    ios.forEach(io => io.emit('cmd-result', result));
    elog(ios, result.slice(0,300), 'm');
    return;
  }
  if (cmd.startsWith('tp-bot:')) {
    const [, playerRaw, botRaw] = cmd.split(':');
    const player = decodeURIComponent(playerRaw || '').trim();
    const botId = decodeURIComponent(botRaw || '').trim();
    if (!/^[A-Za-z0-9_]{1,16}$/.test(player)) {
      elog(ios, 'Teleport failed: enter a valid Minecraft player name.', 'e');
      return;
    }
    const target = getBotStatuses().find(b => b.id === botId);
    if (!target) {
      elog(ios, 'Teleport failed: bot location is not available yet.', 'e');
      return;
    }
    const p = target.position;
    const tpCmd = `tp ${player} ${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}`;
    elog(ios, `Teleporting ${player} to ${target.username}...`, 'info');
    const result = await runServerCommand(tpCmd);
    ios.forEach(io => io.emit('cmd-result', result));
    elog(ios, result.slice(0,300), 'm');
    return;
  }
  if (cmd === 'force-stop') {
    await doStop(ios, true); return;
  }
  elog(ios, '> '+cmd, 'info');
  let r;
  switch (cmd) {
    case 'run-bot':
    case 'start-all': {
      const status = await getStatus(true);
      if (status.mc !== 'stopped' || status.visitor !== 'stopped') {
        elog(ios, 'Bot stack is already running or starting.', 'warn');
        break;
      }
      const count = getBotCount();
      await prepareWritableDirs();
      await compose('stop bluemap 2>/dev/null');
      await compose('rm -sf bluemap 2>/dev/null');
      r = await compose(`${composeProfile(count)}up -d ${botStackServices(count).join(' ')}`);
      etaData = { regionsStarted:0, firstRegionAt:null, lastRegionAt:null, wpTotal:0, wpDone:0, wpStart:null };
      elog(ios, r.ok?`Bot stack started (${count} bot${count===1?'':'s'})`:'FAILED: '+(r.stderr||'').slice(-200), r.ok?'done':'error');
      break;
    }
    case 'stop-all': await doStop(ios, false); return;
    case 'prune': await doPrune(ios); return;
    case 'start-mc': elog(ios, 'Start MC directly is disabled. Use Run the Bot.', 'warn'); break;
    case 'stop-mc': r = await compose('stop mc'); elog(ios, 'MC stopped', 'done'); break;
    case 'start-visitor': elog(ios, 'Start visitor directly is disabled. Use Run the Bot.', 'warn'); break;
    case 'stop-visitor': r = await compose('stop ' + ALL_VISITOR_SERVICES.join(' ')); elog(ios, 'Visitor stopped', 'done'); break;
    case 'start-bluemap': {
      const status = await getStatus(true);
      if (status.mc !== 'stopped' || status.visitor !== 'stopped') {
        elog(ios, 'CLI BlueMap is offline-only. Use Open BlueMap while the Minecraft server is running.', 'warn');
        break;
      }
      if (status.bluemap !== 'stopped') {
        elog(ios, 'BlueMap is already running or starting.', 'warn');
        break;
      }
      await prepareWritableDirs();
      r = await compose('--profile cli up -d bluemap'); elog(ios, 'BlueMap CLI render started', 'done'); break;
    }
    case 'stop-bluemap': r = await compose('stop bluemap'); elog(ios, 'BlueMap stopped', 'done'); break;
    case 'build': await compose('build visitor'); elog(ios, 'Build done', 'done'); break;
    default: elog(ios, 'Unknown: '+cmd, 'warn');
  }
  await pushAllClients(ios);
}

async function pushAll(io, quiet) {
  const [status, progress, stats] = await Promise.all([getStatus(quiet), Promise.resolve(getProgress()), getStats(quiet)]);
  const bluemapInfo = await getBlueMapInfo(status, quiet);
  io.emit('status', { ...status, progress, stats, eta: getETA(), conn: getConnectionInfo(status), bluemapInfo, bots: getBotStatuses(), markerInfo: getMarkerInfo() });
}

async function pushAllClients(ios, quiet) {
  await Promise.all(ios.map(io => pushAll(io, quiet)));
}

function setupServer(p) {
  const app = express(); app.use(express.json({ limit: '10mb' }));
  const srv = http.createServer(app);
  return { app, server: srv, io: new Server(srv, { maxHttpBufferSize: 1e7 }) };
}

function mountRoutes(app, ios) {
  app.use(express.static(path.join(__dirname, 'public')));
  app.get(/^\/bluemap$/, (req, res) => res.redirect('/bluemap/'));
  app.use('/bluemap', express.static(bluemapWebDir));
  app.get('/bluemap/*', (req, res) => {
    const index = path.join(bluemapWebDir, 'index.html');
    if (fs.existsSync(index)) res.sendFile(index);
    else res.status(404).send('BlueMap web output is not available yet.');
  });
  app.get('/api/env', (req, res) => res.json(readEnv()));
  app.get('/api/changelog', (req, res) => res.json(readChangelog()));
  app.get('/api/bug-artifact', (req, res) => {
    const full = bugArtifactPath(req.query.file);
    if (!full) return res.status(404).send('Artifact not found');
    res.download(full, path.basename(full));
  });
  app.get('/api/bug-watcher', (req, res) => res.json(getBugWatcherPublicStatus()));
  app.post('/api/bug-watcher/check', async (req, res) => {
    try {
      const checks = await queueBugCheckFailures();
      processNextBugTask(ios);
      res.json({ ok: true, failed: checks.failed.length, status: getBugWatcherPublicStatus() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
  app.post('/api/bug-report', async (req, res) => {
    try {
      const title = String(req.body.title || 'Site bug report').trim().slice(0, 160);
      const details = String(req.body.details || '').trim();
      if (!details) return res.status(400).json({ ok: false, error: 'Bug details are required' });
      if (req.body.ipConsent !== true) return res.status(400).json({ ok: false, error: 'IP collection consent is required once before submitting bug reports' });
      const severityRaw = String(req.body.severity || 'error').toLowerCase();
      const severity = ['critical', 'error', 'warning', 'feature'].includes(severityRaw) ? severityRaw : 'error';
      const createdAt = nowIso();
      const publicIpv4 = extractIpv4(req.body.publicIpv4) || await fetchServerPublicIpv4();
      const observedIpv4 = requestIpv4(req);
      const report = {
        id: `${Date.now()}-${hashText(`${title}\n${details}`).slice(0, 8)}`,
        title,
        severity,
        details,
        page: String(req.body.page || '').slice(0, 500),
        userAgent: String(req.body.userAgent || '').slice(0, 500),
        publicIpv4,
        observedIpv4,
        ipConsent: true,
        status: 'approved',
        approval: 'auto-approved',
        approvedAt: createdAt,
        comments: [
          { at: createdAt, kind: 'done', message: 'Report auto-approved. The watcher will queue or merge it with a related task without asking for more input.' },
          { at: createdAt, kind: 'info', message: `Captured IPv4 details with consent. Public IPv4: ${publicIpv4 || 'unknown'}; observed IPv4: ${observedIpv4 || 'unknown'}.` }
        ],
        createdAt,
        updatedAt: createdAt
      };
      bugWatcherState.reports.push(report);
      if (bugWatcherState.reports.length > 200) bugWatcherState.reports = bugWatcherState.reports.slice(-200);
      const task = enqueueBugTask({ source: 'bug-report', title, details: `${details}\n\nPage: ${report.page}\nUser-Agent: ${report.userAgent}\nPublic IPv4: ${report.publicIpv4 || 'unknown'}\nObserved IPv4: ${report.observedIpv4 || 'unknown'}`, severity, reportId: report.id });
      updateReport(report.id, { taskId: task.id, branch: task.branch, status: task.status === 'running' ? 'processing' : 'approved' });
      addReportComment(report.id, `Queued on branch ${task.branch}. How it should improve: related reports now share this branch so duplicate work is avoided.`, 'info');
      saveBugWatcherState();
      elog(ios, `Bug report queued: ${title}`, severity === 'warning' ? 'warn' : 'error');
      processNextBugTask(ios);
      res.json({ ok: true, report: publicBugReport(bugWatcherState.reports.find(r => r.id === report.id)), task: publicBugTask(task), status: getBugWatcherPublicStatus() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
  app.post('/api/bug-report/:id/comment', async (req, res) => {
    try {
      if (req.body.ipConsent !== true) return res.status(400).json({ ok: false, error: 'IP collection consent is required before adding bug report comments' });
      const report = bugWatcherState.reports.find(r => r.id === req.params.id);
      if (!report) return res.status(404).json({ ok: false, error: 'Bug report not found' });
      const message = String(req.body.message || '').trim();
      if (!message) return res.status(400).json({ ok: false, error: 'Comment text is required' });
      const publicIpv4 = extractIpv4(req.body.publicIpv4) || await fetchServerPublicIpv4();
      const observedIpv4 = requestIpv4(req);
      const comment = { at: nowIso(), kind: 'user', message, publicIpv4, observedIpv4 };
      const updated = addReportComment(report.id, comment, 'user');
      const activeTask = findTaskById(report.taskId);
      let task = activeTask;
      if (activeTask && !['completed', 'failed'].includes(activeTask.status)) {
        attachFeedbackToTask(activeTask, updated, comment);
        addReportComment(report.id, `Feedback attached to active task ${activeTask.id}. How it should improve: the current automated run will account for this comment before finishing.`, 'info');
      } else {
        task = enqueueBugTask({
          source: 'user-feedback',
          title: `Feedback: ${report.title}`,
          severity: report.severity || 'warning',
          branch: report.branch || undefined,
          signature: `feedback:${report.id}:${hashText(message).slice(0, 12)}`,
          reportId: report.id,
          details: `User feedback requested improvements for report ${report.id}.\n\nReport title: ${report.title}\nOriginal details:\n${report.details || ''}\n\nUser feedback:\n${message}\n\nPublic IPv4: ${publicIpv4 || 'unknown'}\nObserved IPv4: ${observedIpv4 || 'unknown'}`
        });
        updateReport(report.id, { taskId: task.id, branch: task.branch, status: 'approved' });
        addReportComment(report.id, `Feedback queued for automated improvement on branch ${task.branch}. How it should improve: the checker will run opencode again using this comment as additional requirements.`, 'info');
      }
      processNextBugTask(ios);
      res.json({ ok: true, report: publicBugReport(bugWatcherState.reports.find(r => r.id === report.id)), task: publicBugTask(task), status: getBugWatcherPublicStatus() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
  app.delete('/api/bug-task/:id', (req, res) => {
    try {
      if (bugWatcherState.current?.id === req.params.id) {
        const task = bugWatcherState.current;
        task.cancelRequested = true;
        task.summary = 'Cancellation requested by user.';
        task.updatedAt = nowIso();
        if (activeBugWatcherChild?.taskId === task.id) {
          activeBugWatcherChild.child.kill('SIGTERM');
          setTimeout(() => {
            try { if (activeBugWatcherChild?.taskId === task.id) activeBugWatcherChild.child.kill('SIGKILL'); } catch {}
          }, 10000);
        }
        updateReportsForTask(task, 'processing', { summary: task.summary });
        saveBugWatcherState();
        return res.json({ ok: true, status: getBugWatcherPublicStatus() });
      }
      const task = bugWatcherState.queue.find(t => t.id === req.params.id);
      if (!task) return res.status(404).json({ ok: false, error: 'Queued task not found' });
      bugWatcherState.queue = bugWatcherState.queue.filter(t => t.id !== task.id);
      finishCancelledBugTask(task);
      for (const reportId of task.reportIds || []) addReportComment(reportId, `Removed queued task ${task.id} from ${task.branch}.`, 'warn');
      res.json({ ok: true, status: getBugWatcherPublicStatus() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
  app.post('/api/bug-task/:id/retry', (req, res) => {
    try {
      const requeued = requeueFailedBugTasks([req.params.id]);
      if (!requeued.length) return res.status(404).json({ ok: false, error: 'Retryable task not found' });
      processNextBugTask(ios);
      res.json({ ok: true, requeued: requeued.length, status: getBugWatcherPublicStatus() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
  app.post('/api/bug-task/:id/retry-now', (req, res) => {
    try {
      const task = bugWatcherState.queue.find(t => t.id === req.params.id);
      if (!task) return res.status(404).json({ ok: false, error: 'Queued task not found' });
      task.status = 'queued';
      task.updatedAt = nowIso();
      task.summary = `${task.summary || 'Queued for retry.'} Retry requested now.`.trim();
      delete task.nextRetryAt;
      normalizeTaskBranch(task);
      updateReportsForTask(task, 'approved', { summary: task.summary, nextRetryAt: '' });
      saveBugWatcherState();
      processNextBugTask(ios);
      res.json({ ok: true, status: getBugWatcherPublicStatus() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
  app.post('/api/bug-tasks/retry', (req, res) => {
    try {
      const requeued = requeueFailedBugTasks(req.body.ids || []);
      if (!requeued.length) return res.status(400).json({ ok: false, error: 'Select at least one failed task to retry' });
      processNextBugTask(ios);
      res.json({ ok: true, requeued: requeued.length, status: getBugWatcherPublicStatus() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
  app.post('/api/bug-tasks/process-all', (req, res) => {
    try {
      const result = processAllBugTasksNow();
      processNextBugTask(ios);
      res.json({ ok: true, ...result, status: getBugWatcherPublicStatus() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
  app.post('/api/bug-task/:id/reject-merge', async (req, res) => {
    try {
      const task = findAnyTaskById(req.params.id);
      if (!task) return res.status(404).json({ ok: false, error: 'Task not found' });
      const reason = String(req.body.reason || 'User rejected automatic merge').trim().slice(0, 1000);
      task.mergeRejected = true;
      task.mergeStatus = 'blocked';
      task.updatedAt = nowIso();
      for (const reportId of task.reportIds || []) {
        updateReport(reportId, { mergeRejected: true, mergeStatus: 'blocked' });
        addReportComment(reportId, { kind: 'rejection', message: `Auto-merge rejected: ${reason}`, publicIpv4: extractIpv4(req.body.publicIpv4) || await fetchServerPublicIpv4(), observedIpv4: requestIpv4(req) }, 'rejection');
      }
      saveBugWatcherState();
      res.json({ ok: true, status: getBugWatcherPublicStatus() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
  app.get('/api/states', (req, res) => res.json(readStates()));
  app.post('/api/states', (req, res) => {
    try {
      ensureDir(stateDir);
      const { file, full } = statePathFor(req.body.name);
      const data = parseStateBody(req.body);
      fs.writeFileSync(full, JSON.stringify(data, null, 2));
      elog(ios, `State saved: ${file}`, 'done');
      res.json({ ok: true, file, states: readStates() });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });
  app.delete('/api/states/:name', (req, res) => {
    try {
      const { file, full } = statePathFor(req.params.name);
      if (!fs.existsSync(full)) return res.status(404).json({ ok: false, error: 'State file not found' });
      fs.unlinkSync(full);
      elog(ios, `State deleted: ${file}`, 'warn');
      res.json({ ok: true, states: readStates() });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });
  app.post('/api/wizard', async (req, res) => {
    try { writeEnv(req.body); elog(ios, 'Config saved', 'done'); res.json({ok:true}); }
    catch (err) { res.status(500).json({ok:false, error:err.message}); }
  });
  app.post('/api/world/import', async (req, res) => {
    try {
      const result = await importWorldZip(req, ios);
      res.json({ ok: true, ...result, target: path.relative(PROJECT_DIR, result.target), backup: result.backup ? path.relative(PROJECT_DIR, result.backup) : '' });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });
  app.post('/api/action', async (req, res) => { res.json({ok:true}); doAction(ios, req.body.cmd); });
  app.get('/map/*', (req, res) => res.redirect(`http://${DOMAIN}:${BLUEMAP_PORT}`));
}

async function main() {
  await resolveHostProjectDir();
  if (BUG_WATCHER_ENABLED) initBugWatcherState();
  else normalizeBugState();
  const s1 = setupServer(PORT), s2 = setupServer(PORT2);
  const ios = [s1.io, s2.io];
  mountRoutes(s1.app, ios); mountRoutes(s2.app, ios);

  ios.forEach(io => { io.on('connection', socket => { elog(io, 'Connected', 'info'); pushAll(io); socket.on('action', cmd => doAction(ios, cmd)); }); });

  setInterval(async () => {
    for (const io of ios) await pushAll(io, true);
    await syncVisitorLogs(ios);
    try {
      const { stdout } = await run(`docker compose --project-directory ${PROJECT_DIR} logs mc --tail 12 2>/dev/null`, true);
      for (const line of stdout.trim().split('\n').filter(Boolean).slice(-8)) {
        if (seenMcLogs.includes(line)) continue;
        seenMcLogs.push(line);
        if (seenMcLogs.length > 200) seenMcLogs.shift();
        ios.forEach(io => emc(io, line.slice(0,500)));
      }
    } catch {}
    try {
      const { stdout } = await run(`docker compose --project-directory ${PROJECT_DIR} logs bluemap --tail 12 2>/dev/null`, true);
      for (const line of stdout.trim().split('\n').filter(Boolean).slice(-8)) {
        if (seenBmLogs.includes(line)) continue;
        seenBmLogs.push(line);
        if (seenBmLogs.length > 200) seenBmLogs.shift();
        ios.forEach(io => ebm(io, line.slice(0,500)));
      }
    } catch {}
  }, 4000);

  if (BUG_WATCHER_ENABLED && bugWatcherWritable) {
    installMissingDependencies().catch(err => console.error('[bug-watcher] dependency install failed:', err.message));
    setTimeout(async () => {
      try { await queueBugCheckFailures(); await processNextBugTask(ios); await processAutoMerges(ios); }
      catch (err) { console.error('[bug-watcher]', err.message); }
    }, 10000);
    setInterval(async () => {
      try { await queueBugCheckFailures(); await processNextBugTask(ios); await processAutoMerges(ios); }
      catch (err) { console.error('[bug-watcher]', err.message); }
    }, BUG_WATCHER_INTERVAL_MS);
    setInterval(() => { processNextBugTask(ios).catch(err => console.error('[bug-watcher]', err.message)); }, 10000);
    setInterval(() => { processAutoMerges(ios).catch(err => console.error('[bug-watcher]', err.message)); }, 15000);
  }

  s1.server.listen(PORT, () => console.log(`Panel: http://0.0.0.0:${PORT} (IP: ${LOCAL_IP})`));
  s2.server.listen(PORT2, () => console.log(`Panel: http://0.0.0.0:${PORT2} (IP: ${LOCAL_IP})`));
}

main().catch(console.error);
