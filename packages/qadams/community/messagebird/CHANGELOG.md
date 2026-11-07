# @aiqadam/qadam-messagebird

## 0.3.1

### Patch Changes

- 17edb75: Stop computing time-relative values at module load, where they froze at image build (#598) instead of tracking now (#607). `messagebird` `listMessages` drops the `dayjs()` `startAt`/`endAt` prop defaults (now optional, falling back to the last 24 hours at run time); `microsoft-power-bi` `pushRowsToDatasetTable` uses a static example `Timestamp`; `okta` `newEvent` uses a static `sampleData` timestamp.
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
