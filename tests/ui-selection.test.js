const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const editor = read('src/10-editor.js');
const shell = read('src/08-ui-shell.js');

function section(start, end) {
  const from = editor.indexOf(start);
  const to = editor.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing source section: ${start}`);
  return editor.slice(from, to);
}

test('transform selection keeps direct runtime object references instead of layer indices', () => {
  const selection = section('function ensureTransformTarget()', 'function setOptionalTransformValue');
  assert.match(selection, /editing\.layers\.includes\(transformEditTarget\.layer\)/);
  assert.match(selection, /transformEditTarget = \{ kind: "layer", layer: target\.layer \}/);
  assert.doesNotMatch(selection, /transformEditTarget\.index|kind: "layer", index/);
});

test('the shared inspector owns all material and layer property fields', () => {
  const inspector = section('function renderTransformEditor(content)', 'function renderLayerList(list)');
  for (const field of ['priority', 'offsetX', 'offsetY', 'opacity', 'rotation', 'scale']) {
    assert.match(inspector, new RegExp(`data-layer-field="${field}"`));
  }
  for (const field of ['offsetX', 'offsetY', 'rotation', 'scale']) {
    assert.match(inspector, new RegExp(`data-overall-field="${field}"`));
  }
  assert.match(inspector, /data-layer-color/);
  assert.match(inspector, /data-overall-color/);
  assert.match(inspector, /data-reset-layer/);
  assert.match(inspector, /data-reset-material/);
});

test('layer cards contain selection and object-management actions only', () => {
  const cards = section('function renderMaterialLayerCards(', 'function openMaterialPicker()');
  assert.match(cards, /data-select-layer/);
  assert.match(cards, /data-hide/);
  assert.match(cards, /data-copy/);
  assert.match(cards, /data-remove/);
  assert.doesNotMatch(cards, /data-key=|data-layer-transform|data-edit-transform|data-layer-color/);
});

test('selection persists outside the inspector and the inspector sticks above the scrolling list', () => {
  assert.doesNotMatch(shell, /setTransformTarget\(null\)/);
  assert.doesNotMatch(shell, /event\.key === "Escape" && transformEditTarget/);
  assert.match(shell, /\.coe-transform-editor\{position:sticky;top:-9px;z-index:5/);
  assert.match(shell, /\.coe-layer\.coe-selected/);
  assert.match(shell, /\.coe-material-editor\.coe-selected/);
});
