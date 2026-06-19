import { createQadam } from '@aiqadam/qadams-framework';
import { QadamCategory } from '@aiqadam/shared';
import { browserlessAuth } from './lib/common/auth';
import { captureScreenshot } from './lib/actions/capture-screenshot';
import { generatePdf } from './lib/actions/generate-pdf';
import { scrapeUrl } from './lib/actions/scrape-url';
import { runBqlQuery } from './lib/actions/run-bql-query';
import { getWebsitePerformance } from './lib/actions/get-website-performance';

export const browserless = createQadam({
    displayName: 'Browserless',
    minimumSupportedRelease: '0.36.1',
    logoUrl: '/assets/qadams/browserless.png',
    categories: [QadamCategory.DEVELOPER_TOOLS],
    description: 'Browserless is a headless browser automation tool that allows you to scrape websites, take screenshots, and more.',
    authors: ['owuzo', 'onyedikachi-david'],
    auth: browserlessAuth,
    actions: [
        captureScreenshot,
        generatePdf,
        scrapeUrl,
        runBqlQuery,
        getWebsitePerformance,
    ],
    triggers: [],
});