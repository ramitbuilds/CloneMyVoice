# Production release review — 19 October 2026

## Verdict

The current source passes the local release checks and is suitable for a controlled production rollout. No blocking code defect remains from this review. This is not a certification of every browser, real microphone, or the live Google Analytics account. Complete the deployment/account/device checks below before treating the rollout as fully verified.

Nothing was deployed, committed, or pushed by this task.

## Verified

| Check | Evidence |
| --- | --- |
| Production build | `npm run build` generates all 11 pages successfully. |
| Automated checks | `npm test`: 36 tests, zero failures. Covers voice encoding windows, generation ordering/cancellation, loading gates/retry, literal voice-name rendering, storage commit/abort and read-failure recovery, microphone cleanup, feedback timing, analytics privacy, event funnels, and coverage of built controls. |
| Dependencies | `npm audit --omit=dev --audit-level=high`: zero reported vulnerabilities. This does not replace a source or browser review. |
| Built navigation | All internal links resolve to generated pages. Canonicals point at each main page; alias pages point at their main equivalents. |
| Analytics coverage | All 475 rendered button/link/form-control instances across the 11 pages have safe identities (49 distinct static control names). All 22 FAQ/guide accordions are labeled. Dynamic saved-voice actions are covered separately. |
| Analytics safety | Payload allowlists exclude scripts, voice names/IDs, audio, feedback content, attribution/contact details, raw errors, arbitrary URL details. Opt-outs/local traffic and missing/throwing Google tags are covered by tests. |
| Engine memory | Real ONNX encoder → voice conditioning → flow model → decoder produces finite audio with a 30-second sample. Prepared voice-state caching is bounded to two entries. |
| Built-site cloning | A separate localhost origin served the built assets with the headers from `vercel.json`. A saved 30-second synthetic clone generated a 10.08-second WAV. Download validated as mono, 24 kHz, 16-bit PCM with nonzero signal. No browser warning/error was captured. |
| Built-in voice | Alba generated a 0.6-second output after the cloned-voice test, with no captured browser errors. |
| HTML safety | The built site displayed `<b>Release test</b>` literally; there was no injected `b` element. |
| Loading UX | Generate/record remain disabled during engine startup and enable on readiness. A clear status and separate retry action handle startup failures. |
| Temporary test artifacts | The temporary release-fixture HTML and downloaded QA WAV were removed. Test data was isolated from the production origin. |

## Fixes completed during this review

- Added detailed GA4 controls, section/reading depth, audio playback, settings/form engagement, task funnels, failures/cancellations, timing, and feedback events. Kept the existing property ID.
- Added a strict event/parameter allowlist; sanitized page/referrer information; excluded local development traffic and supported privacy opt-outs; disabled Google Signals and ad personalization signals.
- Updated the privacy disclosure to reflect analytics and the existing Google Forms feedback submission accurately.
- Added Vercel production isolation headers. Header behavior was checked on the local production-header server. `astro preview` in this environment did not apply the old Vite preview hook, so it was not treated as proof of production headers.
- Corrected page/alias canonical URLs.
- Bounded prepared voice-state memory; removed the fallback that could use a different clone when a voice ID was missing; deleted profiles now also clear their worker cache entries.
- Storage writes/deletes wait for transaction commit and reject aborted transactions. Database connections are closed after operations.
- Final repeat review: a failed saved-voice read now restores Generate and shows a retry message instead of leaving the loading state stuck. A regression test reproduces the original failure and verifies a successful retry; the production build and all 36 tests pass after the fix.
- Microphone setup failures release the stream. Decoding contexts are closed, and recorded blobs preserve the recorder's MIME type for browser compatibility.
- Released obsolete library preview URLs and reused the completed audio URL for downloads; kept typed audio samples in IndexedDB while retaining compatibility with existing Array-based records.
- Retained the requested unprocessed recording behavior: noise suppression, echo cancellation, automatic gain, software filtering, and silence trimming remain off. Only required mono/24 kHz conversion and bounded model encoding are applied.

## Checks that remain outside this local sign-off

1. **Deployment:** after publishing, verify the actual HTTPS response has `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: credentialless`. Source configuration alone does not prove the hosting platform applied it. Repeat one built-in and one saved-clone generation on that deployment.
2. **Google Analytics account:** verify event receipt in Realtime/DebugView; register the desired custom dimensions/metrics and create the funnels described in [analytics.md](analytics.md). Property access was not available, and local testing intentionally sends no production events.
3. **Real devices and voice quality:** test an actual microphone on the browsers/devices you intend to support, especially Safari/iOS and Android. The real-model/browser QA here used synthetic audio; it validates execution and file output, not how closely a clone matches a real speaker. Non-English bundles were not exercised end to end in this review.
4. **Analytics configuration/disclosure:** review the property's Enhanced Measurement/other tags and the consent configuration appropriate for the audience. This source's privacy allowlist cannot govern independent tags or settings in the Google account.
5. **Feedback delivery:** no real feedback was submitted during QA. The existing cross-origin `no-cors` Google Forms request does not expose delivery confirmation; `feedback_submitted` means the app accepted the form, not guaranteed receipt.

## Repeatable local checks

```sh
npm run build
npm test
npm audit --omit=dev --audit-level=high
git diff --check
```

Build before running the test suite to include the production-control coverage test. Without built output that one check is skipped. No additional production dependency was added.

References used for implementation: [Google Analytics custom events](https://developers.google.com/analytics/devguides/collection/ga4/events), [GA4 event parameters](https://developers.google.com/analytics/devguides/collection/ga4/event-parameters), [Google's PII guidance](https://support.google.com/analytics/answer/6366371), [Vercel static configuration](https://vercel.com/docs/project-configuration/vercel-json).
