const TRAITS = new Set(['humor', 'warmth', 'initiative', 'curiosity', 'expression', 'collaboration']);
const MAX_DESCRIPTION = 500;
const MAX_REASON = 500;
const CREDENTIAL_PATTERNS = [
  /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/i,
  /\b(?:api[_ -]?key|secret|password|access[_ -]?token)\s*[:=]\s*\S+/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
];
 
function requiredText(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new Error(`${label} must be a nonempty string of at most ${max} characters`);
  }
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new Error(`${label} must not contain credentials`);
  }
  return value.trim();
}

function validateBaseline(baseline) {
  if (!baseline || typeof baseline !== 'object' || Array.isArray(baseline)) throw new Error('Invalid persona baseline');
  const text = (value, label) => {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid baseline ${label}`);
    return value;
  };
  const strings = (value, label) => {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`Invalid baseline ${label}`);
    return [...value];
  };
  if (!Array.isArray(baseline.examples) || baseline.examples.some((item) => !item || typeof item.user !== 'string' || typeof item.assistant !== 'string')) {
    throw new Error('Invalid baseline examples');
  }
  return Object.freeze({
    name: text(baseline.name, 'name'),
    identity: text(baseline.identity, 'identity'),
    traits: Object.freeze(strings(baseline.traits, 'traits')),
    style: Object.freeze(strings(baseline.style, 'style')),
    boundaries: Object.freeze(strings(baseline.boundaries, 'boundaries')),
    examples: Object.freeze(baseline.examples.map(({ user, assistant }) => Object.freeze({ user, assistant }))),
  });
}

function validEvidence(state, evidenceIds) {
  return Array.isArray(evidenceIds) && evidenceIds.length > 0 && evidenceIds.every((id) =>
    typeof id === 'string' && state.memories.some((memory) => memory.id === id && ['active', 'archived'].includes(memory.status)));
}

function invalidatedChanges(state) {
  return new Set(state.personaChanges
    .filter((change) => change.status === 'approved' && !validEvidence(state, change.evidenceIds))
    .map((change) => change.id));
}

function publicChange(change, invalidated) {
  const copy = structuredClone(change);
  if (invalidated.has(change.id)) copy.status = 'invalidated';
  return copy;
}

export class Persona {
  constructor(store, baseline, { now = () => Date.now() } = {}) {
    if (!store || typeof store.read !== 'function' || typeof store.update !== 'function') throw new Error('Invalid persona store');
    if (typeof now !== 'function') throw new Error('Invalid clock');
    this.store = store;
    this.baseline = validateBaseline(baseline);
    this.now = now;
  }

  get() {
    const state = this.store.read();
    const invalidated = invalidatedChanges(state);
    const learned = state.personaChanges
      .filter((change) => change.status === 'approved' && !invalidated.has(change.id))
      .map(({ id, trait, description, reason, evidenceIds, createdAt, reviewedAt }) => ({ id, trait, description, reason, evidenceIds: [...evidenceIds], createdAt, reviewedAt }));
    return { baseline: structuredClone(this.baseline), learned, version: state.revision ?? state.personaEvents.length };
  }

  propose({ trait, description, reason, evidenceIds } = {}) {
    if (!TRAITS.has(trait)) throw new Error('Unsupported persona trait');
    description = requiredText(description, 'description', MAX_DESCRIPTION);
    reason = requiredText(reason, 'reason', MAX_REASON);
    return this.store.update((state) => {
      if (!validEvidence(state, evidenceIds)) throw new Error('Evidence must reference existing active or archived memories');
      const change = {
        id: crypto.randomUUID(), trait, description, reason,
        evidenceIds: [...new Set(evidenceIds)], status: 'pending', createdAt: this.now(),
      };
      if (change.evidenceIds.length !== evidenceIds.length) throw new Error('Evidence IDs must be distinct');
      state.personaChanges.push(change);
      return structuredClone(change);
    });
  }

  approve(id) { return this.#decide(id, 'approved'); }
  reject(id) { return this.#decide(id, 'rejected'); }

  revert(id) {
    return this.store.update((state) => {
      const change = state.personaChanges.find((item) => item.id === id);
      if (!change || change.status !== 'approved') throw new Error('Only an approved persona change can be reverted');
      change.status = 'reverted';
      change.reviewedAt = this.now();
      state.personaEvents.push({ id: crypto.randomUUID(), changeId: id, action: 'revert', timestamp: this.now() });
      return structuredClone(change);
    });
  }

  history() {
    const state = this.store.read();
    const invalidated = invalidatedChanges(state);
    return state.personaChanges.map((change) => publicChange(change, invalidated));
  }

  #decide(id, action) {
    return this.store.update((state) => {
      const change = state.personaChanges.find((item) => item.id === id);
      if (!change || change.status !== 'pending') throw new Error('Only a pending persona change can be decided');
      if (action === 'approved' && !validEvidence(state, change.evidenceIds)) {
        throw new Error('Persona evidence is no longer valid');
      }
      change.status = action;
      change.reviewedAt = this.now();
      state.personaEvents.push({ id: crypto.randomUUID(), changeId: id, action: action === 'approved' ? 'approve' : 'reject', timestamp: this.now() });
      return structuredClone(change);
    });
  }
}
