import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, openSync, closeSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const browser = process.argv[2] || 'chromium';
const uiOnly = process.argv.includes('--ui-only');
const executable = browser === 'edge'
  ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  : '/Applications/Chromium.app/Contents/MacOS/Chromium';
const extension = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidence = mkdtempSync(join(tmpdir(), `tab-closer-${browser}-`));
const profile = join(evidence, 'profile');
mkdirSync(profile);
const logPath = join(evidence, 'browser.log');
const logFd = openSync(logPath, 'w');
const results = [];
const requests = [];
let releaseSlow;
const slow = new Promise(resolveSlow => { releaseSlow = resolveSlow; });
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  requests.push(path);
  if (path === '/redirect') { response.writeHead(302, { Location: '/destination?ok=1#done' }); response.end(); return; }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (path === '/http-error') response.statusCode = 404;
  if (path === '/slow') await slow;
  const body = `<!doctype html><title>${path}</title><h1>Local fixture</h1>`;
  if (path === '/iframe') { response.end(body + '<iframe src="/child"></iframe>'); return; }
  response.end(body);
});
try {
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
} catch (error) {
  closeSync(logFd);
  rmSync(profile, { recursive: true, force: true });
  throw error;
}
const base = `http://127.0.0.1:${server.address().port}`;
const child = spawn(executable, [
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-sync', '--metrics-recording-only',
  '--user-data-dir=' + profile, '--load-extension=' + extension,
  '--remote-debugging-pipe', 'about:blank'
], { stdio: ['ignore', logFd, logFd, 'pipe', 'pipe'] });
const pending = new Map();
let id = 0, buffer = '';
child.stdio[4].on('data', bytes => {
  buffer += bytes.toString();
  let end;
  while ((end = buffer.indexOf('\0')) >= 0) {
    const reply = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    const entry = pending.get(reply.id);
    if (!entry) continue;
    pending.delete(reply.id);
    clearTimeout(entry.timer);
    if (reply.error) entry.reject(new Error(JSON.stringify(reply.error)));
    else entry.resolve(reply.result);
  }
});
function call(method, params = {}, sessionId) {
  const requestId = ++id;
  return new Promise((resolveCall, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(requestId, { resolve: resolveCall, reject, timer });
    child.stdio[3].write(JSON.stringify({ id: requestId, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
}
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
async function evaluate(session, expression) {
  const reply = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
  if (reply.exceptionDetails) throw Error(JSON.stringify(reply.exceptionDetails));
  return reply.result.value;
}
async function until(label, predicate, max = 50) {
  for (let n = 0; n < max; n++) {
    if (await predicate()) return;
    await delay(100);
  }
  throw Error(`Timed out: ${label}`);
}
async function checkpoint(label, run) {
  const value = await run();
  results.push({ label, pass: true, ...(value === undefined ? {} : { value }) });
  console.log(`PASS ${label}`);
}
let optionsSession, extensionId;
async function tabs() {
  return evaluate(optionsSession, 'chrome.tabs.query({}).then(tabs => tabs.map(({id,url,status,pinned,active,pendingUrl}) => ({id,url,status,pinned,active,pendingUrl})))');
}
async function saveRules(source) {
  await setDraft(source);
  await evaluate(optionsSession, `document.querySelector('#save').click()`);
  await until('settings save', async () => (await evaluate(optionsSession, `document.querySelector('#save-status').textContent`)).startsWith('Filters saved.'));
}
async function setDraft(source) {
  await evaluate(optionsSession, `(() => {
    const values = ${JSON.stringify(source)}.split(/\\r?\\n/);
    const rows = () => [...document.querySelectorAll('.filter-row')];
    while (rows().length > 1) rows().at(-1).querySelector('.remove-filter').click();
    for (let index = 1; index < values.length; index++) document.querySelector('#add-filter').click();
    values.forEach((value, index) => {
      const input = rows()[index].querySelector('input');
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  })()`);
}
async function draftRows() {
  return evaluate(optionsSession, `[...document.querySelectorAll('.filter-row')].map(row => ({label:row.querySelector('label').textContent,value:row.querySelector('input').value,type:row.querySelector('input').type,id:row.querySelector('input').id}))`);
}
async function highlightedFilters() {
  return evaluate(optionsSession, `[...document.querySelectorAll('.filter-row')].flatMap((row, index) => row.classList.contains('matching-filter') ? [index + 1] : [])`);
}
async function testUrl(url) {
  await evaluate(optionsSession, `(() => {
    const input = document.querySelector('#test-url');
    input.value = ${JSON.stringify(url)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#test').click();
  })()`);
}
async function createTab(url, active = true, pinned = false) {
  return evaluate(optionsSession, `chrome.tabs.create({url:${JSON.stringify(url)},active:${active},pinned:${pinned}}).then(tab => tab.id)`);
}
async function waitGone(tabId) { await until(`tab ${tabId} removed`, async () => !(await tabs()).some(tab => tab.id === tabId)); }
async function waitPresent(tabId) { await until(`tab ${tabId} present`, async () => (await tabs()).some(tab => tab.id === tabId)); }
let failure;
try {
  const version = await call('Browser.getVersion');
  results.push({ label: 'browser version', value: version.product });
  let worker;
  await until('extension worker', async () => {
    const targets = await call('Target.getTargets');
    worker = targets.targetInfos.find(target => target.type === 'service_worker' && target.url.endsWith('/background.js'));
    return !!worker;
  });
  extensionId = new URL(worker.url).host;
  const optionsTarget = await call('Target.createTarget', { url: `chrome-extension://${extensionId}/options.html` });
  optionsSession = (await call('Target.attachToTarget', { targetId: optionsTarget.targetId, flatten: true })).sessionId;
  await until('options loaded', async () => (await evaluate(optionsSession, 'document.readyState')) === 'complete');
  await until('filter editor ready', async () => (await draftRows()).length === 1);
  await until('saved filters loaded', async () => (await evaluate(optionsSession, `document.querySelector('#save-status').textContent`)) === 'Saved filters loaded.');
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, optionsSession);
  await checkpoint('options page renders with empty settings', async () => {
    const state = await evaluate(optionsSession, `({title:document.title,status:document.querySelector('#save-status').textContent,add:document.querySelector('#add-filter').textContent})`);
    assert.deepEqual(await draftRows(), [{ label: 'Filter 1', value: '', type: 'text', id: 'filter-1' }]);
    assert.equal(state.title, 'Tab Closer settings');
    assert.equal(state.add, 'Add filter');
    return state;
  });
  await checkpoint('add and remove filters renumbers rows and keeps one empty field', async () => {
    await setDraft('first\nsecond\nthird');
    assert.deepEqual((await draftRows()).map(row => row.value), ['first', 'second', 'third']);
    await evaluate(optionsSession, `document.querySelectorAll('.remove-filter')[1].click()`);
    assert.deepEqual((await draftRows()).map(row => [row.label, row.value, row.id]), [['Filter 1', 'first', 'filter-1'], ['Filter 2', 'third', 'filter-2']]);
    assert.deepEqual(await evaluate(optionsSession, `[...document.querySelectorAll('.escape-filter')].map(button => button.getAttribute('aria-label'))`), ['Add escape characters to filter 1', 'Add escape characters to filter 2']);
    await evaluate(optionsSession, `document.querySelectorAll('.remove-filter')[1].click(); document.querySelector('.remove-filter').click()`);
    assert.deepEqual((await draftRows()).map(row => row.value), ['']);
  });
  await checkpoint('invalid draft cannot replace saved rules', async () => {
    await saveRules('^' + base.replaceAll('.', '\\.') + '/keep$');
    const saved = await evaluate(optionsSession, `chrome.storage.local.get('settings').then(x => x.settings)`);
    await setDraft('valid\n(');
    await evaluate(optionsSession, `document.querySelector('#save').click()`);
    const state = await evaluate(optionsSession, `document.querySelector('#save-status').textContent`);
    assert.match(state, /Filter 2 failed during validation/);
    assert.deepEqual((await draftRows()).map(row => row.value), ['valid', '(']);
    assert.deepEqual(await evaluate(optionsSession, `chrome.storage.local.get('settings').then(x => x.settings)`), saved);
    return state;
  });
  await checkpoint('escape button converts one pasted URL in the draft and clears old test results', async () => {
    const url = base + '/a.b?tags=[red+blue]&next=(x|y)#done';
    const saved = await evaluate(optionsSession, `chrome.storage.local.get('settings').then(x => x.settings)`);
    await setDraft('test\n' + url);
    await testUrl(base + '/test');
    assert.deepEqual(await highlightedFilters(), [1]);
    await evaluate(optionsSession, `document.querySelectorAll('.escape-filter')[1].click()`);
    const rows = await draftRows();
    assert.equal(rows[0].value, 'test');
    assert.equal(rows[1].value, base.replaceAll('.', '\\.') + '/a\\.b\\?tags=\\[red\\+blue\\]&next=\\(x\\|y\\)#done');
    assert.equal(await evaluate(optionsSession, `document.querySelector('#save-status').textContent`), 'Unsaved draft.');
    assert.equal(await evaluate(optionsSession, `document.querySelector('#test-status').textContent`), '');
    assert.deepEqual(await highlightedFilters(), []);
    assert.deepEqual(await evaluate(optionsSession, `chrome.storage.local.get('settings').then(x => x.settings)`), saved);
    await testUrl(url);
    assert.equal(await evaluate(optionsSession, `document.querySelector('#test-status').textContent`), 'Matching filters: 2.');
    assert.deepEqual(await highlightedFilters(), [2]);
    const screenshot = await call('Page.captureScreenshot', { format: 'png' }, optionsSession);
    writeFileSync(join(evidence, 'options-escaped-url.png'), Buffer.from(screenshot.data, 'base64'));
    await call('Emulation.setDeviceMetricsOverride', { width: 375, height: 900, deviceScaleFactor: 1, mobile: false }, optionsSession);
    assert.equal(await evaluate(optionsSession, `document.documentElement.scrollWidth <= window.innerWidth`), true);
    const narrowScreenshot = await call('Page.captureScreenshot', { format: 'png' }, optionsSession);
    writeFileSync(join(evidence, 'options-escaped-url-narrow.png'), Buffer.from(narrowScreenshot.data, 'base64'));
    await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, optionsSession);
    await testUrl(url.replace('/a.b', '/aXb'));
    assert.equal(await evaluate(optionsSession, `document.querySelector('#test-status').textContent`), 'No matching filters.');
    await testUrl('prefix' + url + 'suffix');
    assert.equal(await evaluate(optionsSession, `document.querySelector('#test-status').textContent`), 'Matching filters: 2.');
  });
  await checkpoint('tester highlights matching draft fields and keeps numbered result', async () => {
    await setDraft('^' + base.replaceAll('.', '\\.') + '/test\\?q=1#done$\n\n(?i:test)');
    await testUrl(base + '/test?q=1#done');
    const status = await evaluate(optionsSession, `document.querySelector('#test-status').textContent`);
    assert.equal(status, 'Matching filters: 1, 3.');
    assert.deepEqual(await highlightedFilters(), [1, 3]);
    const colors = await evaluate(optionsSession, `[...document.querySelectorAll('.filter-input')].map(input => getComputedStyle(input).backgroundColor)`);
    assert.equal(colors[0], colors[2]);
    assert.notEqual(colors[0], colors[1]);
    const borders = await evaluate(optionsSession, `[...document.querySelectorAll('.filter-input')].map(input => [getComputedStyle(input).borderTopColor, getComputedStyle(input).borderTopWidth])`);
    assert.deepEqual(borders[0], borders[1]);
    assert.deepEqual(borders[2], borders[1]);
    const screenshot = await call('Page.captureScreenshot', { format: 'png' }, optionsSession);
    writeFileSync(join(evidence, 'options-highlighted-filters.png'), Buffer.from(screenshot.data, 'base64'));
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, optionsSession);
    const darkColors = await evaluate(optionsSession, `[...document.querySelectorAll('.filter-input')].map(input => getComputedStyle(input).backgroundColor)`);
    assert.equal(darkColors[0], darkColors[2]);
    assert.notEqual(darkColors[0], darkColors[1]);
    assert.notEqual(darkColors[0], colors[0]);
    const darkBorders = await evaluate(optionsSession, `[...document.querySelectorAll('.filter-input')].map(input => [getComputedStyle(input).borderTopColor, getComputedStyle(input).borderTopWidth])`);
    assert.deepEqual(darkBorders[0], darkBorders[1]);
    assert.deepEqual(darkBorders[2], darkBorders[1]);
    const darkScreenshot = await call('Page.captureScreenshot', { format: 'png' }, optionsSession);
    writeFileSync(join(evidence, 'options-highlighted-filters-dark.png'), Buffer.from(darkScreenshot.data, 'base64'));
    await call('Emulation.setEmulatedMedia', { features: [] }, optionsSession);
    return status;
  });
  await checkpoint('editing test URL and rerunning a nonmatch clears highlights', async () => {
    await evaluate(optionsSession, `(() => {
      const input = document.querySelector('#test-url');
      input.value = ${JSON.stringify(base + '/other')};
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    assert.deepEqual(await highlightedFilters(), []);
    assert.equal(await evaluate(optionsSession, `document.querySelector('#test-status').textContent`), '');
    await evaluate(optionsSession, `document.querySelector('#test').click()`);
    assert.deepEqual(await highlightedFilters(), []);
    assert.equal(await evaluate(optionsSession, `document.querySelector('#test-status').textContent`), 'No matching filters.');
    await testUrl(base + '/test?q=1#done');
    assert.deepEqual(await highlightedFilters(), [1, 3]);
    await evaluate(optionsSession, `document.querySelector('#test-url').value=${JSON.stringify(base + '/other')}; document.querySelector('#test').click()`);
    assert.deepEqual(await highlightedFilters(), []);
    assert.equal(await evaluate(optionsSession, `document.querySelector('#test-status').textContent`), 'No matching filters.');
  });
  await checkpoint('validation and injected matching errors clear highlights', async () => {
    await setDraft('test\nother');
    await testUrl(base + '/test');
    assert.deepEqual(await highlightedFilters(), [1]);
    await evaluate(optionsSession, `(() => {
      const input = document.querySelectorAll('.filter-input')[1];
      input.value = '(';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#test').click();
    })()`);
    assert.deepEqual(await highlightedFilters(), []);
    assert.match(await evaluate(optionsSession, `document.querySelector('#test-status').textContent`), /Filter 2 failed during validation/);
    await setDraft('test\nother');
    await testUrl(base + '/test');
    assert.deepEqual(await highlightedFilters(), [1]);
    const injectedStatus = await evaluate(optionsSession, `(() => {
      const original = RegExp.prototype.test;
      try {
        RegExp.prototype.test = function () { throw Error('test-only injected matching failure'); };
        document.querySelector('#test').click();
        return document.querySelector('#test-status').textContent;
      } finally {
        RegExp.prototype.test = original;
      }
    })()`);
    assert.equal(injectedStatus, 'Filter 1 failed during matching.');
    assert.deepEqual(await highlightedFilters(), []);
  });
  await checkpoint('editing, adding, and removing filters clear highlights', async () => {
    await setDraft('test\nother');
    await testUrl(base + '/test');
    await evaluate(optionsSession, `(() => {
      const input = document.querySelector('.filter-input');
      input.value = 'changed';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    assert.deepEqual(await highlightedFilters(), []);
    assert.equal(await evaluate(optionsSession, `document.querySelector('#test-status').textContent`), '');
    await setDraft('test\nother');
    await testUrl(base + '/test');
    await evaluate(optionsSession, `document.querySelector('#add-filter').click()`);
    assert.deepEqual(await highlightedFilters(), []);
    assert.equal(await evaluate(optionsSession, `document.querySelector('#test-status').textContent`), '');
    await testUrl(base + '/test');
    await evaluate(optionsSession, `document.querySelectorAll('.remove-filter')[1].click()`);
    assert.deepEqual(await highlightedFilters(), []);
    assert.equal(await evaluate(optionsSession, `document.querySelector('#test-status').textContent`), '');
  });
  if (!uiOnly) {
    await checkpoint('previous multiline storage loads into separate fields', async () => {
      const legacy = 'old\n\n^https://example\\.test/';
      await evaluate(optionsSession, `chrome.storage.local.set({settings:{version:1,revision:crypto.randomUUID(),rules:${JSON.stringify(legacy)}}})`);
      await call('Page.reload', {}, optionsSession);
      await until('legacy options loaded', async () => (await draftRows()).length === 3);
      assert.deepEqual((await draftRows()).map(row => row.value), legacy.split('\n'));
      assert.equal(await evaluate(optionsSession, `chrome.storage.local.get('settings').then(x => x.settings.rules)`), legacy);
      await evaluate(optionsSession, `document.querySelector('#save').click()`);
      await until('legacy filters saved', async () => (await evaluate(optionsSession, `document.querySelector('#save-status').textContent`)).startsWith('Filters saved.'));
      assert.equal(await evaluate(optionsSession, `chrome.storage.local.get('settings').then(x => x.settings.rules)`), legacy);
    });
    await checkpoint('injected storage failure retains draft and saved rules', async () => {
      const before = await evaluate(optionsSession, `chrome.storage.local.get('settings').then(x => x.settings)`);
      const injected = await evaluate(optionsSession, `(() => { window.__savedSet = chrome.storage.local.set; const fail = async () => { throw Error('injected failure'); }; chrome.storage.local.set = fail; return chrome.storage.local.set === fail; })()`);
      assert.equal(injected, true);
      try {
        await setDraft('^failure-draft$');
        await evaluate(optionsSession, `document.querySelector('#save').click()`);
        await until('injected save failure status', async () => (await evaluate(optionsSession, `document.querySelector('#save-status').textContent`)).startsWith('Could not save filters.'));
        assert.deepEqual((await draftRows()).map(row => row.value), ['^failure-draft$']);
        assert.deepEqual(await evaluate(optionsSession, `chrome.storage.local.get('settings').then(x => x.settings)`), before);
      } finally {
        await evaluate(optionsSession, `chrome.storage.local.set = window.__savedSet; delete window.__savedSet;`);
      }
    });
    await saveRules('^' + base.replaceAll('.', '\\.') + '/slow$');
    await checkpoint('matching tab stays open while response is loading and closes on completion', async () => {
      const tabId = await createTab(base + '/slow');
      await until('slow request started', async () => requests.includes('/slow'));
      await waitPresent(tabId);
      assert.ok((await tabs()).some(tab => tab.id === tabId));
      releaseSlow();
      await waitGone(tabId);
    });
    await checkpoint('nonmatching tab remains open', async () => {
      const tabId = await createTab(base + '/keep');
      await until('nonmatch complete', async () => (await tabs()).some(tab => tab.id === tabId && tab.status === 'complete'));
      assert.ok((await tabs()).some(tab => tab.id === tabId));
    });
    if (browser === 'chromium') {
      await saveRules('^' + base.replaceAll('.', '\\.') + '/(selected|background|pinned|destination|http-error|child)$');
      await checkpoint('selected, background, and pinned matching tabs close', async () => {
        for (const [path, active, pinned] of [['selected', true, false], ['background', false, false], ['pinned', false, true]]) {
          const tabId = await createTab(base + '/' + path, active, pinned);
          await waitGone(tabId);
        }
      });
      await checkpoint('redirect destination and HTTP 404 document close', async () => {
        // The redirected URL includes query and fragment, so use a separate destination rule.
        await saveRules('^' + base.replaceAll('.', '\\.') + '/destination\\?ok=1#done$\n^' + base.replaceAll('.', '\\.') + '/http-error$');
        for (const path of ['redirect', 'http-error']) await waitGone(await createTab(base + '/' + path));
      });
      await checkpoint('iframe and same-document URL changes do not close a tab', async () => {
        await saveRules('^' + base.replaceAll('.', '\\.') + '/child$\nmatched-by-history\nmatched-by-fragment');
        const iframe = await createTab(base + '/iframe');
        const history = await createTab(base + '/history');
        await until('iframe and history complete', async () => {
          const open = await tabs();
          return [iframe, history].every(id => open.some(tab => tab.id === id && tab.status === 'complete'));
        });
        const targets = await call('Target.getTargets');
        const target = targets.targetInfos.find(item => item.type === 'page' && item.url === base + '/history');
        assert.ok(target, 'history tab target');
        const session = (await call('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
        await evaluate(session, `history.pushState({}, '', '/matched-by-history'); location.hash = 'matched-by-fragment';`);
        await delay(300);
        assert.ok((await tabs()).some(tab => tab.id === iframe));
        assert.ok((await tabs()).some(tab => tab.id === history));
      });
      await checkpoint('saving rules does not scan an already loaded tab; a reload closes it', async () => {
        await saveRules('');
        const tabId = await createTab(base + '/save-scope');
        await until('save-scope complete', async () => (await tabs()).some(tab => tab.id === tabId && tab.status === 'complete'));
        await saveRules('^' + base.replaceAll('.', '\\.') + '/save-scope$');
        await delay(300);
        assert.ok((await tabs()).some(tab => tab.id === tabId));
        await evaluate(optionsSession, `chrome.tabs.reload(${tabId})`);
        await waitGone(tabId);
      });
      await checkpoint('back-forward cache restoration can trigger closure', async () => {
        await saveRules('');
        await evaluate(optionsSession, `window.__completions=[]; chrome.webNavigation.onCompleted.addListener(details => window.__completions.push({tabId:details.tabId,frameId:details.frameId,url:details.url,documentId:details.documentId}));`);
        const firstUrl = base + '/before-cache';
        const tabId = await createTab(firstUrl);
        await until('first cache page complete', async () => (await tabs()).some(tab => tab.id === tabId && tab.status === 'complete'));
        await until('first completion observed', async () => (await evaluate(optionsSession, `window.__completions.some(event => event.tabId === ${tabId} && event.url === ${JSON.stringify(firstUrl)})`)));
        const targets = await call('Target.getTargets');
        const target = targets.targetInfos.find(item => item.type === 'page' && item.url === firstUrl);
        assert.ok(target);
        const session = (await call('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
        await call('Page.navigate', { url: base + '/after-cache' }, session);
        await until('second cache page complete', async () => (await tabs()).some(tab => tab.id === tabId && tab.url === base + '/after-cache' && tab.status === 'complete'));
        await saveRules('^' + firstUrl.replaceAll('.', '\\.') + '$');
        await evaluate(session, 'history.back()');
        await waitGone(tabId);
        const completions = await evaluate(optionsSession, `window.__completions.filter(event => event.tabId === ${tabId} && event.frameId === 0 && event.url === ${JSON.stringify(firstUrl)})`);
        assert.ok(completions.length >= 2, 'restored page emitted another completion');
        assert.equal(completions.at(-1).documentId, completions[0].documentId);
        return { sameDocumentId: true, completions: completions.length };
      });
      await checkpoint('closing the last matching tab closes its separate window', async () => {
        await saveRules('^' + base.replaceAll('.', '\\.') + '/last-window$');
        const windowId = await evaluate(optionsSession, `chrome.windows.create({url:${JSON.stringify(base + '/last-window')},focused:false}).then(window => window.id)`);
        await until('matching window closed', async () => !(await evaluate(optionsSession, 'chrome.windows.getAll().then(windows => windows.map(window => window.id))')).includes(windowId));
        return { windowId };
      });
      await checkpoint('navigation failure leaves its tab open', async () => {
        await saveRules('.*');
        const tabId = await createTab('http://127.0.0.1:1/unavailable');
        await until('failed navigation settled', async () => (await tabs()).some(tab => tab.id === tabId && tab.status === 'complete'));
        assert.ok((await tabs()).some(tab => tab.id === tabId));
      });
      await checkpoint('broad rule leaves full page options usable and can be cleared', async () => {
        await saveRules('');
        const blobHost = await createTab(base + '/blob-host');
        await until('blob host complete', async () => (await tabs()).some(tab => tab.id === blobHost && tab.status === 'complete'));
        await saveRules('.*');
        const manager = await createTab('chrome://extensions/');
        await waitGone(manager);
        const extensionPage = await createTab(`chrome-extension://${extensionId}/options.html`);
        await until('extension page complete', async () => (await tabs()).some(tab => tab.id === extensionPage && tab.status === 'complete'));
        const targets = await call('Target.getTargets');
        const hostTarget = targets.targetInfos.find(item => item.type === 'page' && item.url === base + '/blob-host');
        assert.ok(hostTarget);
        const hostSession = (await call('Target.attachToTarget', { targetId: hostTarget.targetId, flatten: true })).sessionId;
        const blobUrl = await evaluate(hostSession, `URL.createObjectURL(new Blob(['<!doctype html><title>Blob fixture</title>'], {type:'text/html'}))`);
        await call('Page.navigate', { url: blobUrl }, hostSession);
        await until('blob page complete', async () => (await tabs()).some(tab => tab.id === blobHost && tab.url === blobUrl && tab.status === 'complete'));
        assert.ok((await tabs()).some(tab => tab.id === blobHost));
        assert.ok((await tabs()).some(tab => tab.id === extensionPage));
        assert.deepEqual((await draftRows()).map(row => row.value), ['.*']);
        await saveRules('');
        assert.equal((await evaluate(optionsSession, `chrome.storage.local.get('settings').then(x => x.settings.rules)`)), '');
      });
    }
  }
} catch (error) {
  failure = error;
  results.push({ label: 'run failure', pass: false, error: String(error) });
  console.error(error);
} finally {
  releaseSlow();
  writeFileSync(join(evidence, 'results.json'), JSON.stringify({ browser, uiOnly, executable, node: process.version, nodeExecutable: process.execPath, extension, extensionId, base, results, requests }, null, 2) + '\n');
  try { await call('Browser.close'); } catch {}
  child.kill('SIGTERM');
  if (child.exitCode === null) await new Promise(resolveExit => child.once('exit', resolveExit));
  await new Promise(resolveClose => server.close(resolveClose));
  closeSync(logFd);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  console.log(`EVIDENCE ${evidence}`);
}
if (failure) process.exitCode = 1;
