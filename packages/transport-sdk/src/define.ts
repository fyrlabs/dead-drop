/**
 * `defineTransport` — the entry point a third-party adapter package exports.
 *
 * ```ts
 * import { defineTransport } from '@fyrlabs/dead-drop-transport-sdk';
 *
 * export const acmeTransport = defineTransport({
 *   id: 'acme',
 *   capabilities: { kind: 'store', ordering: 'partition', binaryPayloads: true,
 *                   delete: true, watch: false, orderedList: true },
 *   create(config, ctx) { return new AcmeStore(config, ctx); },
 * });
 * ```
 *
 * Users then pass `acmeTransport({ ... })` into their dead-drop configuration. No
 * change to the dead-drop repository is required, which is the whole point.
 */

import { DeadDropError } from '@fyrlabs/dead-drop-protocol';

import type { TransportDefinition, TransportFactory, TransportRegistration } from './types.js';

const ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

export function defineTransport<Config>(
  definition: TransportDefinition<Config>,
): TransportFactory<Config> & { definition: TransportDefinition<Config> } {
  assertValidDefinition(definition);

  const factory = ((config: Config, options?: { name?: string }): TransportRegistration<Config> => {
    const parsed = definition.parseConfig ? definition.parseConfig(config) : config;
    const registration: TransportRegistration<Config> = { definition, config: parsed };
    if (options?.name !== undefined) {
      if (!ID_PATTERN.test(options.name)) {
        throw new DeadDropError(
          'CONFIG_INVALID',
          `transport instance name "${options.name}" must match ${ID_PATTERN}`,
        );
      }
      registration.name = options.name;
    }
    return registration;
  }) as TransportFactory<Config> & { definition: TransportDefinition<Config> };

  factory.definition = definition;
  return factory;
}

function assertValidDefinition(definition: TransportDefinition<unknown>): void {
  if (!ID_PATTERN.test(definition.id)) {
    throw new DeadDropError(
      'CONFIG_INVALID',
      `transport id "${definition.id}" must be lower-case, 2-32 chars, matching ${ID_PATTERN}`,
    );
  }
  const caps = definition.capabilities;
  if (caps.kind !== 'store' && caps.kind !== 'native') {
    throw new DeadDropError('CONFIG_INVALID', `transport ${definition.id}: unknown kind`);
  }
  if (caps.maxPayloadBytes !== undefined && caps.maxPayloadBytes < 1024) {
    throw new DeadDropError(
      'CONFIG_INVALID',
      `transport ${definition.id}: maxPayloadBytes must be at least 1024`,
    );
  }
  if (caps.kind === 'store' && !caps.delete) {
    // Without delete there is no way to acknowledge and retire a message, and
    // the mailbox would grow without bound. Better to reject it up front.
    throw new DeadDropError(
      'UNSUPPORTED',
      `transport ${definition.id}: store transports must support delete`,
    );
  }
  if (typeof definition.create !== 'function') {
    throw new DeadDropError(
      'CONFIG_INVALID',
      `transport ${definition.id}: create must be a function`,
    );
  }
}

/** Name a registration resolves to. */
export function registrationName(registration: TransportRegistration<unknown>): string {
  return registration.name ?? registration.definition.id;
}
