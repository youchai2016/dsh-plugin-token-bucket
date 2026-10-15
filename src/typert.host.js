// Authored strict reflection, validated against the installed DSH Typert loader.
// The Host needs this to accept the browser half's mounted descriptor; without it the
// balance stream is refused even though every file is present.
import { BUCKET_WATCH_DESCRIPTOR, BUCKET_SNAPSHOT_SCHEMA } from './remote.js';

export const TYPERT = {
  package: 'dsh-plugin-token-bucket', face: 'host',
  schemas: [
    { name: 'BucketSnapshot', create: () => BUCKET_SNAPSHOT_SCHEMA },
  ],
  invocations: [BUCKET_WATCH_DESCRIPTOR],
  model: {
    services: [{
      key: 'tokenBucket', exportName: 'TokenBucketService',
      description: 'Read-only API balance snapshots; no session content, history or model calls.',
      summary: 'Balance bucket balance snapshots', tags: [],
      members: [
        { kind: 'method', name: 'watch', signature: 'watch(signal: AbortSignal): AsyncIterable<BucketSnapshot>' },
      ],
      types: [],
    }],
    events: [], objects: [],
  },
};

export default TYPERT;
