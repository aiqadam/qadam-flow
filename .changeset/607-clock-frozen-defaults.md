---
"@aiqadam/qadam-messagebird": patch
"@aiqadam/qadam-microsoft-power-bi": patch
"@aiqadam/qadam-okta": patch
---

Stop computing time-relative values at module load, where they froze at image build (#598) instead of tracking now (#607). `messagebird` `listMessages` drops the `dayjs()` `startAt`/`endAt` prop defaults (now optional, falling back to the last 24 hours at run time); `microsoft-power-bi` `pushRowsToDatasetTable` uses a static example `Timestamp`; `okta` `newEvent` uses a static `sampleData` timestamp.
