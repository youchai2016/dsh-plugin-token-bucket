# Compatibility and verification boundaries

## Release and target environment

- Release: **0.1.0**, without a prerelease suffix.
- Developed and inspected against **DSH Desktop** on Windows with an installed `deepseek-official` provider; the balance endpoint and payload were confirmed live before release.
- Development requires Node.js 22+ and the pnpm version declared in the project manifest.
- This is a personal plugin, not an official DeepSeek product.

## What was verified, and what was not

The live endpoint was called once during development and returned `{ is_available: true, balance_infos: [{ currency: 'CNY', total_balance, granted_balance, topped_up_balance }] }`; a full conversation turn was observed to deduct exactly one cent-level amount from the granted wallet, matching the documented deduction order. That is the basis for the two-layer water.

The portable suite uses synthetic payloads and a stub transport. It covers money handling, sample folding, failure classification, poller cadence and backoff, fan-out, disposal, the DOM widget and bundle hygiene. It does not certify every DSH version, every credential provider layout or every network condition.

Real-browser rendering was checked in an isolated headless Chromium against the offline preview — never against a live DSH GUI — for these states: full, pouring, low, refilled, balance read failed, no key, and dark theme. That pass caught two visual defects before release (a tap variable set on a sibling element, and a low-water rule that tinted the whole pail).

Not verified: behaviour under a proxy that rewrites the balance payload, non-CNY wallets beyond the first entry, and how Platform-side rate limits treat frequent balance reads. The adaptive cadence keeps the request rate low (at most one request every five seconds, and only while money is moving) but no rate-limit contract is claimed.

## Runtime boundaries

- Host half: resolves `DEEPSEEK_API_KEY` through `ctx.credentials` on every read, performs one read-only `GET` to `https://api.deepseek.com/user/balance`, caches the result and fans it out to every open window. It subscribes to no session events.
- Client half: mounts the generated strict contract, validates every frame against it, and renders. It never performs a network request of its own.
- The credential is never stored, logged, echoed in an error, or included in any frame; a test asserts that neither a success nor a transport error carries it.
- State lives in browser local storage and in the Host's memory. No DSH profile, session log or transcript is read or written.

## Generated artifacts

`pnpm run build` produces three generated files that are committed so a Git install needs no build step: `lib/remote.js` (the strict browser/Host contract, bundled with Zod), `lib/index.js` (the Host half), and `lib/client.js` (the browser half). The offline preview and the frames harness live under `preview/` and `artifacts/`, which are not published.
