import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, openSync, closeSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const executable = '/Applications/Chromium.app/Contents/MacOS/Chromium';
const extension = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidence = mkdtempSync(join(tmpdir(), 'tab-closer-lifecycle-'));
const profile = join(evidence, 'profile');
mkdirSync(profile);
const server = createServer((_, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><title>Lifecycle fixture</title>');
});
try {
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
} catch (error) {
  rmSync(profile, { recursive: true, force: true });
  throw error;
}
const url = `http://127.0.0.1:${server.address().port}/persist`;
const results = [];
const delay = ms => new Promise(done => setTimeout(done, ms));

async function launch(run) {
  const fd = openSync(join(evidence, `browser-${run}.log`), 'w');
  const child = spawn(executable, [
    '--headless=new', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-sync', '--metrics-recording-only',
    '--user-data-dir=' + profile, '--load-extension=' + extension,
    '--remote-debugging-pipe', 'about:blank'
  ], { stdio: ['ignore', fd, fd, 'pipe', 'pipe'] });
  let nextId = 0, buffer = '';
  const pending = new Map();
  child.stdio[4].on('data', chunk => {
    buffer += chunk.toString();
    let end;
    while ((end = buffer.indexOf('\0')) >= 0) {
      const reply = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      const request = pending.get(reply.id);
      if (!request) continue;
      pending.delete(reply.id);
      clearTimeout(request.timer);
      if (reply.error) request.reject(Error(JSON.stringify(reply.error)));
      else request.resolve(reply.result);
    }
  });
  function call(method, params = {}, sessionId) {
    const id = ++nextId;
    return new Promise((done, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 10000);
      pending.set(id, { resolve: done, reject, timer });
      child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
    });
  }
  async function evaluate(session, expression) {
    const reply = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
    if (reply.exceptionDetails) throw Error(JSON.stringify(reply.exceptionDetails));
    return reply.result.value;
  }
  async function until(label, predicate, count = 60) {
    for (let n = 0; n < count; n++) {
      if (await predicate()) return;
      await delay(100);
    }
    throw Error(`Timed out: ${label}`);
  }
  await until('extension worker', async () => (await call('Target.getTargets')).targetInfos.some(target => target.type === 'service_worker' && target.url.endsWith('/background.js')));
  const version = await call('Browser.getVersion');
  const worker = (await call('Target.getTargets')).targetInfos.find(target => target.type === 'service_worker' && target.url.endsWith('/background.js'));
  const extensionId = new URL(worker.url).host;
  const target = await call('Target.createTarget', { url: `chrome-extension://${extensionId}/options.html` });
  const options = (await call('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
  await until('options ready', async () => await evaluate(options, '!!document.querySelector(".filter-row input")'));
  async function close() {
    try { await call('Browser.close'); } catch {}
    child.kill('SIGTERM');
    if (child.exitCode === null) await new Promise(done => child.once('exit', done));
    closeSync(fd);
  }
  return { call, evaluate, until, options, extensionId, version: version.product, close };
}
let active;
let failure;
try {
  active = await launch('first');
  results.push({ label: 'first browser version', value: active.version });
  const rule = '^' + url.replaceAll('.', '\\.') + '$';
  await active.evaluate(active.options, `(() => { const input=document.querySelector('.filter-row input'); input.value=${JSON.stringify(rule)}; input.dispatchEvent(new Event('input',{bubbles:true})); document.querySelector('#save').click(); })()`);
  await active.until('rule saved before restart', async () => (await active.evaluate(active.options, `document.querySelector('#save-status').textContent`)).startsWith('Filters saved.'));
  results.push({ label: 'rule saved before browser restart', pass: true, rule });
  await active.close();
  active = await launch('second');
  results.push({ label: 'second browser version', value: active.version });
  const stored = await active.evaluate(active.options, 'chrome.storage.local.get("settings").then(x => x.settings)');
  assert.equal(stored.rules, rule);
  assert.equal(await active.evaluate(active.options, 'document.querySelector(".filter-row input").value'), rule);
  results.push({ label: 'saved rule visible after browser restart', pass: true });
  const tabId = await active.evaluate(active.options, `chrome.tabs.create({url:${JSON.stringify(url)}}).then(tab => tab.id)`);
  await active.until('matching tab closed after restart', async () => !(await active.evaluate(active.options, 'chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id))')).includes(tabId));
  results.push({ label: 'matching completion closes after browser restart', pass: true });
  // No debugger is attached to the worker. A genuine idle shutdown is observable as target disappearance.
  const workerUrl = `chrome-extension://${active.extensionId}/background.js`;
  let idled = false;
  for (let n = 0; n < 40; n++) {
    await delay(1000);
    const targets = await active.call('Target.getTargets');
    if (!targets.targetInfos.some(target => target.type === 'service_worker' && target.url === workerUrl)) { idled = true; break; }
  }
  results.push({ label: 'worker target disappeared after idle wait', pass: idled, observed: idled, note: idled ? undefined : 'Idle shutdown was not observed within 40 seconds.' });
  if (idled) {
    const laterTab = await active.evaluate(active.options, `chrome.tabs.create({url:${JSON.stringify(url)}}).then(tab => tab.id)`);
    await active.until('matching tab closed after idle', async () => !(await active.evaluate(active.options, 'chrome.tabs.query({}).then(tabs => tabs.map(tab => tab.id))')).includes(laterTab));
    results.push({ label: 'completion closes after observed worker idle', pass: true });
  }
} catch (error) {
  failure = error;
  results.push({ label: 'run failure', pass: false, error: String(error) });
  console.error(error);
} finally {
  if (active) await active.close().catch(() => {});
  await new Promise(done => server.close(done));
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  writeFileSync(join(evidence, 'results.json'), JSON.stringify({ executable, node: process.version, nodeExecutable: process.execPath, extension, url, results }, null, 2) + '\n');
  for (const result of results) console.log(`${result.pass ? 'PASS' : 'UNVERIFIED'} ${result.label}`);
  console.log(`EVIDENCE ${evidence}`);
}
if (failure) process.exitCode = 1;
