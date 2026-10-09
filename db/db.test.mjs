// Run: npm test  (node:test + fake-indexeddb, no browser needed)
import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as db from './db.js';

const mkList = async (folderId) => db.createList({ folderId, name: 'L' });
const mkHl = (listId, folderId) => db.createHighlight({ text: 't', listId, folderId });

test('displayOrder stays unique after deleting an earlier highlight', async () => {
  const f = await db.createFolder({ type: 'manual', name: 'a' });
  const l = await mkList(f);
  const [h0] = [await mkHl(l, f), await mkHl(l, f), await mkHl(l, f)];
  await db.deleteHighlight(h0);
  await mkHl(l, f);
  const orders = (await db.getHighlightsByList(l)).map((h) => h.displayOrder);
  assert.equal(new Set(orders).size, orders.length);
});

test('reorderHighlights applies the whole order', async () => {
  const f = await db.createFolder({ type: 'manual', name: 'b' });
  const l = await mkList(f);
  const ids = [await mkHl(l, f), await mkHl(l, f), await mkHl(l, f)];
  await db.reorderHighlights([...ids].reverse());
  const byOrder = (await db.getHighlightsByList(l)).sort((a, b) => a.displayOrder - b.displayOrder);
  assert.deepEqual(byOrder.map((h) => h.id), [...ids].reverse());
});

test('conversation cascade removes folder, lists and highlights', async () => {
  const f = await db.createFolder({ type: 'conversation', name: 'c' });
  const l = await mkList(f);
  await mkHl(l, f);
  await db.deleteConversationFolderCascade(f);
  assert.equal(await db.getFolder(f), undefined);
  assert.equal((await db.getListsByFolder(f)).length, 0);
  assert.equal((await db.getHighlightsByList(l)).length, 0);
});

test('project cascade removes child conversations too', async () => {
  const p = await db.createFolder({ type: 'project', name: 'p' });
  const c = await db.createFolder({ type: 'conversation', name: 'pc', parentId: p });
  const l = await mkList(c);
  await mkHl(l, c);
  await db.deleteProjectFolderCascade(p);
  assert.equal(await db.getFolder(c), undefined);
  assert.equal((await db.getHighlightsByList(l)).length, 0);
});

test('manual cascade keeps child conversation folders and returns their ids', async () => {
  const m = await db.createFolder({ type: 'manual', name: 'm' });
  const c = await db.createFolder({ type: 'conversation', name: 'mc', parentId: m });
  const l = await mkList(m);
  await mkHl(l, m);
  assert.deepEqual(await db.deleteManualFolderCascade(m), [c]);
  assert.equal(await db.getFolder(m), undefined);
  assert.ok(await db.getFolder(c));
  assert.equal((await db.getHighlightsByList(l)).length, 0);
});
