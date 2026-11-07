import test from 'node:test';
import assert from 'node:assert/strict';
import { Persona } from '../lib/persona.mjs';

function setup() {
  let time = 1000;
  const state = {
    version: 1, projectId: 'isolated', projectRoot: 'isolated',
    memories: [
      { id: 'm1', status: 'active', content: 'supported preference' },
      { id: 'm2', status: 'archived', content: 'archived evidence' },
      { id: 'm3', status: 'superseded', content: 'obsolete evidence' },
    ], personaChanges: [], personaEvents: [],
  };
  let updates = 0;
  const store = {
    read: () => structuredClone(state),
    update: (callback) => {
      updates++;
      const draft = structuredClone(state);
      const result = callback(draft);
      Object.assign(state, draft);
      return structuredClone(result);
    },
    get updates() { return updates; },
  };
  const baseline = {
    name: 'Companion', identity: 'A helpful desktop companion', traits: ['curious'],
    style: ['concise'], boundaries: ['respect privacy'], examples: [{ user: 'Hi', assistant: 'Hello' }],
  };
  return { state, persona: new Persona(store, baseline, { now: () => time++ }), baseline };
}

test('proposals stay pending; reads are isolated and never write', () => {
  const { state, persona, baseline } = setup();
  const proposal = persona.propose({ trait: 'warmth', description: 'Uses a warmer tone', reason: 'Repeated preference', evidenceIds: ['m1'] });
  assert.equal(proposal.status, 'pending');
  const writes = persona.store.updates;
  assert.deepEqual(persona.get().learned, []);
  const obtained = persona.get();
  obtained.baseline.traits.push('changed');
  assert.deepEqual(persona.get().baseline, baseline);
  assert.deepEqual(persona.history(), [proposal]);
  assert.equal(persona.store.updates, writes);
  assert.equal(state.personaEvents.length, 0);
});

test('owner decisions are explicit, unique, and reversible only once', () => {
  const { state, persona } = setup();
  const proposal = persona.propose({ trait: 'curiosity', description: 'Asks clarifying questions', reason: 'Useful preference', evidenceIds: ['m1', 'm2'] });
  assert.equal(persona.approve(proposal.id).status, 'approved');
  assert.throws(() => persona.reject(proposal.id));
  assert.equal(persona.get().learned.length, 1);
  assert.equal(persona.revert(proposal.id).status, 'reverted');
  assert.throws(() => persona.revert(proposal.id));
  assert.deepEqual(state.personaEvents.map(({ action }) => action), ['approve', 'revert']);
  assert.equal(persona.get().learned.length, 0);
  assert.equal(persona.get().version, 2);
});

test('evidence is validated at proposal, approval, and read time', () => {
  const { state, persona } = setup();
  assert.throws(() => persona.propose({ trait: 'humor', description: 'Light humor', reason: 'Asked', evidenceIds: ['m3'] }));
  const proposal = persona.propose({ trait: 'humor', description: 'Light humor', reason: 'Asked', evidenceIds: ['m1'] });
  state.memories.find(({ id }) => id === 'm1').status = 'superseded';
  assert.throws(() => persona.approve(proposal.id));
  assert.equal(persona.history()[0].status, 'pending');
  state.memories.find(({ id }) => id === 'm1').status = 'active';
  assert.equal(persona.approve(proposal.id).status, 'approved');
  state.memories.splice(state.memories.findIndex(({ id }) => id === 'm1'), 1);
  assert.deepEqual(persona.get().learned, []);
  assert.equal(persona.history()[0].status, 'invalidated');
});

test('invalid proposals and credentials are rejected without state changes', () => {
  const { state, persona } = setup();
  assert.throws(() => persona.propose({ trait: 'identity', description: 'No', reason: 'No', evidenceIds: ['m1'] }));
  assert.throws(() => persona.propose({ trait: 'warmth', description: 'Set api_key=secret123', reason: 'No', evidenceIds: ['m1'] }));
  assert.throws(() => persona.propose({ trait: 'warmth', description: 'Fine', reason: 'No', evidenceIds: ['m1', 'm1'] }));
  assert.equal(state.personaChanges.length, 0);
});
