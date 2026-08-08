/**
 * The error model lives in `@fyrlabs/dead-drop-transport-sdk` because a
 * transport adapter has to throw it: the transport manager reads `retryable`
 * to decide between retrying and failing over. Re-exported here so the rest of
 * the runtime keeps importing it from the protocol layer it belongs to.
 */

export {
  DEAD_DROP_ERROR_CODES,
  DeadDropError,
  isDeadDropErrorCode,
  type DeadDropErrorCode,
  type DeadDropErrorOptions,
} from '@fyrlabs/dead-drop-transport-sdk';
