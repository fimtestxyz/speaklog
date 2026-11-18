# Speaklog — paid features (later, after v1 free is verified)

Transcription itself is never paywalled: the MediaPipe model runs
on-device and costs nothing per minute, so the free tier keeps full
live transcription forever. Pro charges for what surrounds it.

## Pricing sketch (to confirm before building any of this)

- Pro: ~$3–5/month or ~$30/year.
- Payment: Stripe payment links + a license key the user pastes into
  the app; the unlock flag is stored locally. No backend in v1 —
  validation is weak by design and acceptable for a first paid tier.
- Free limits (to confirm): e.g. 10 saved recordings, 15 minutes per
  session. Pro removes both limits.

## Todo

- [ ] **Pro tier plumbing** — free limits enforced in code (library
  size, session length), license-key entry + local unlock flag,
  upgrade prompts that explain what Pro adds. Depends on: Stripe
  account + payment links.
- [ ] **AI summary** (the paid anchor) — after a recording, generate
  key points + action items + a title from the transcript via an LLM
  API. First 3 summaries free so users can taste it, then Pro. Each
  summary costs API money, which is why the paywall is natural here.
  Must be explicit opt-in per summary, transcript only (never video),
  disclosed in the UI.
- [x] **VTT export + captions burned into video** — DONE FREE
  2026-11-18 (user chose all-free; was on the paid list, moved out).
  `.vtt` download, and an export that renders the captions onto the
  video file itself (canvas capture during playback), with font /
  size / color / position controls.
- [ ] **Transcript editing** — click a segment to correct its text;
  edits persist and flow into re-exports.
- [ ] **Search across recordings** — full-text search over saved
  transcripts in the library.
- [ ] **Unlimited library + session length** — part of Pro (see
  pricing sketch); no separate work beyond the limits in Pro plumbing.
- [ ] **Cloud backup / sync** (v2, architecture change) — needs a
  backend (storage + auth). Do not start until the static-only v1 is
  stable and paying users ask for it.
- [ ] **Speaker labels / diarization** (later) — needs a different
  model or a cloud API; evaluate only if users ask.
- [ ] **Teams / shared workspace** (later, backend) — shared libraries
  for interviews, user research, classrooms.
- [ ] **One-time lifetime purchase** (alternative to subscription) —
  decide after seeing whether users prefer it to monthly billing.

## Explicitly not doing

- Ads — kills the trust/privacy story.
- Selling data or transcripts — kills the core promise.
- Paywalling live transcription — indefensible when the engine is free.
