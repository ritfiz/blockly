/**
 * @license
 * Copyright 2026 Raspberry Pi Foundation
 * SPDX-License-Identifier: Apache-2.0
 */

import * as Blockly from '#core/blockly.js';
import {assert} from 'chai';
import type {SinonFakeTimers} from 'sinon';
import {
  DEFAULT_INJECT_OPTIONS,
  sharedTestSetup,
  sharedTestTeardown,
} from './test_helpers/setup_teardown.js';

type ListBlock = Blockly.BlockSvg & {itemCount: number; updateShape(): void};
type ItemBlock = Blockly.Block & {valueConnection?: Blockly.Connection | null};

/**
 * A mutator like the one on lists_create_with, except that compose fills each
 * empty input with a new, non-shadow block.
 */
const FILLING_MUTATOR = {
  itemCount: 0,

  saveExtraState(this: ListBlock) {
    return {itemCount: this.itemCount};
  },

  loadExtraState(this: ListBlock, state: {itemCount: number}) {
    this.itemCount = state.itemCount;
    this.updateShape();
  },

  decompose(this: ListBlock, workspace: Blockly.WorkspaceSvg) {
    const container = workspace.newBlock('filling_container');
    container.initSvg();
    let connection = container.getInput('STACK')?.connection;
    for (let i = 0; i < this.itemCount; i++) {
      const item = workspace.newBlock('filling_item');
      item.initSvg();
      if (item.previousConnection) connection?.connect(item.previousConnection);
      connection = item.nextConnection;
    }
    return container;
  },

  saveConnections(this: ListBlock, container: Blockly.Block) {
    let item = container.getInputTargetBlock('STACK') as ItemBlock | null;
    for (let i = 0; item; i++) {
      item.valueConnection = this.getInput(`ADD${i}`)?.connection
        ?.targetConnection;
      item = item.getNextBlock();
    }
  },

  // Items are only ever added in these tests, so removing them isn't handled.
  compose(this: ListBlock, container: Blockly.Block) {
    const connections = [];
    let item = container.getInputTargetBlock('STACK') as ItemBlock | null;
    for (; item; item = item.getNextBlock()) {
      connections.push(item.valueConnection);
    }
    this.itemCount = connections.length;
    this.updateShape();
    connections.forEach((c, i) => c?.reconnect(this, `ADD${i}`));

    for (let i = 0; i < this.itemCount; i++) {
      const connection = this.getInput(`ADD${i}`)?.connection;
      if (!connection || connection.targetConnection) continue;
      const child = this.workspace.newBlock('filling_value');
      child.initSvg();
      child.render();
      if (child.outputConnection) connection.connect(child.outputConnection);
    }
  },

  updateShape(this: ListBlock) {
    for (let i = 0; i < this.itemCount; i++) {
      if (!this.getInput(`ADD${i}`)) this.appendValueInput(`ADD${i}`);
    }
    for (let i = this.itemCount; this.getInput(`ADD${i}`); i++) {
      this.removeInput(`ADD${i}`);
    }
  },
};

suite('Mutator undo and redo', function () {
  let workspace: Blockly.WorkspaceSvg;
  let clock: SinonFakeTimers;

  setup(function (this: Mocha.Context) {
    // Queue events as a browser does, so that they are reordered before being
    // recorded for undo.
    clock = sharedTestSetup.call(this, {fireEventsNow: false}).clock;
    Blockly.defineBlocksWithJsonArray([
      {type: 'filling_list', colour: 230, mutator: 'filling_mutator'},
      {
        type: 'filling_container',
        colour: 230,
        message0: '%1',
        args0: [{type: 'input_statement', name: 'STACK'}],
      },
      {
        type: 'filling_item',
        colour: 230,
        previousStatement: null,
        nextStatement: null,
      },
      {type: 'filling_value', colour: 230, output: null},
    ]);
    Blockly.Extensions.registerMutator(
      'filling_mutator',
      FILLING_MUTATOR,
      undefined,
      ['filling_item'],
    );
    workspace = Blockly.inject('blocklyDiv', DEFAULT_INJECT_OPTIONS);
  });

  teardown(function (this: Mocha.Context) {
    Blockly.Extensions.unregister('filling_mutator');
    sharedTestTeardown.call(this, workspace);
  });

  /**
   * Adds items to the top of the list's mutator stack in one change, as a
   * user dragging a stack of items there would.
   */
  async function addItemsAtTop(list: ListBlock, count: number) {
    const icon = list.getIcon(
      Blockly.icons.MutatorIcon.TYPE,
    ) as Blockly.icons.MutatorIcon;
    await icon.setBubbleVisible(true);
    // Let the mutator record which child belongs to each item.
    clock.runAll();
    const miniWorkspace = icon.getWorkspace();
    assert.exists(miniWorkspace);
    const stack = miniWorkspace.getTopBlocks()[0].getInput('STACK')?.connection;

    const existingItems = stack?.targetBlock();
    existingItems?.unplug();
    let previous = stack;
    for (let i = 0; i < count; i++) {
      const item = miniWorkspace.newBlock('filling_item');
      item.initSvg();
      if (item.previousConnection) previous?.connect(item.previousConnection);
      previous = item.nextConnection;
    }
    if (existingItems?.previousConnection) {
      previous?.connect(existingItems.previousConnection);
    }
    clock.runAll();
    await icon.setBubbleVisible(false);
    clock.runAll();
  }

  function createList() {
    const list = workspace.newBlock('filling_list') as ListBlock;
    list.initSvg();
    list.render();
    clock.runAll();
    return list;
  }

  /** Makes a change, then checks that undo reverts it and redo restores it. */
  async function assertUndoRedo(change: () => Promise<void>) {
    workspace.clearUndo();
    const before = Blockly.serialization.workspaces.save(workspace);
    await change();
    const after = Blockly.serialization.workspaces.save(workspace);

    workspace.undo(false);
    clock.runAll();
    assert.deepEqual(Blockly.serialization.workspaces.save(workspace), before);

    workspace.undo(true);
    clock.runAll();
    assert.deepEqual(Blockly.serialization.workspaces.save(workspace), after);
  }

  test('Blocks created for several new inputs', async function () {
    const list = createList();
    await assertUndoRedo(() => addItemsAtTop(list, 2));
  });

  test('Existing child moved to a new input', async function () {
    const list = createList();
    await addItemsAtTop(list, 1);
    await assertUndoRedo(() => addItemsAtTop(list, 1));
  });
});
