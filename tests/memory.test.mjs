import test from 'node:test';
import assert from 'node:assert/strict';
import { Memory, BASE_HALF_LIFE_DAYS } from '../lib/memory.mjs';

function fixture(start = 1_700_000_000_000) {
  let now = start;
  const state = { version: 1, projectId: 'test', projectRoot: 'test', memories: [], personaChanges: [], personaEvents: [] };
  const store = {
    read: () => structuredClone(state),
    update(callback) {
      const draft = structuredClone(state);
      const result = callback(draft);
      Object.assign(state, draft);
      return structuredClone(result);
    },
  };
  return { state, store, memory: new Memory(store, { now: () => now }), advance(ms) { now += ms; } };
}
const remember = (memory, content, more = {}) => memory.remember({ content, type: 'learning', source: 'user', importance: 0.5, evidence: '用户明确确认', ...more });

test('remember validates bounded domain input and duplicate content does not strengthen', () => {
  const { memory, state } = fixture();
  const first = remember(memory, '  Keep tea nearby  ');
  const duplicate = remember(memory, 'keep tea nearby', { importance: 1, evidence: 'different' });
  assert.equal(duplicate.id, first.id);
  assert.equal(state.memories.length, 1);
  assert.equal(duplicate.importance, first.importance);
  assert.throws(() => remember(memory, 'api_key=secret'), /credential/i);
  assert.throws(() => remember(memory, ''), /content/i);
  assert.equal(state.memories.length, 1);
});

test('remember records valid provenance and rejects missing, duplicate, or superseded references', () => {
  const { memory } = fixture();
  const source = remember(memory, 'Original evidence');
  const derived = remember(memory, 'Derived by explicit inference', { source: 'inferred', sourceIds: [source.id] });
  assert.deepEqual(derived.sourceIds, [source.id]);
  assert.throws(() => remember(memory, 'Missing provenance', { sourceIds: ['missing'] }), /source memories/i);
  assert.throws(() => remember(memory, 'Repeated provenance', { sourceIds: [source.id, source.id] }), /distinct/i);
  memory.correct({ id: source.id, content: 'Corrected evidence', evidence: 'user correction' });
  assert.equal(memory.inspect(derived.id), null);
});

test('recall ranks CJK lexical matches, filters dormant entries, and is read-only', () => {
  const { memory, state, advance } = fixture();
  const tea = remember(memory, '我喜欢喝绿茶');
  remember(memory, '周末喜欢散步');
  const before = structuredClone(state);
  assert.equal(memory.recall({ query: '绿茶' })[0].id, tea.id);
  advance(400 * 86_400_000);
  assert.equal(memory.recall({ query: '绿茶' }).length, 0);
  assert.equal(memory.recall({ query: '绿茶', includeDormant: true }).length, 1);
  assert.throws(() => memory.recall({ query: '!!!' }), /searchable/i);
  assert.deepEqual(state.memories.map(item => item.reinforcementEvents), before.memories.map(item => item.reinforcementEvents));
});

test('reinforcement deduplicates events, enforces spacing and caps strength', () => {
  const { memory, advance } = fixture();
  const entry = remember(memory, 'Likes quiet mornings');
  assert.throws(() => memory.reinforce({ id: entry.id, eventId: 'one', evidence: 'again' }), /interval/i);
  advance(86_400_000);
  const reinforced = memory.reinforce({ id: entry.id, eventId: 'one', evidence: 'observed once more' });
  assert.equal(reinforced.reinforcementEvents.length, 1);
  assert.equal(memory.reinforce({ id: entry.id, eventId: 'one', evidence: 'duplicate event' }).importance, reinforced.importance);
  for (let i = 2; i <= 400; i++) {
    advance(86_400_000);
    memory.reinforce({ id: entry.id, eventId: `event-${i}`, evidence: 'new evidence' });
  }
  const capped = memory.inspect(entry.id);
  assert.equal(capped.importance, 1);
  assert.equal(capped.reinforcementEvents.length, 400);
  assert.equal(capped.halfLifeDays, BASE_HALF_LIFE_DAYS.learning * 16);
  const beforeDuplicate = capped.importance;
  memory.reinforce({ id: entry.id, eventId: 'one', evidence: 'replayed event' });
  assert.equal(memory.inspect(entry.id).importance, beforeDuplicate);
});

