export const BASE_HALF_LIFE_DAYS = Object.freeze({
  event: 7,
  preference: 90,
  learning: 60,
  relationship: 180,
  context: 30,
});

const TYPES = new Set(Object.keys(BASE_HALF_LIFE_DAYS));
const SOURCES = new Set(['user', 'observed', 'inferred']);
const ACTIVE = 'active';
const DAY = 86_400_000;
const MIN_RETENTION = 0.08;
const MAX_CONTENT = 4_000;
const MAX_EVIDENCE = 2_000;
const MAX_IMPORTANCE = 1;
const MAX_HALF_LIFE_MULTIPLIER = 16;
const REINFORCEMENT_INTERVAL = DAY;
const REINFORCEMENT_STEP = 0.05;
const MAX_REINFORCEMENTS = 1_000;
const TOKEN = /[\p{L}\p{N}]+/gu;
const CREDENTIAL = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b|\b(?:password|passwd|api[_ -]?key|secret)\s*[:=]\s*\S+)/iu;

import { createHash } from 'node:crypto';

function fail(message) { throw new Error(message); }
function text(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`Invalid ${name}`);
  if (CREDENTIAL.test(value)) fail(`${name} appears to contain a credential`);
  return value.trim();
}
function id(value, name = 'id') {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) fail(`Invalid ${name}`);
  return value.trim();
}
function uuid() { return globalThis.crypto.randomUUID(); }
function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}
function normalized(value) { return value.normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}\s]+/gu, ''); }
function retention(memory, now) {
  const age = Math.max(0, now - memory.lastReinforcedAt) / DAY;
  return Math.pow(2, -age / memory.halfLifeDays);
}
function tokens(value) {
  return (value.normalize('NFKC').toLocaleLowerCase().match(TOKEN) ?? []).flatMap(token => {
    const chars = Array.from(token);
    if (chars.length > 1 && /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(token)) {
      return chars.slice(0, -1).map((char, i) => char + chars[i + 1]);
    }
    return [token];
  });
}
function validateState(state) {
  if (!state || !Array.isArray(state.memories) || !Array.isArray(state.personaChanges) || !Array.isArray(state.personaEvents)) fail('Invalid project state');
}
function descendantIds(memories, roots) {
  const removed = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const memory of memories) if (!removed.has(memory.id) && memory.sourceIds.some(source => removed.has(source))) {
      removed.add(memory.id); changed = true;
    }
  }
  return removed;
}
function cleanPersona(state, removed) {
  const discarded = new Set(state.personaChanges.filter(change => change.evidenceIds?.some(evidenceId => removed.has(evidenceId))).map(change => change.id));
  state.personaChanges = state.personaChanges.filter(change => !discarded.has(change.id));
  state.personaEvents = state.personaEvents.filter(event => !discarded.has(event.changeId));
}
function checkGraph(memories) {
  const byId = new Map();
  for (const memory of memories) {
    if (byId.has(memory.id)) fail('Duplicate memory id');
    byId.set(memory.id, memory);
  }
  for (const memory of memories) {
    if (!Array.isArray(memory.sourceIds) || memory.sourceIds.some(sourceId => !byId.has(sourceId))) fail('Memory has missing provenance');
  }
  const done = new Set();
  const visiting = new Set();
  function visit(memoryId) {
    if (visiting.has(memoryId)) fail('Memory provenance cycle');
    if (done.has(memoryId)) return;
    visiting.add(memoryId);
    for (const parent of byId.get(memoryId).sourceIds) visit(parent);
    visiting.delete(memoryId); done.add(memoryId);
  }
  for (const memory of memories) visit(memory.id);
}

export class Memory {
  constructor(store, { now = () => Date.now() } = {}) {
    if (!store || typeof store.read !== 'function' || typeof store.update !== 'function') fail('A project store is required');
    if (typeof now !== 'function') fail('now must be a function');
    this.store = store;
    this.now = now;
  }

  remember(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Invalid memory input');
    const content = text(input.content, 'content', MAX_CONTENT);
    const type = input.type;
    const source = input.source;
    if (!TYPES.has(type)) fail('Invalid memory type');
    if (!SOURCES.has(source)) fail('Invalid memory source');
    const evidence = text(input.evidence, 'evidence', MAX_EVIDENCE);
    const importance = input.importance ?? 0.5;
    if (!Number.isFinite(importance) || importance < 0 || importance > MAX_IMPORTANCE) fail('Invalid importance');
    const at = this.now();
    return this.store.update(state => {
      validateState(state);
      const key = normalized(content);
      if (state.memories.some(memory => normalized(memory.content) === key && memory.status !== 'superseded')) {
        return state.memories.find(memory => normalized(memory.content) === key && memory.status !== 'superseded');
      }
      const sourceIds = input.sourceIds ?? [];
      if (!Array.isArray(sourceIds)) fail('sourceIds must be an array');
      const sources = sourceIds.map(value => id(value, 'sourceId'));
      if (new Set(sources).size !== sources.length) fail('sourceIds must be distinct');
      const sourceEntries = sources.map(sourceId => state.memories.find(memory => memory.id === sourceId));
      if (sourceEntries.some(memory => !memory || !['active', 'archived'].includes(memory.status))) fail('All source memories must be active or archived');
      const halfLifeDays = Math.min(BASE_HALF_LIFE_DAYS[type] * MAX_HALF_LIFE_MULTIPLIER, BASE_HALF_LIFE_DAYS[type] * (0.5 + importance));
      const memory = { id: uuid(), content, type, importance, source, evidence, sourceIds: sources, status: ACTIVE,
        createdAt: at, lastReinforcedAt: at, halfLifeDays, reinforcementEvents: [] };
      state.memories.push(memory);
      checkGraph(state.memories);
      return memory;
    });
  }

