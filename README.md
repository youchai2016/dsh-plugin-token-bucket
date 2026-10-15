# Balance Bucket · 余额水桶

**A little bucket that drains while your DeepSeek API balance is being spent.**

![Six bucket states: full, pouring, low, refilled, unreadable, and dark theme](https://raw.githubusercontent.com/youchai2016/dsh-plugin-token-bucket/v0.1.0/docs/images/bucket-states.png)

一只挂在窗口角落的小水桶。**水是你的余额，漏出去的是正在花的钱。**

Version 0.1.0.

## What it does

- **The water level is your real balance.** It reads `GET https://api.deepseek.com/user/balance` with the same `DEEPSEEK_API_KEY` that DSH chats with, so the bucket shows the money you actually have.
- **The water is two layers, because the money is.** Granted balance (赠送) floats on top of topped-up balance (充值). DeepSeek deducts the granted wallet first, so you watch the pale layer empty before the deep one moves.
- **The tap opens while money moves.** The stream and its droplets are proportional to the burn rate over the last three minutes — the tool for watching a `vibe coding` session eat your credit.
- **The bucket is as tall as the highest balance it has ever seen.** It starts full, and a top-up makes it taller rather than overflowing.
- **A failed read never lies.** If the balance cannot be read, the water stays where it was, the tap shuts, and the outline turns amber. It never empties the bucket to show an error.

Move it, resize it, tuck it away — right-click for settings, drag to reposition, arrow keys to nudge.

## Reading the bucket

| Look | Meaning |
| --- | --- |
| Pale layer on top | Granted balance (spent first) |
| Deep layer below | Topped-up balance |
| Blue water | Above 30% of the highest balance seen |
| Amber water | Between 10% and 30% |
| Red water, gentle wobble | Below 10% |
| Amber outline, no stream | The last read failed; the level is the last known one |
| Grey water, `—` | No API key configured, or the key was rejected |

Hover the bucket for the numbers, or open the settings panel for balance, granted/topped-up split, spent since start, added since start, burn rate, bucket size and the age of the last reading.

## Install

Package page: [dsh-plugin-token-bucket on npm](https://www.npmjs.com/package/dsh-plugin-token-bucket).

```text
dsh-plugin-token-bucket
```

Or pin this release:

```text
github:youchai2016/dsh-plugin-token-bucket#v0.1.0
```

The plugin needs the credential DSH already manages for chat. If the Models page has a working DeepSeek API key, the bucket works; if not, it says so instead of guessing.

## Privacy and runtime boundaries

- The API key is resolved through DSH's credential service on every poll and is **never** stored, logged, echoed in an error, or sent to the client half. The browser half never talks to the balance service itself.
- **One** outbound request exists: a read-only `GET` on the documented balance endpoint. No model calls, no telemetry, no listening port, no third-party service.
- Nothing about your conversations is read. This plugin subscribes to **no** session events, so it cannot see prompts, replies or tool output.
- Preferences and history live in the browser's local storage. The plugin never writes your DSH profile.

## Honest limits

- The burn rate is **estimated from balance deltas**, not from token counts: the balance moves in whole cents (¥0.01), so the reading is a rolling three-minute average rather than a per-request figure. It is deliberately not a billing statement.
- Polling is adaptive: every 5 seconds for two minutes after money moves, then 20 seconds, then once a minute while nothing happens. Change calls from other devices or tools are also visible, because they move the same balance.
- Prices, bonuses and the split between granted and topped-up balance are whatever the API reports. The bucket does not compute costs from a price list.
- Balances are read for one currency, preferring CNY.

## Development

```sh
pnpm install --frozen-lockfile
pnpm run build
npm test
```

`preview/index.html` is a single offline file: open it in a browser, no server and no network needed. Its buttons fabricate balance samples, so every state can be inspected without an API key.

The Host half is bundled to `lib/index.js`, the strict browser/Host contract to `lib/remote.js`, and the browser half to `lib/client.js` by `pnpm run build`. Prebuilt files are committed so a Git install needs no build step.

## License

Code is [MIT](LICENSE). No third-party artwork is bundled: the bucket is drawn with CSS and one inline SVG.
