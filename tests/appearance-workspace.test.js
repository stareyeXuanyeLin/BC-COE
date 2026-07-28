const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers');

function installWorkspace(options = {}) {
  const hooks = {};
  const draws = [];
  const player = options.player || {
    AccountName: 'A', MemberNumber: 1, AssetFamily: 'Female3DCG', Appearance: [], AppearanceLayers: [], ExtensionSettings: {},
    HeightModifier: 3, IsPlayer: () => true,
  };
  const env = load({ player, globals: {
    CurrentScreen: 'Appearance', CharacterAppearanceSelection: player, CharacterAppearanceMode: '', DialogFocusItem: null,
    Layering: { IsActive: () => false }, DrawCharacter: (...args) => draws.push(args),
    AppearanceRun() {}, AppearanceClick() {}, AppearanceMouseWheel() {}, AppearancePaste() {},
    ...options.globals,
  } });
  env.api.installWorkspaceHooksForTest({ hookFunction(name, _priority, fn) { hooks[name] = fn; } });
  return { ...env, hooks, draws, player };
}

test('workspace run replaces vanilla controls with the two native character views', () => {
  const env = installWorkspace();
  let vanillaRuns = 0;
  assert.equal(env.hooks.AppearanceRun([], () => { vanillaRuns++; return 'vanilla'; }), 'vanilla');
  assert.equal(vanillaRuns, 1);
  assert.equal(env.draws.length, 0);

  env.api.setUIModeForTest('wardrobe');
  assert.equal(env.hooks.AppearanceRun([], () => { vanillaRuns++; return 'vanilla'; }), undefined);
  assert.equal(vanillaRuns, 1);
  assert.equal(env.draws.length, 2);
  assert.deepEqual(env.draws[0], [env.player, -600, -88, 4, false]);
  assert.deepEqual(env.draws[1], [env.player, 660, 90, 0.95]);
});

test('workspace input gate blocks vanilla appearance hitboxes only while active', () => {
  const env = installWorkspace();
  let vanillaClicks = 0;
  let vanillaWheels = 0;
  const clickNext = () => { vanillaClicks++; return 'click'; };
  const wheelNext = () => { vanillaWheels++; return 'wheel'; };

  assert.equal(env.hooks.AppearanceClick([], clickNext), 'click');
  assert.equal(env.hooks.AppearanceMouseWheel([], wheelNext), 'wheel');
  env.api.setUIModeForTest('editor');
  assert.equal(env.hooks.AppearanceClick([], clickNext), undefined);
  assert.equal(env.hooks.AppearanceMouseWheel([], wheelNext), undefined);
  assert.equal(vanillaClicks, 1);
  assert.equal(vanillaWheels, 1);

  env.sandbox.CurrentScreen = 'ChatRoom';
  assert.equal(env.hooks.AppearanceClick([], clickNext), 'click');
  assert.equal(vanillaClicks, 2);
});

test('workspace full-body preview uses the non-player layout when needed', () => {
  const character = {
    AccountName: 'B', MemberNumber: 2, AssetFamily: 'Female3DCG', Appearance: [], AppearanceLayers: [], ExtensionSettings: {},
    HeightModifier: 0, IsPlayer: () => false,
  };
  const env = installWorkspace({ player: character });
  env.api.setUIModeForTest('editor');
  env.hooks.AppearanceRun([], () => {});
  assert.deepEqual(env.draws[1], [character, 660, 0, 1]);
});

test('entry eligibility rejects nested vanilla appearance modes', () => {
  const env = installWorkspace();
  assert.equal(env.api.isAppearanceRootMode(), true);
  env.sandbox.CharacterAppearanceMode = 'Color';
  assert.equal(env.api.isAppearanceRootMode(), false);
  env.sandbox.CharacterAppearanceMode = '';
  env.sandbox.DialogFocusItem = {};
  assert.equal(env.api.isAppearanceRootMode(), false);
  env.sandbox.DialogFocusItem = null;
  env.sandbox.Layering = { IsActive: () => true };
  assert.equal(env.api.isAppearanceRootMode(), false);
});
