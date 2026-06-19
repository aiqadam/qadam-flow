import { createQadam } from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { flowParserAuth } from './lib/common/auth';
import { uploadDocument } from './lib/actions/upload-document';
import { newParsedDocumentByTemplate } from './lib/triggers/new-parsed-document-by-template';
import { newParsedDocumentFound } from './lib/triggers/new-parsed-document-found';

export const flowParser = createQadam({
  displayName: 'FlowParser',
  description: 'Upload, process, and manage documents programmatically with FlowParser\'s REST API.',
  auth: flowParserAuth,
  minimumSupportedRelease: '0.36.1',
  logoUrl: '/assets/qadams/flow-parser.png',
  categories: [QadamCategory.DEVELOPER_TOOLS],
  authors: ["onyedikachi-david"],
  actions: [uploadDocument],
  triggers: [newParsedDocumentByTemplate, newParsedDocumentFound],
});
