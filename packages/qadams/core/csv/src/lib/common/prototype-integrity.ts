import { workerUtils } from './worker-utils';

// The parser runs in a conversion worker whose realm is discarded after each conversion, so a
// parser that writes onto a built-in prototype cannot reach the engine's. Within the worker the
// CSV is still built after parsing, by code that relies on those prototypes, so whatever the
// parser added or replaced is put back and the conversion fails instead of returning output a
// misbehaving parser shaped.
// Guarded sections run one at a time: a snapshot taken while another section is in flight
// would attribute that section's changes to the wrong run, or let them through unnoticed.
export const prototypeIntegrity = {
  guard<T>(operation: () => Promise<T>): Promise<T> {
    const run = pendingSections.then(() => guardOnce(operation));
    pendingSections = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  },
};

export class PrototypeIntegrityError extends Error {
  constructor({ changed, unrestored }: { changed: string[]; unrestored: string[] }) {
    const restoreNote = unrestored.length === 0 ? '' : ` Could not restore: ${unrestored.join(', ')}.`;
    super(`A built-in prototype was modified while reading the file (${changed.join(', ')}).${restoreNote}`);
    this.name = 'PrototypeIntegrityError';
  }
}

let pendingSections: Promise<void> = Promise.resolve();

const GUARDED_PROTOTYPES: GuardedPrototype[] = [
  { label: 'Object', target: Object.prototype },
  { label: 'Array', target: Array.prototype },
  { label: 'Function', target: Function.prototype },
  { label: 'String', target: String.prototype },
  { label: 'Number', target: Number.prototype },
];

async function guardOnce<T>(operation: () => Promise<T>): Promise<T> {
  const snapshots = GUARDED_PROTOTYPES.map(takeSnapshot);
  const result = await workerUtils.tryCatch(operation);
  const changes = snapshots.flatMap(findChanges);
  if (changes.length > 0) {
    const unrestored = changes.filter((change) => !revertChange(change));
    throw new PrototypeIntegrityError({
      changed: changes.map(describeChange),
      unrestored: unrestored.map(describeChange),
    });
  }
  if (result.error !== null) {
    throw result.error;
  }
  return result.data;
}

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

// Returns whether the prototype is back to its snapshot for this key; a property that was made
// non-configurable, or a prototype that was frozen, cannot be put back.
function revertChange({ snapshot, key }: PrototypeChange): boolean {
  const { target } = snapshot.prototype;
  if (key === null) {
    return Reflect.setPrototypeOf(target, snapshot.parent);
  }
  const original = snapshot.descriptors.get(key);
  if (original === undefined) {
    return Reflect.deleteProperty(target, key);
  }
  return Reflect.defineProperty(target, key, original);
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
