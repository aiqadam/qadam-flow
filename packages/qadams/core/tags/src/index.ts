import { createQadam, QadamAuth } from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { addTag } from './lib/add-tag';

export const tags = createQadam({
  displayName: 'Tags',
  description: 'Add custom tags to your run for filtration',
  auth: QadamAuth.None(),
  minimumSupportedRelease: '0.30.0',
  logoUrl: '/assets/qadams/new-core/tags.svg',
  categories: [QadamCategory.CORE],
  authors: ["kishanprmr","MoShizzle","abuaboud"],
  actions: [addTag],
  triggers: [],
});
