// Authored strict Typert contract for the balance snapshot stream.
// Bundled into lib/remote.js so the browser needs no external schema module.
// Amounts travel as integer hundredths (cents) so the client never sees float drift.
import * as z from 'zod/mini';

const sequence = z.int().check(z.minimum(0), z.maximum(Number.MAX_SAFE_INTEGER));
const cents = z.int().check(z.minimum(-1_000_000_000), z.maximum(1_000_000_000));
const epoch = z.string().check(z.minLength(1), z.maxLength(128));

export const BUCKET_SNAPSHOT_SCHEMA = z.strictObject({
  type: z.literal('snapshot'),
  hostEpoch: epoch,
  seq: sequence,
  // Wall-clock time of the sample, and how long the host will wait before the next one.
  at: z.number(),
  pollMs: z.int().check(z.minimum(1000), z.maximum(3_600_000)),
  status: z.union([
    z.literal('ready'),
    z.literal('unconfigured'),
    z.literal('unauthorized'),
    z.literal('unreachable'),
    z.literal('invalid'),
  ]),
  // Present only while `status` is `ready`.
  currency: z.optional(z.union([z.literal('CNY'), z.literal('USD')])),
  totalCents: z.optional(cents),
  grantedCents: z.optional(cents),
  toppedUpCents: z.optional(cents),
  available: z.optional(z.boolean()),
  // Host-side accumulation since the Host started; the client keeps its own longer history.
  spentCents: cents,
  // A short, non-sensitive explanation for a non-ready status (never a key or a header).
  detail: z.optional(z.string().check(z.maxLength(160))),
});

export const BUCKET_WATCH_DESCRIPTOR = {
  id: 'dsh-plugin-token-bucket#tokenBucket/watch', service: 'tokenBucket', namespace: 'tokenBucket', method: 'watch',
  mode: 'stream', invocation: { kind: 'direct' }, parameters: [],
  cancellation: { parameter: 'signal' },
  result: { mode: 'strict', typeSymbol: 'dsh-plugin-token-bucket#BucketSnapshot', create: () => BUCKET_SNAPSHOT_SCHEMA },
};

export const TYPERT_REMOTE = { package: 'dsh-plugin-token-bucket', descriptors: [BUCKET_WATCH_DESCRIPTOR] };
