/// <reference types="vitest/globals" />

import { PrototypeIntegrityError, prototypeIntegrity } from '../src/lib/common/prototype-integrity';
import { excelTestKit } from './excel-test-kit';
import { zipFixture } from './zip-fixture';

const { builtInPrototypeKeys, convert, workbookLoader, zipBase64 } = excelTestKit;

describe('prototypeIntegrity', () => {
  test('fails the run and restores the prototype when the operation modifies one', async () => {
    const prototypeKeysBefore = builtInPrototypeKeys();
    const originalJoin = Array.prototype.join;
    const addedKey = 'addedDuringOperation';

    await expect(
      prototypeIntegrity.guard(async () => {
        Object.defineProperty(Object.prototype, addedKey, { value: 1, configurable: true, writable: true });
        Object.defineProperty(Array.prototype, 'join', { value: () => 'replaced', configurable: true, writable: true });
        return 'parsed';
      })
    ).rejects.toThrow(PrototypeIntegrityError);

    expect(builtInPrototypeKeys()).toEqual(prototypeKeysBefore);
    expect(Object.prototype).not.toHaveProperty(addedKey);
    expect(Array.prototype.join).toBe(originalJoin);
  });

  test('runs overlapping sections one at a time, so a change is charged to the section that made it', async () => {
    const addedKey = 'addedBySecondSection';
    const firstMayFinish = deferred();
    const secondMayFinish = deferred();

    const first = prototypeIntegrity.guard(async () => {
      await firstMayFinish.promise;
      return 'first';
    });
    const second = prototypeIntegrity.guard(async () => {
      Object.defineProperty(Object.prototype, addedKey, { value: 1, configurable: true, writable: true });
      await secondMayFinish.promise;
      return 'second';
    });

    try {
      firstMayFinish.resolve();
      await expect(first).resolves.toBe('first');
      secondMayFinish.resolve();
      await expect(second).rejects.toThrow(PrototypeIntegrityError);
      expect(Object.prototype).not.toHaveProperty(addedKey);
    }
    finally {
      secondMayFinish.resolve();
      await second.catch(() => undefined);
      Reflect.deleteProperty(Object.prototype, addedKey);
    }
  });

  test('keeps guarding sections after one rejects', async () => {
    await expect(prototypeIntegrity.guard(async () => Promise.reject(new Error('could not parse')))).rejects.toThrow('could not parse');
    await expect(
      prototypeIntegrity.guard(async () => {
        Object.defineProperty(Object.prototype, 'addedAfterRejection', { value: 1, configurable: true, writable: true });
        return 'parsed';
      })
    ).rejects.toThrow(PrototypeIntegrityError);
    await expect(prototypeIntegrity.guard(async () => 'parsed')).resolves.toBe('parsed');
    expect(Object.prototype).not.toHaveProperty('addedAfterRejection');
  });

  test('reports a change it cannot restore', async () => {
    const permanentKey = Symbol('permanent');

    const outcome = prototypeIntegrity.guard(async () => {
      Object.defineProperty(Number.prototype, permanentKey, { value: 1, configurable: false, writable: false, enumerable: false });
      return 'parsed';
    });

    await expect(outcome).rejects.toThrow(PrototypeIntegrityError);
    await expect(outcome).rejects.toThrow('Could not restore: Number.prototype[Symbol(permanent)]');
  });

  test('converting a workbook runs the parser inside the guard', async () => {
    const addedKey = 'addedWhileLoading';
    const loader = workbookLoader();
    const originalLoad = loader.loadFromFiles;
    const loadSpy = vi.spyOn(loader, 'loadFromFiles').mockImplementation(async function (this: unknown, ...args: unknown[]) {
      Object.defineProperty(Object.prototype, addedKey, { value: 1, configurable: true, writable: true });
      return Reflect.apply(originalLoad, this, args);
    });
    const base64 = zipBase64(zipFixture.minimalWorkbookParts({ sheetData: '<row r="1"><c r="A1"><v>1</v></c></row>' }));

    try {
      await expect(convert({ base64 })).rejects.toThrow(PrototypeIntegrityError);
      expect(loadSpy).toHaveBeenCalledTimes(1);
      expect(Object.prototype).not.toHaveProperty(addedKey);
    }
    finally {
      loadSpy.mockRestore();
      Reflect.deleteProperty(Object.prototype, addedKey);
    }
  });
});

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve() };
}

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};
