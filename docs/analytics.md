# Product analytics

The existing GA4 property is `G-FJ0X98RSJ8`. `public/analytics.js` configures the Google tag and owns the event/parameter allowlist. The studio imports that same module, so initialization is shared rather than duplicated. No new tracking dependency is installed.

## Coverage

| Area | Events |
| --- | --- |
| Navigation, buttons, sample presets, saved voice actions, feedback topics | `control_click` with `control` and `section` |
| Form engagement and settings | `field_started` once per field per page; `control_change` on committed changes |
| Section exposure and reading depth | `section_view` once per section; `page_scroll` at 25/50/75/100% |
| FAQs and guide topics | `accordion_toggle` with stable question/topic index and expanded state |
| Native audio players | `media_action`: play, pause, ended, seek, volume, playback rate; distinguishes generated audio, recording preview, and saved voice preview |
| Appearance | `theme_changed` |
| Engine and downloads | `engine_load_started`, `engine_ready`, `engine_failed`; includes load duration, cache/network source, isolation support, and language |
| Speech generation | `generation_requested`, `generation_started`, `generation_first_audio`, `generation_completed`, `generation_failed`, `generation_stopped`, `generation_validation_error` |
| Cloning | `clone_recording_requested`, `clone_recording_started`, `clone_recording_stopped`, `clone_sample_ready`, `clone_saved`, `clone_ready`, `clone_failed` |
| Voice library and export | `voice_selected`, `voice_deleted`, `download_requested`, `cache_cleared` |
| Feedback | `feedback_opened`, `feedback_closed`, `feedback_validation_error`, `feedback_submitted`, `feedback_delivery_failed` |

`control_click` records intent. Outcome events record the application's actual progress; do not treat a Generate click as successful generation. `download_requested` records the browser download being initiated, not the operating system confirming the file was saved. Feedback submission records acceptance by the form UI; its cross-origin Google Forms response cannot confirm delivery.

## Privacy and reliability

- No speech text, custom voice names or IDs, recordings, generated audio, feedback text, attribution names, email addresses, raw errors, or arbitrary link URLs enter custom event payloads.
- Text usage uses length buckets, not text. Custom voices use `voice_type=custom`; only the fixed built-in voice names are eligible for analytics.
- Page paths are allowlisted. Query strings/fragments and detailed referrer paths are excluded. Unknown paths become `/other`.
- Localhost traffic, Global Privacy Control, Do Not Track, and the GA disable flag suppress custom events. Localhost page views are disabled too.
- Google Signals and ad personalization signals are disabled. Analytics still uses GA's normal browser/device/session measurement; this is usage tracking, not anonymous voice data processing.
- Missing/blocked/throwing Google tags do not interrupt the studio. No keystroke logging, session replay, microphone streaming, or per-audio-chunk events are added.

## Set up reports in GA4

These account-side steps require access to the existing property; changing source code does not create reports or custom definitions automatically.

1. After deployment, check **Reports → Realtime** or **Admin → DebugView** for the custom events. Use Google's supported debug configuration for DebugView. Local development intentionally sends nothing to GA.
2. Add event-scoped custom dimensions for the parameters you need: `control`, `section`, `voice_type`, `builtin_voice`, `language`, `error_category`, `character_range`, `cache_source`, `stage`, `source`, `selection`, `media`, `action`, `topic`, `attribution`.
3. Add numeric custom metrics for `elapsed_ms`, `latency_ms`, and `duration_s` if you need them in custom reports. Keep their units consistent: the first two are milliseconds, the last is seconds.
4. Build a generation funnel: `engine_ready` → `generation_requested` → `generation_started` → `generation_completed` → `media_action` filtered to `action=play, media=generated` → `download_requested`.
5. Build a cloning funnel: `clone_recording_started` → `clone_sample_ready` → `clone_saved` → `clone_ready` → `generation_completed` filtered to `voice_type=custom`.
6. Compare failures/cancellations and load/first-audio latency by language and built-in/custom voice type. Compare sections viewed and control clicks to see where visitors drop out before starting a task.
7. Review the property's Enhanced Measurement and any other installed tags: this code's allowlist cannot control independent tags or account-side settings. Review the analytics disclosure/consent configuration for your deployment audience before public release.

Official references: [GA4 custom events](https://developers.google.com/analytics/devguides/collection/ga4/events), [event parameters and custom definitions](https://developers.google.com/analytics/devguides/collection/ga4/event-parameters), [avoiding personally identifiable information](https://support.google.com/analytics/answer/6366371).
