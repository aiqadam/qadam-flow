import { createQadam, QadamAuth } from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { addition } from './lib/actions/addition';
import { division } from './lib/actions/division';
import { generateRandom } from './lib/actions/generateRandom';
import { modulo } from './lib/actions/modulo';
import { multiplication } from './lib/actions/multiplication';
import { subtraction } from './lib/actions/subtraction';

const markdownDescription = `
Perform mathematical operations.
`;

export const math = createQadam({
  displayName: 'Math Helper',
  description: markdownDescription,
  auth: QadamAuth.None(),
  minimumSupportedRelease: '0.36.1',
  logoUrl: '/assets/qadams/new-core/math-helper.svg',
  categories: [QadamCategory.CORE],
  authors: ["kishanprmr","MoShizzle","abuaboud"],
  actions: [
    addition,
    subtraction,
    multiplication,
    division,
    modulo,
    generateRandom,
  ],
  triggers: [],
});
