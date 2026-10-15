# Changelog

## 0.1.1 — 2026-10-15

### Fixed

- **The Host now ships its strict reflection** (`lib/typert.host.js`, exported as `./typert`). Without it the plugin could load every file and still have the balance stream refused — a Git or npm install would have looked installed and shown nothing.
- A Host without a usable `fetch` is reported as `no fetch` instead of a vague network failure.
- The water variables are set on the bucket root, so the spout, the falling stream and the droplets actually animate, and the low-water rule tints only the water rather than the whole pail.

### Added

- The settings panel shows the short, sanitised reason behind a non-ready state (no key, rejected key, no fetch, timeout, unreadable answer), so a first run can be diagnosed without opening a console.

### Changed

- The state screenshot was regenerated from the shipped UI, including the failure reason line.

## 0.1.0 — 2026-10-15

### Added

- A draggable bucket whose water level is the real `DEEPSEEK_API_KEY` balance, read from the documented `GET /user/balance` endpoint.
- Two-layer water: granted balance above topped-up balance, mirroring DeepSeek's deduction order (granted is spent first).
- A tap whose stream and droplets are proportional to the burn rate over a rolling three-minute window, plus a hover and settings readout (balance, split, spent since start, added since start, rate, bucket size, age of the reading).
- The bucket is as tall as the highest balance ever seen, so it starts full and a top-up makes it taller instead of overflowing.
- Adaptive polling: 5 s for two minutes after money moves, then 20 s, then 60 s while nothing happens; failures back off up to ten minutes.
- English and Chinese text, light and dark themes, and reduced-motion support.
- An offline preview whose buttons fabricate samples, so every state is inspectable without a credential.

### Behaviour notes

- The Host resolves the credential through DSH's credential service on every poll. The key is never stored, logged, echoed in an error, or exposed to the browser half; a read that fails keeps the last known water level and simply shuts the tap.
- Exactly one outbound request exists (a read-only balance `GET`). The plugin subscribes to no session events, so prompts, replies and tool output are invisible to it, and it never writes the DSH profile.
- Amounts cross the Host/client boundary as integer hundredths, so the level, the totals and the rate cannot drift.

### Verification

- 23 portable checks pass: exact money parsing and formatting, baseline/spend/refill folding, duplicate and out-of-order samples, stale readings, the rolling rate window, persistence, payload parsing, secret non-leakage, failure classification, poller cadence and backoff, fan-out, disposal, the DOM widget's states and interactions, bundle hygiene and dictionary parity.
- Every bucket state was also rendered in a real Chromium build through the offline preview (full, pouring, low, refilled, failed read, no key, dark theme) before release; that pass is what caught a tap whose water variable was set on a sibling element, and a low-water rule that painted the whole pail.

### Known limits

- The burn rate is a rolling average of balance deltas, not token accounting: the balance moves in whole cents, so the figure is an indicator rather than a billing statement.
- Only the first wallet of the payload is used, preferring CNY.
