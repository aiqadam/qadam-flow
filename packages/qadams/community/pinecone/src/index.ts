import { createQadam } from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { createIndex } from './lib/actions/create-index';
import { upsertVector } from './lib/actions/upsert-vector';
import { updateVector } from './lib/actions/update-vector';
import { getVector } from './lib/actions/get-vector';
import { deleteVector } from './lib/actions/delete-vector';
import { searchVector } from './lib/actions/search-vector';
import { searchIndex } from './lib/actions/search-index';
import { pineconeAuth } from './lib/auth';

export const pinecone = createQadam({
  displayName: 'Pinecone',
  description: 'Manage vector databases, store embeddings, and perform similarity searches',
  categories: [QadamCategory.ARTIFICIAL_INTELLIGENCE],
  auth: pineconeAuth,
  minimumSupportedRelease: '0.36.1',
  logoUrl: '/assets/qadams/pinecone.png',
  authors: ['fortunamide', 'onyedikachi-david'],
  actions: [createIndex, upsertVector, updateVector, getVector, deleteVector, searchVector, searchIndex],
  triggers: []
});
