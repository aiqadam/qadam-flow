/// <reference types="vitest/globals" />

import { generatePassword } from '../src/lib/actions/generate-password';
import { createMockActionContext } from '@aiqadam/qadams-framework';

const ALPHANUMERIC = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const ALPHANUMERIC_SYMBOLS = `${ALPHANUMERIC}!@#$%^&*()_+~\`|}{[]:;?><,./-=`;

const { randomIntSpy } = vi.hoisted(() => ({ randomIntSpy: vi.fn() }));

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  randomIntSpy.mockImplementation(actual.randomInt);
  return { ...actual, randomInt: randomIntSpy };
});

describe('generatePassword', () => {
  afterEach(() => {
    randomIntSpy.mockClear();
  });

  test('generates password with correct length', async () => {
    const ctx = createMockActionContext({
      propsValue: { length: 16, characterSet: 'alphanumeric' },
    });
    const result = await generatePassword.run(ctx);
    expect(result).toHaveLength(16);
  });

  test('generates alphanumeric password', async () => {
    const ctx = createMockActionContext({
      propsValue: { length: 100, characterSet: 'alphanumeric' },
    });
    const result = await generatePassword.run(ctx);
    expect(result).toMatch(/^[a-zA-Z0-9]+$/);
  });

  test('draws every character from the symbols charset when selected', async () => {
    const ctx = createMockActionContext({
      propsValue: { length: 256, characterSet: 'alphanumeric-symbols' },
    });
    const result = await generatePassword.run(ctx);
    expect(result).toHaveLength(256);
    for (const char of result) {
      expect(ALPHANUMERIC_SYMBOLS).toContain(char);
    }
  });

  // #507: the output is used for invite tokens and one-time codes, so the characters must come
  // from a CSPRNG — one uniform draw over the charset per character, and never Math.random.
  test('draws each character from crypto.randomInt, not Math.random', async () => {
    const mathRandomSpy = vi.spyOn(Math, 'random');
    const ctx = createMockActionContext({
      propsValue: { length: 32, characterSet: 'alphanumeric' },
    });
    await generatePassword.run(ctx);
    expect(randomIntSpy).toHaveBeenCalledTimes(32);
    for (const call of randomIntSpy.mock.calls) {
      expect(call).toEqual([ALPHANUMERIC.length]);
    }
    expect(mathRandomSpy).not.toHaveBeenCalled();
    mathRandomSpy.mockRestore();
  });

  test('throws on invalid length (> 256)', async () => {
    const ctx = createMockActionContext({
      propsValue: { length: 300, characterSet: 'alphanumeric' },
    });
    await expect(generatePassword.run(ctx)).rejects.toThrow();
  });
});
