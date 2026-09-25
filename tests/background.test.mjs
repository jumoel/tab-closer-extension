import test from 'node:test';
import assert from 'node:assert/strict';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function setup(overrides = {}) {
  const handlers = {};
  const event = name => ({ addListener(fn) { handlers[name] = fn; } });
  let record = { version: 1, revision: 'one', rules: 'example' };
  const removed = [];
  let optionsOpened = 0;
  const frame = { documentId: 'doc-1', documentLifecycle: 'active', url: 'https://example.test/' };
  const tab = { url: frame.url };
  globalThis.chrome = {
    webNavigation: {
      onCompleted: event('complete'), onBeforeNavigate: event('before'),
      onHistoryStateUpdated: event('history'), onReferenceFragmentUpdated: event('fragment'),
      getFrame: overrides.getFrame || (async () => frame)
    },
    tabs: {
      onRemoved: event('removed'), get: overrides.getTab || (async () => tab),
      remove: async id => { removed.push(id); }
    },
    storage: {
      onChanged: event('changed'),
      local: { get: overrides.getStorage || (async () => ({ settings: record })) }
    },
    action: { onClicked: event('clicked') },
    runtime: { openOptionsPage: async () => { optionsOpened++; } }
  };
  await import(`../background.js?case=${Math.random()}`);
  const complete = (url = frame.url, documentId = frame.documentId) => handlers.complete({ tabId: 7, frameId: 0, documentLifecycle: 'active', documentId, url });
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
  return { handlers, complete, settle, removed, frame, tab, optionsOpened: () => optionsOpened, setRecord(value) { record = value; } };
}

test('matching completed main document closes once; iframe does not', async () => {
  const ctx = await setup();
  ctx.handlers.complete({ tabId: 7, frameId: 3, documentLifecycle: 'active', documentId: 'child', url: 'https://example.test/' });
  await ctx.settle();
  assert.deepEqual(ctx.removed, []);
  ctx.complete();
  await ctx.settle();
  assert.deepEqual(ctx.removed, [7]);
});

test('new navigation during storage read cancels old completion', async () => {
  const gate = deferred();
  const ctx = await setup({ getStorage: async () => gate.promise });
  ctx.complete();
  ctx.handlers.before({ tabId: 7, frameId: 0 });
  gate.resolve({ settings: { version: 1, revision: 'one', rules: 'example' } });
  await ctx.settle();
  assert.deepEqual(ctx.removed, []);
});

test('same-document URL change and removed tab cancel while final frame is pending', async () => {
  for (const eventName of ['history', 'fragment', 'removed']) {
    const gate = deferred();
    const ctx = await setup({ getFrame: async () => gate.promise });
    ctx.complete();
    await ctx.settle();
    ctx.handlers[eventName](eventName === 'removed' ? 7 : { tabId: 7, frameId: 0 });
    gate.resolve(ctx.frame);
    await ctx.settle();
    assert.deepEqual(ctx.removed, [], eventName);
  }
});

test('changed revision and pending navigation block removal', async () => {
  const ctx = await setup();
  ctx.tab.pendingUrl = 'https://other.test/';
  ctx.complete();
  await ctx.settle();
  assert.deepEqual(ctx.removed, []);

  const secondRead = deferred();
  let reads = 0;
  const changed = await setup({ getStorage: async () => (++reads === 2 ? secondRead.promise : { settings: { version: 1, revision: 'one', rules: 'example' } }) });
  changed.complete();
  await changed.settle();
  secondRead.resolve({ settings: { version: 1, revision: 'two', rules: '' } });
  await changed.settle();
  assert.deepEqual(changed.removed, []);
});

test('storage change event cancels work after the revision read', async () => {
  const gate = deferred();
  const ctx = await setup({ getFrame: async () => gate.promise });
  ctx.complete();
  await ctx.settle();
  ctx.handlers.changed({ settings: { newValue: { version: 1, revision: 'two', rules: '' } } }, 'local');
  gate.resolve(ctx.frame);
  await ctx.settle();
  assert.deepEqual(ctx.removed, []);
});

test('new completion supersedes an older attempt', async () => {
  const first = deferred();
  let reads = 0;
  const ctx = await setup({ getStorage: async () => (++reads === 1 ? first.promise : { settings: { version: 1, revision: 'one', rules: 'example' } }) });
  ctx.complete();
  ctx.complete();
  await ctx.settle();
  first.resolve({ settings: { version: 1, revision: 'one', rules: 'example' } });
  await ctx.settle();
  assert.deepEqual(ctx.removed, [7]);
});

test('toolbar action opens the options page API', async () => {
  const ctx = await setup();
  ctx.handlers.clicked();
  await ctx.settle();
  assert.equal(ctx.optionsOpened(), 1);
});
