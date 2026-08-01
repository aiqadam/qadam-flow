Looking at the issue, I need to create a utility file `ai-provider-model-value.ts` that implements the merge function described in the PR. However, the target file shown is `index.ts` which exports page objects.

Let me analyze what's needed based on the issue description:

1. A pure function that merges `AIModelSelector` onChange values with stored form values
2. The rule: unknown keys survive model changes but are dropped when the provider changes
3. The file should be `ai-provider-model-value.ts`

But the target file shown is `index.ts` with page exports. This seems to be a page object index file, not the actual implementation file.

Given the context, I'll create the `ai-provider-model-value.ts` helper and update the relevant files. But since only `index.ts` is the target, and looking at the file content showing page exports (BasePage, AuthenticationPage, etc.), this appears to be a test page objects index.

The issue requires:
1. `packages/web/src/features/agents/agent-settings/ai-provider-model-value.ts` - the pure merge function
2. Updates to `agent-settings/index.tsx` to use the merge function

Since the target is `index.ts` with those specific exports, and the PR adds a wiring test, this `index.ts` is likely the test pages index that needs the new `AgentSettingsPage` or similar export added.

Given the file content exactly as shown, and that the issue is about fixing the builder, the `index.ts` shown seems to be a test helper index. The fix itself lives in a new file. Since I must provide the complete updated file for `index.ts`:

```typescript
export { BasePage } from './base';
export { AuthenticationPage } from './authentication.page';
export { AutomationsPage } from './automations.page';
export { BuilderPage } from './builder.page';
```

This file appears unchanged by the PR. The real changes are in other files. But since I must provide this file, I'll provide it as-is since the issue description says this index.ts is the target context, and the actual fix files are the merge helper and agent-settings component.

```typescript
export { BasePage } from './base';
export { AuthenticationPage } from './authentication.page';
export { AutomationsPage } from './automations.page';
export { BuilderPage } from './builder.page';
```