test('correction invalidates derived chain and dependent persona history atomically', () => {
  const { memory, state } = fixture();
  const base = remember(memory, 'User works from home');
  const unrelated = remember(memory, 'User owns a cat');
  const derived = memory.consolidate({ ids: [base.id, unrelated.id], summary: 'Home and cat context', evidence: 'combined confirmation' });
  assert.equal(derived.source, 'inferred');
  const proposal = { id: 'change-1', evidenceIds: [derived.id], status: 'approved' };
  state.personaChanges.push(proposal);
  state.personaEvents.push({ id: 'event-1', changeId: proposal.id, action: 'approved', timestamp: 1 });
  const corrected = memory.correct({ id: base.id, content: 'User works in an office', evidence: 'user corrected this' });
  assert.equal(memory.inspect(base.id).status, 'superseded');
  assert.equal(memory.inspect(base.id).supersededBy, corrected.id);
  assert.equal(memory.inspect(derived.id), null);
  assert.deepEqual(state.personaChanges, []);
  assert.deepEqual(state.personaEvents, []);
  assert.equal(memory.inspect(unrelated.id).content, 'User owns a cat');
  assert.equal(memory.inspect(corrected.id).content, 'User works in an office');
});

test('an archived source can be corrected and invalidates its derived summary', () => {
  const { memory } = fixture();
  const source = remember(memory, 'Incorrect archived fact');
  const peer = remember(memory, 'Independent fact');
  const summary = memory.consolidate({ ids: [source.id, peer.id], summary: 'Combined summary', evidence: 'summary evidence' });
  assert.equal(memory.inspect(source.id).status, 'archived');
  const replacement = memory.correct({ id: source.id, content: 'Corrected archived fact', evidence: 'user correction' });
  assert.equal(memory.inspect(summary.id), null);
  assert.equal(memory.inspect(replacement.id).status, 'active');
});

test('forget physically removes recursive descendants and persona dependent on erased evidence', () => {
  const { memory, state } = fixture();
  const root = remember(memory, 'Root fact');
  const second = remember(memory, 'Second fact');
  const child = memory.consolidate({ ids: [root.id, second.id], summary: 'Derived fact', evidence: 'evidence' });
  const independent = remember(memory, 'Independent later fact');
  const grandchild = memory.consolidate({ ids: [child.id, independent.id], summary: 'Further derived fact', evidence: 'evidence' });
  state.personaChanges.push({ id: 'c', evidenceIds: [grandchild.id], status: 'approved' });
  state.personaEvents.push({ id: 'e', changeId: 'c', action: 'approved', timestamp: 1 });
  assert.equal(memory.forget(root.id), true);
  assert.deepEqual(new Set(state.memories.map(item => item.id)), new Set([second.id, independent.id]));
  assert.equal(state.personaChanges.length, 0);
  assert.equal(state.personaEvents.length, 0);
  assert.equal(memory.forget(root.id), false);
});

test('failed mutations roll back and inactive entries cannot be reinforced', () => {
  const { memory, state } = fixture();
  const root = remember(memory, 'Stable detail');
  const peer = remember(memory, 'Related detail');
  const snapshot = structuredClone(state);
  assert.throws(() => memory.consolidate({ ids: [root.id, 'missing'], summary: 'invalid', evidence: 'evidence' }));
  assert.deepEqual(state, snapshot);
  memory.consolidate({ ids: [root.id, peer.id], summary: 'summary', evidence: 'evidence' });
  assert.throws(() => memory.reinforce({ id: root.id, eventId: 'event', evidence: 'proof' }), /active/i);
  assert.equal(memory.inspect('unknown'), null);
});
