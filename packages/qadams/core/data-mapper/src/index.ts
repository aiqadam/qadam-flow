import { QadamAuth, createQadam, QadamCategory } from '@aiqadam/qadams-framework';
import { advancedMapping } from './lib/actions/advanced-mapping';

export const dataMapper = createQadam({
  displayName: 'Data Mapper',
  description: 'tools to manipulate data structure',

  minimumSupportedRelease: '0.0.0',
  logoUrl: '/assets/qadams/new-core/data-mapper.svg',
  auth: QadamAuth.None(),
  categories: [QadamCategory.CORE],
  authors: ["kishanprmr","MoShizzle","AbdulTheActivePiecer","khaledmashaly","abuaboud"],
  actions: [advancedMapping],
  triggers: [],
});
