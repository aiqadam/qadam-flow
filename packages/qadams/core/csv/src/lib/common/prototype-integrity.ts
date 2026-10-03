import { tryCatch } from '@aiqadam/shared';

// The engine may run several projects' steps in one process, so a parser that writes onto a
// built-in prototype would leak into every other run. Whatever the parser added or replaced
// is put back, and the run fails instead of returning output from a parser that misbehaved.
export const prototypeIntegrity = {
  async guard<T>(operation: () => Promise<T>): Promise<T> {
    const snapshots = GUARDED_PROTOTYPES.map(takeSnapshot);
    const result = await tryCatch(operation);
    const changes = snapshots.flatMap(findChanges);
    if (changes.length > 0) {
      changes.forEach(revertChange);
      throw new PrototypeIntegrityError(changes.map(describeChange));
    }
    if (result.error !== null) {
      throw result.error;
    }
    return result.data;
  },
};

export class PrototypeIntegrityError extends Error {
  constructor(changedKeys: string[]) {
    super(`A built-in prototype was modified while reading the file (${changedKeys.join(', ')}).`);
    this.name = 'PrototypeIntegrityError';
  }
}

const GUARDED_PROTOTYPES: GuardedPrototype[] = [
  { label: 'Object', target: Object.prototype },
  { label: 'Array', target: Array.prototype },
  { label: 'Function', target: Function.prototype },
  { label: 'String', target: String.prototype },
  { label: 'Number', target: Number.prototype },
];

function takeSnapshot(prototype: GuardedPrototype): PrototypeSnapshot {
  return {
    prototype,
    parent: Object.getPrototypeOf(prototype.target),
    descriptors: new Map(Reflect.ownKeys(prototype.target).map((key) => [key, Object.getOwnPropertyDescriptor(prototype.target, key)])),
  };
}

function findChanges(snapshot: PrototypeSnapshot): PrototypeChange[] {
  const { target } = snapshot.prototype;
  const currentKeys = Reflect.ownKeys(target);
  const addedOrReplaced = currentKeys
    .filter((key) => !sameDescriptor({ before: snapshot.descriptors.get(key), after: Object.getOwnPropertyDescriptor(target, key) }))
    .map((key) => ({ snapshot, key }));
  const removed = [...snapshot.descriptors.keys()]
    .filter((key) => !currentKeys.includes(key))
    .map((key) => ({ snapshot, key }));
  const parentChanged = Object.getPrototypeOf(target) === snapshot.parent ? [] : [{ snapshot, key: null }];
  return [...addedOrReplaced, ...removed, ...parentChanged];
}

function sameDescriptor({ before, after }: { before: PropertyDescriptor | undefined; after: PropertyDescriptor | undefined }): boolean {
  if (before === undefined || after === undefined) {
    return before === after;
  }
  return (
    before.value === after.value &&
    before.get === after.get &&
    before.set === after.set &&
    before.writable === after.writable &&
    before.enumerable === after.enumerable &&
    before.configurable === after.configurable
  );
}

function revertChange({ snapshot, key }: PrototypeChange): void {
  const { target } = snapshot.prototype;
  if (key === null) {
    Object.setPrototypeOf(target, snapshot.parent);
    return;
  }
  const original = snapshot.descriptors.get(key);
  if (original === undefined) {
    Reflect.deleteProperty(target, key);
    return;
  }
  Reflect.defineProperty(target, key, original);
}

function describeChange({ snapshot, key }: PrototypeChange): string {
  const label = snapshot.prototype.label;
  return key === null ? `${label}.prototype's prototype` : `${label}.prototype[${String(key)}]`;
}

type GuardedPrototype = {
  label: string;
  target: object;
};

type PrototypeSnapshot = {
  prototype: GuardedPrototype;
  parent: object | null;
  descriptors: Map<string | symbol, PropertyDescriptor | undefined>;
};

type PrototypeChange = {
  snapshot: PrototypeSnapshot;
  key: string | symbol | null;
};