  recall({ query, limit = 5, includeDormant = false } = {}) {
    if (typeof query !== 'string' || !query.trim() || query.length > MAX_CONTENT) fail('Invalid query');
    const q = query.trim();
    if (!Number.isInteger(limit) || limit < 0 || limit > 100) fail('Invalid limit');
    if (typeof includeDormant !== 'boolean') fail('Invalid includeDormant');
    const terms = new Set(tokens(q));
    if (!terms.size) fail('Query has no searchable terms');
    const now = this.now();
    const state = this.store.read(); validateState(state);
    return state.memories.filter(memory => memory.status === ACTIVE || (includeDormant && memory.status === 'archived'))
      .map(memory => {
        const decay = retention(memory, now);
        const overlap = tokens(memory.content).reduce((count, term) => count + (terms.has(term) ? 1 : 0), 0);
        return { memory, decay, score: overlap ? (overlap / Math.sqrt(Math.max(1, tokens(memory.content).length))) * (0.5 + memory.importance) * decay : 0 };
      })
      .filter(item => item.score > 0 && (includeDormant || item.decay >= MIN_RETENTION))
      .sort((a, b) => b.score - a.score || b.memory.createdAt - a.memory.createdAt)
      .slice(0, limit).map(item => ({ ...item.memory, retention: item.decay, score: item.score }));
  }

  inspect(memoryId) {
    const key = id(memoryId);
    const state = this.store.read(); validateState(state);
    return state.memories.find(memory => memory.id === key) ?? null;
  }

  list({ includeInactive = false } = {}) {
    if (typeof includeInactive !== 'boolean') fail('Invalid includeInactive');
    const state = this.store.read(); validateState(state);
    return state.memories.filter(memory => includeInactive || memory.status === ACTIVE);
  }

  reinforce({ id: memoryId, eventId, evidence } = {}) {
    const key = id(memoryId);
    const event = text(eventId, 'eventId', 500);
    const proof = text(evidence, 'evidence', MAX_EVIDENCE);
    const hashed = digest(event);
    const at = this.now();
    return this.store.update(state => {
      validateState(state);
      const memory = state.memories.find(item => item.id === key);
      if (!memory || memory.status !== ACTIVE) fail('Active memory not found');
      if (memory.reinforcementEvents.includes(hashed)) return memory;
      if (at - memory.lastReinforcedAt < REINFORCEMENT_INTERVAL) fail('Reinforcement interval has not elapsed');
      if (memory.reinforcementEvents.length >= MAX_REINFORCEMENTS) fail('Reinforcement event limit reached');
      memory.reinforcementEvents.push(hashed);
      memory.importance = Math.min(1, memory.importance + REINFORCEMENT_STEP);
      memory.halfLifeDays = Math.min(BASE_HALF_LIFE_DAYS[memory.type] * MAX_HALF_LIFE_MULTIPLIER,
        memory.halfLifeDays + BASE_HALF_LIFE_DAYS[memory.type] * REINFORCEMENT_STEP);
      memory.evidence = proof;
      memory.lastReinforcedAt = at;
      return memory;
    });
  }

  correct({ id: memoryId, content, evidence } = {}) {
    const key = id(memoryId);
    const replacementContent = text(content, 'content', MAX_CONTENT);
    const proof = text(evidence, 'evidence', MAX_EVIDENCE);
    const at = this.now();
    return this.store.update(state => {
      validateState(state);
      const original = state.memories.find(memory => memory.id === key);
      if (!original || !['active', 'archived'].includes(original.status)) fail('Correctable memory not found');
      const affected = descendantIds(state.memories, [key]);
      const replacement = { ...original, id: uuid(), content: replacementContent, evidence: proof, sourceIds: [],
        status: ACTIVE, createdAt: at, lastReinforcedAt: at, reinforcementEvents: [] };
      original.status = 'superseded'; original.supersededBy = replacement.id;
      state.memories = state.memories.filter(memory => !affected.has(memory.id) || memory.id === key);
      state.memories.push(replacement);
      cleanPersona(state, affected);
      checkGraph(state.memories);
      return replacement;
    });
  }

  forget(memoryId) {
    const key = id(memoryId);
    return this.store.update(state => {
      validateState(state);
      if (!state.memories.some(memory => memory.id === key)) return false;
      const removed = descendantIds(state.memories, [key]);
      state.memories = state.memories.filter(memory => !removed.has(memory.id));
      cleanPersona(state, removed);
      checkGraph(state.memories);
      return true;
    });
  }

  consolidate({ ids: memoryIds, summary, evidence } = {}) {
    if (!Array.isArray(memoryIds) || memoryIds.length < 2) fail('At least two source IDs are required');
    const keys = memoryIds.map(value => id(value));
    if (new Set(keys).size !== keys.length) fail('Source IDs must be distinct');
    const content = text(summary, 'summary', MAX_CONTENT);
    const proof = text(evidence, 'evidence', MAX_EVIDENCE);
    const at = this.now();
    return this.store.update(state => {
      validateState(state);
      const sources = keys.map(key => state.memories.find(memory => memory.id === key));
      if (sources.some(memory => !memory || memory.status !== ACTIVE)) fail('All source memories must be active');
      const entry = { id: uuid(), content, type: 'learning', importance: Math.min(1, sources.reduce((sum, item) => sum + item.importance, 0) / sources.length),
        source: 'inferred', evidence: proof,
        sourceIds: keys, status: ACTIVE, createdAt: at, lastReinforcedAt: at, halfLifeDays: BASE_HALF_LIFE_DAYS.learning,
        reinforcementEvents: [] };
      for (const memory of sources) memory.status = 'archived';
      state.memories.push(entry);
      checkGraph(state.memories);
      return entry;
    });
  }
}
