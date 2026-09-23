import { randomInt } from 'crypto';
import {
  Property,
  createAction,
} from '@aiqadam/qadams-framework';
import { z } from 'zod';
import { propsValidation } from '@aiqadam/qadams-common';

export const generatePassword = createAction({
  name: 'generate-password',
  description: 'Generates a random password with the specified length',
  displayName: 'Generate Password',
  props: {
    length: Property.Number({
      displayName: 'Password Length',
      description: 'The length of the password (maximum 256)',
      required: true,
    }),
    characterSet: Property.StaticDropdown({
      displayName: 'Character Set',
      description: 'The character set to use when generating the password',
      required: true,
      defaultValue: 'alphanumeric',
      options: {
        options: [
          { label: 'Alphanumeric', value: 'alphanumeric' },
          { label: 'Alphanumeric + Symbols', value: 'alphanumeric-symbols' },
        ],
      },
    }),
  },
  async run(context) {
    await propsValidation.validateZod(context.propsValue, {
      length: z.number().max(256),
    });

    const charset = context.propsValue.characterSet === 'alphanumeric'
      ? 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
      : 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+~`|}{[]:;?><,./-=';

    const length = context.propsValue.length;

    // Flows use this output for invite tokens, one-time codes and API keys (#507), so the
    // characters must come from a CSPRNG. `randomInt` is uniform over [0, max) — it rejection-
    // samples internally, so there is no modulo bias to correct here.
    return Array.from({ length }, () => charset[randomInt(charset.length)]).join('');
  },
});
