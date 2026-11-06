import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({URL, __DP4K_TEST__: true});
vm.runInContext(fs.readFileSync(new URL('../extension/DisneyPlus-Edge-Enhanced.user.js', import.meta.url), 'utf8'), context);
const api = context.__DP4K_INTERNALS__;
for (const [vendor, renderer, expected] of [
  ['Google Inc. (Intel)', 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics, D3D11)', 'intel'],
  ['Google Inc. (NVIDIA)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Laptop GPU, D3D11)', 'nvidia'],
  ['Google Inc. (AMD)', 'ANGLE (AMD, AMD Radeon RX 9070 XT, D3D11)', 'amd'],
  ['Intel', 'NVIDIA GeForce', 'unknown'],
  ['Google Inc.', 'Google SwiftShader', 'software'],
  ['Intel', 'Microsoft Basic Render Driver', 'software'],
  ['Intel', 'llvmpipe', 'software'],
  ['WebKit', 'WebKit WebGL', 'unknown'],
  ['notintel', 'Some GPU', 'unknown'],
  ['Intel', 'x'.repeat(513), 'unknown'],
  [null, 'Intel', 'unknown'],
]) assert.equal(api.classifyGpuVendor(vendor, renderer), expected);

let released = 0;
let contextCalls = 0;
const fakeGl = {
  getExtension: (name) => name === 'WEBGL_debug_renderer_info'
    ? {UNMASKED_VENDOR_WEBGL: 1, UNMASKED_RENDERER_WEBGL: 2}
    : name === 'WEBGL_lose_context' ? {loseContext: () => released++} : null,
  getParameter: (name) => name === 1 ? 'Google Inc. (Intel)' : 'ANGLE (Intel, Intel Iris Xe)',
};
const doc = {createElement: (tag) => {
  assert.equal(tag, 'canvas');
  return {getContext: (name, options) => {
    contextCalls++;
    assert.equal(options.powerPreference, undefined, 'never select low-power Intel just to pass the check');
    assert.equal(options.failIfMajorPerformanceCaveat, true);
    return fakeGl;
  }};
}};
assert.equal(api.detectGpuVendor(doc), 'intel');
assert.equal(contextCalls, 1);
assert.equal(released, 1, 'the temporary context is released');
fakeGl.getParameter = () => {throw new Error('private driver text');};
assert.equal(api.detectGpuVendor(doc), 'unknown');
assert.equal(released, 2, 'exceptions still release the context');
assert.equal(api.detectGpuVendor({createElement: () => ({getContext: () => null})}), 'unknown');
assert.equal(api.detectGpuVendor({}), 'unknown');

const storage = () => {
  const values = new Map();
  return {getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key)};
};
const url = 'https://www.disneyplus.com/ja-jp/play/gpu-fixture';
// The Intel 4K page is one page only. Afterwards the earlier everyday choice
// comes back: Full HD (saved or the unsaved default) or OFF.
for (const [previous, after] of [[null, 'fullhd'], ['fullhd', 'fullhd'], ['original', 'original']]) {
  for (const gpu of ['intel', 'nvidia', 'amd', 'unknown', 'software']) {
    const local = storage();
    const session = storage();
    if (previous !== null) local.setItem(api.STORAGE_KEY, previous);
    assert.equal(api.prepareModeReload(api.INTEL_4K_MODE, local, session, url, 100, true).reload, true);
    const ticket = JSON.parse(session.getItem(api.TEST_TICKET_KEY));
    assert.equal(ticket.requireIntelGpu, true);
    assert.equal(ticket.returnMode, after === 'fullhd' ? 'fullhd' : undefined);
    assert.equal(local.getItem(api.STORAGE_KEY), 'original', '4K never becomes a persistent default');
    const outcome = api.consumeStartupMode(local, session, url, 101, 'reload', () => {
      assert.equal(session.getItem(api.TEST_TICKET_KEY), null, 'consume the ticket BEFORE querying any GPU');
      return gpu;
    });
    assert.equal(outcome.mode, gpu === 'intel' ? api.INTEL_4K_MODE : 'original');
    if (gpu !== 'intel') assert.equal(outcome.showDebug, true, 'show the rejection reason instead of silently falling back');
    assert.equal(local.getItem(api.STORAGE_KEY), after, 'the earlier choice is saved again for the next load');
    assert.equal(api.consumeStartupMode(local, session, url, 102, 'reload', () => 'intel').mode, after, 'a ticket cannot survive another reload');
  }
}
{
  // A stale Intel ticket starts this page unchanged but keeps Full HD for the next load.
  const local = storage();
  const session = storage();
  local.setItem(api.STORAGE_KEY, 'fullhd');
  api.prepareModeReload(api.INTEL_4K_MODE, local, session, url, 100, true);
  assert.equal(api.consumeStartupMode(local, session, url, 100 + 60000, 'reload', () => 'intel').mode, 'original');
  assert.equal(local.getItem(api.STORAGE_KEY), 'fullhd');
  // Diagnostic experiments (no Intel requirement) still leave OFF saved.
  api.prepareModeReload(api.INTEL_4K_MODE, local, session, url, 200);
  assert.equal(JSON.parse(session.getItem(api.TEST_TICKET_KEY)).returnMode, undefined);
  api.consumeStartupMode(local, session, url, 201, 'reload');
  assert.equal(local.getItem(api.STORAGE_KEY), 'original');
}
{
  // A ticket that cannot be saved puts Full HD back.
  const local = storage();
  local.setItem(api.STORAGE_KEY, 'fullhd');
  const session = {getItem: () => null, setItem: () => {}, removeItem: () => {}};
  assert.equal(api.prepareModeReload(api.INTEL_4K_MODE, local, session, url, 100, true).reload, false);
  assert.equal(local.getItem(api.STORAGE_KEY), 'fullhd');
}

