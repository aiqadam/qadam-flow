import { defineConfig } from 'eslint/config'
import { baseConfigs } from '../../tools/eslint/base.mjs'
import { prettierConfigs } from '../../tools/eslint/prettier.mjs'

// One config for every qadam plus framework/common. Flat config has no cascade, so the per-qadam
// .eslintrc.json files (all identical bar these two lists) collapse into this file: ESLint finds it
// by walking up from the qadam directory its `lint` script runs in.

// Qadams that started from the former .eslintrc.base.json: no lodash ban, no stray-semicolon rule.
const BASE_ONLY = [
    'community/ai',
    'community/algolia',
    'community/amazon-bedrock',
    'community/amazon-secrets-manager',
    'community/amazon-ses',
    'community/amazon-sns',
    'community/amazon-sqs',
    'community/anyhook-graphql',
    'community/anyhook-websocket',
    'community/apify',
    'community/assemblyai',
    'community/azure-blob-storage',
    'community/azure-communication-services',
    'community/bigin-by-zoho',
    'community/bitly',
    'community/brave-search',
    'community/chatwoot',
    'community/claude',
    'community/clicksend',
    'community/clockify',
    'community/cloudconvert',
    'community/cloudinary',
    'community/cohere',
    'community/confluence',
    'community/couchbase',
    'community/datadog',
    'community/deepseek',
    'community/digital-ocean',
    'community/duckdb',
    'community/elevenlabs',
    'community/firecrawl',
    'community/flow-helper',
    'community/flow-parser',
    'community/getresponse',
    'community/gitea',
    'community/google-cloud-storage',
    'community/google-search',
    'community/google-search-console',
    'community/google-slides',
    'community/google-vertexai',
    'community/googlechat',
    'community/groq',
    'community/hashi-corp-vault',
    'community/http-oauth2',
    'community/hugging-face',
    'community/jina-ai',
    'community/kommo',
    'community/lokalise',
    'community/manychat',
    'community/mcp',
    'community/messagebird',
    'community/microsoft-365-people',
    'community/microsoft-365-planner',
    'community/microsoft-copilot',
    'community/microsoft-dynamics-365-business-central',
    'community/microsoft-dynamics-crm',
    'community/microsoft-onenote',
    'community/microsoft-outlook',
    'community/microsoft-outlook-calendar',
    'community/microsoft-power-bi',
    'community/microsoft-sharepoint',
    'community/microsoft-todo',
    'community/mistral-ai',
    'community/mongodb',
    'community/netlify',
    'community/oracle-database',
    'community/pagerduty',
    'community/pandadoc',
    'community/perplexity-ai',
    'community/pinecone',
    'community/plausible',
    'community/queue',
    'community/rabbitmq',
    'community/reddit',
    'community/runway',
    'community/segment',
    'community/serp-api',
    'community/service-now',
    'community/snowflake',
    'community/tableau',
    'community/tavily',
    'community/ticktick',
    'community/time-ops',
    'community/toggl-track',
    'community/twenty',
    'community/umami',
    'community/uptimerobot',
    'community/vercel',
    'community/webex',
    'community/whatsapp',
    'community/youtrack',
    'community/zoho-bookings',
    'community/zoho-books',
    'community/zoho-campaigns',
    'community/zoho-desk',
    'community/zoho-mail',
    'core/data-summarizer',
    'core/manual-trigger',
    'core/pdf',
    'core/qrcode',
    'core/subflows',
    'core/tables',
]

// Qadams that also have Prettier enforced through ESLint.
const PRETTIER = [
    'community/deepgram',
    'community/docusign',
    'community/github',
    'community/gmail',
    'community/google-bigquery',
    'community/metabase',
    'community/notion',
    'community/snowflake',
    'community/stable-diffusion-webui',
    'core/text-helper',
]

const BASE_ONLY_FILES = BASE_ONLY.map((dir) => `${dir}/**`)

// Qadams import only @aiqadam/qadams-framework and @aiqadam/qadams-common (ADR-0001, gate 6 of
// #797). `framework` is exempt because it is the one package that re-exports the qadam-facing
// `shared` symbols; `common/test` because it checks common's errors against the engine's own
// formatter, which is platform code and not part of the SDK.
const SHARED_IMPORT_MESSAGE = 'Qadams must not import @aiqadam/shared (ADR-0001). Import the symbol from @aiqadam/qadams-framework, which re-exports every qadam-facing one; if it is missing, add it to packages/qadams/framework/src/lib/shared-reexports.ts.'
const SHARED_SPECIFIER = '/^@aiqadam\\u002Fshared(\\u002F|$)/'
const SHARED_BAN_IGNORES = ['framework/**', 'common/test/**']

export default defineConfig(
    {
        ignores: BASE_ONLY_FILES,
        extends: [baseConfigs.root()],
    },
    {
        files: BASE_ONLY_FILES,
        extends: [baseConfigs.base()],
    },
    prettierConfigs.recommended({ files: PRETTIER.map((dir) => `${dir}/**/*.{ts,tsx,js,jsx}`) }),
    {
        // The typescript-eslint variant, so the lodash ban the core rule carries is left alone, and
        // `import x = require(...)` is covered as well as import/export declarations and type imports.
        files: baseConfigs.tsFiles,
        ignores: SHARED_BAN_IGNORES,
        rules: {
            '@typescript-eslint/no-restricted-imports': ['error', {
                paths: [{ name: '@aiqadam/shared', message: SHARED_IMPORT_MESSAGE }],
                patterns: [{ group: ['@aiqadam/shared/*'], message: SHARED_IMPORT_MESSAGE }],
            }],
        },
    },
    {
        // What no import rule sees: require() and other calls taking the specifier (vi.mock,
        // require.resolve), dynamic import(), and `typeof import(...)` types.
        files: baseConfigs.scriptFiles,
        ignores: SHARED_BAN_IGNORES,
        rules: {
            'no-restricted-syntax': ['error',
                { selector: `CallExpression[arguments.0.value=${SHARED_SPECIFIER}]`, message: SHARED_IMPORT_MESSAGE },
                { selector: `ImportExpression[source.value=${SHARED_SPECIFIER}]`, message: SHARED_IMPORT_MESSAGE },
                { selector: `TSImportType[argument.literal.value=${SHARED_SPECIFIER}]`, message: SHARED_IMPORT_MESSAGE },
            ],
        },
    },
)
