import { createQadam, QadamAuth } from '@aiqadam/qadams-framework';
import { calculateAverage } from './lib/actions/calculate-average';
import { calculateSum } from './lib/actions/calculate-sum';
import { countUniques } from './lib/actions/count-uniques';
import { getMinMax } from './lib/actions/get-min-max';
import { QadamCategory } from '@aiqadam/shared';

export const dataSummarizer = createQadam({
  displayName: 'Data Summarizer',
  auth: QadamAuth.None(),
  minimumSupportedRelease: '0.30.0',
  logoUrl: '/assets/qadams/data-summarizer.svg',
  authors: ['tahboubali'],
  actions: [calculateAverage, calculateSum, countUniques, getMinMax],
  triggers: [],
  categories: [QadamCategory.CORE]
});