// The everyday 4K choice: WebGL must say Intel and WebGPU must list no AMD,
// fallback or unknown adapter. No device is requested.
const fakeGpu = (adapters) => {
  const asked = [];
  return {asked, requestAdapter: async (options) => {
    asked.push(options.powerPreference);
    const value = adapters[options.powerPreference];
    if (value instanceof Error) throw value;
    return value === null ? null : {info: value, requestDevice: () => assert.fail('no device')};
  }};
};
const intel = {vendor: 'intel', architecture: 'gen-12lp'};
for (const [label, webgl, gpu, expected] of [
  ['Intel only', 'intel', fakeGpu({'high-performance': intel, 'low-power': intel}), 'eligible'],
  ['Intel + NVIDIA laptop', 'intel', fakeGpu({'high-performance': {vendor: 'nvidia'}, 'low-power': intel}), 'eligible'],
  ['Intel + AMD', 'intel', fakeGpu({'high-performance': {vendor: 'amd'}, 'low-power': intel}), 'amd-adapter'],
  ['AMD drawing', 'amd', fakeGpu({'high-performance': {vendor: 'amd'}, 'low-power': {vendor: 'amd'}}), 'webgl-not-intel'],
  ['NVIDIA drawing', 'nvidia', fakeGpu({'high-performance': {vendor: 'nvidia'}, 'low-power': intel}), 'webgl-not-intel'],
  ['no WebGPU', 'intel', undefined, 'webgpu-unavailable'],
  ['no adapter', 'intel', fakeGpu({'high-performance': null, 'low-power': intel}), 'webgpu-unavailable'],
  ['query throws', 'intel', fakeGpu({'high-performance': new Error('blocked'), 'low-power': intel}), 'webgpu-unavailable'],
  ['fallback adapter', 'intel', fakeGpu({'high-performance': {vendor: 'google', isFallbackAdapter: true}, 'low-power': intel}), 'webgpu-unavailable'],
  ['blank vendor', 'intel', fakeGpu({'high-performance': {vendor: ''}, 'low-power': intel}), 'webgpu-unknown'],
  ['no Intel adapter', 'intel', fakeGpu({'high-performance': {vendor: 'nvidia'}, 'low-power': {vendor: 'nvidia'}}), 'webgpu-unknown'],
]) {
  assert.equal(await api.checkIntel4kEligibility(webgl, gpu), expected, label);
}
{
  const gpu = fakeGpu({'high-performance': intel, 'low-power': intel});
  await api.checkIntel4kEligibility('amd', gpu);
  assert.deepEqual(gpu.asked, [], 'WebGPU is not queried unless WebGL already says Intel');
}
{
  const local = storage();
  const session = storage();
  api.prepareModeReload(api.INTEL_4K_MODE, local, session, url, 100, true);
  assert.equal(api.consumeStartupMode(local, session, url, 101, 'reload', () => {throw new Error('probe failed');}).mode, 'original');
  assert.equal(session.getItem(api.TEST_TICKET_KEY), null);
  assert.equal(api.prepareModeReload('fullhd', local, session, url, 200, true).reload, false);
  api.prepareModeReload('fullhd', local, session, url, 200);
  assert.equal(api.consumeStartupMode(local, session, url, 201, 'reload', () => {throw new Error('must not probe for FHD');}).mode, 'fullhd');
}
console.log('GPU hint: Intel/NVIDIA/AMD/software/unknown, bounded input, context release, no forced adapter, one-page Intel gate with return to Full HD, post-reload recheck and WebGPU AMD/fallback exclusion passed (mock only).');
