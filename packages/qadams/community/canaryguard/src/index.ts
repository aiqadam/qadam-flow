import { createQadam, QadamCategory } from '@aiqadam/qadams-framework';
import { canaryguardAuth } from './lib/auth';
import { sanitizeTextAction } from './lib/actions/sanitize-text';

export const canaryguard = createQadam({
  displayName: 'CanaryGuard',
  description:
    'Deterministic prompt-injection firewall and AI safety sanitizer powered by CanaryGuard 402.',
  logoUrl: '/assets/qadams/canaryguard.png',
  categories: [QadamCategory.ARTIFICIAL_INTELLIGENCE],
  auth: canaryguardAuth,
  authors: ['ak10082247-max'],
  actions: [sanitizeTextAction],
  triggers: [],
});
