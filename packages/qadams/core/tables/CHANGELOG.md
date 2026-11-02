# @aiqadam/qadam-tables

## 0.5.2

### Patch Changes

- 035a45d: Import the shared helpers from `@aiqadam/qadams-framework` rather than the now-private `@aiqadam/shared` (#813); the built artifact changes, the step behaviour does not.
- 89aec70: Re-point the type-only `@aiqadam/shared` imports narrowed out of `qadams-framework`'s re-export list (#959) straight at `@aiqadam/shared` as `import type`. No behaviour change: `tsc` erases every one of these imports from the emitted JS, and `@aiqadam/shared` is added only as a `devDependency` (never installed by a consumer), the same pattern `@aiqadam/qadams-common` already uses for its tests. The seven symbols that would still be named in a shipped `.d.ts` are not re-pointed and stay framework exports, so neither qadam's tarball references the private package.
- Updated dependencies [b40c189]
- Updated dependencies [66d8bad]
- Updated dependencies [14ea41c]
- Updated dependencies [34efa2b]
- Updated dependencies [aa1658b]
- Updated dependencies [b1fc9d2]
- Updated dependencies [e986096]
- Updated dependencies [c639f50]
- Updated dependencies [e9c6861]
- Updated dependencies [482ecae]
- Updated dependencies [c2fde9a]
- Updated dependencies [18e5850]
- Updated dependencies [89aec70]
- Updated dependencies [9ccf0d2]
- Updated dependencies [627eda5]
- Updated dependencies [9af2e0c]
- Updated dependencies [47c9525]
- Updated dependencies [777a794]
  - @aiqadam/qadams-framework@0.37.0
  - @aiqadam/qadams-common@0.17.2
