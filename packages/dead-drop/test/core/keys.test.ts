import { describe, expect, it } from 'vitest';

import {
  identityKey,
  identityPrefix,
  inboxKey,
  parseIdentityKey,
  parseWrappedKey,
  peerKey,
  wrappedKeyKey,
  wrappedKeyPrefix,
  wrappedKeyRoot,
} from '@fyrlabs/dead-drop/core';

const WS = 'demo';

describe('identity keys', () => {
  it('round-trips a peer id', () => {
    const key = identityKey(WS, 'peer-a');
    expect(key).toBe('ws/demo/ids/peer-a.ddi');
    expect(parseIdentityKey(WS, key)).toBe('peer-a');
  });

  it('lists under a prefix that holds nothing else', () => {
    expect(identityKey(WS, 'peer-a').startsWith(`${identityPrefix(WS)}/`)).toBe(true);
  });

  // A store cannot be trusted to hold only what dead-drop wrote, which is the
  // same reason parsePeerKey exists. Every one of these is a real shape a synced
  // folder or a git repo can present.
  it.each([
    ['another workspace', 'ws/other/ids/peer-a.ddi'],
    ['a nested path', 'ws/demo/ids/nested/peer-a.ddi'],
    ['the wrong extension', 'ws/demo/ids/peer-a.ddf'],
    ['no extension', 'ws/demo/ids/peer-a'],
    ['an empty peer id', 'ws/demo/ids/.ddi'],
    ['a different prefix', 'ws/demo/peers/peer-a.ddi'],
    ['the prefix itself', 'ws/demo/ids'],
  ])('rejects %s', (_why, key) => {
    expect(parseIdentityKey(WS, key)).toBeUndefined();
  });

  it('does not mistake a beacon or an inbox object for an identity', () => {
    expect(parseIdentityKey(WS, peerKey(WS, 'peer-a'))).toBeUndefined();
    expect(parseIdentityKey(WS, inboxKey(WS, 'peer-a', 'm1'))).toBeUndefined();
  });
});

describe('wrapped key objects', () => {
  it('round-trips a peer and an era', () => {
    const key = wrappedKeyKey(WS, 'peer-a', 'deadbeef');
    expect(key).toBe('ws/demo/keys/peer-a/deadbeef.ddw');
    expect(parseWrappedKey(WS, key)).toEqual({ peerId: 'peer-a', eraId: 'deadbeef' });
  });

  it('groups by peer, so one peer reads exactly one prefix for every era it holds', () => {
    const prefix = `${wrappedKeyPrefix(WS, 'peer-a')}/`;
    expect(wrappedKeyKey(WS, 'peer-a', 'era1').startsWith(prefix)).toBe(true);
    expect(wrappedKeyKey(WS, 'peer-a', 'era2').startsWith(prefix)).toBe(true);
    // And another peer's keys are not under it, or a peer would read keys that
    // are not addressed to it on every cycle.
    expect(wrappedKeyKey(WS, 'peer-b', 'era1').startsWith(prefix)).toBe(false);
  });

  it.each([
    ['another workspace', 'ws/other/keys/peer-a/era.ddw'],
    ['too shallow', 'ws/demo/keys/era.ddw'],
    ['too deep', 'ws/demo/keys/peer-a/nested/era.ddw'],
    ['the wrong extension', 'ws/demo/keys/peer-a/era.ddf'],
    ['an empty era', 'ws/demo/keys/peer-a/.ddw'],
    ['an empty peer', 'ws/demo/keys//era.ddw'],
    ['the root itself', 'ws/demo/keys'],
  ])('rejects %s', (_why, key) => {
    expect(parseWrappedKey(WS, key)).toBeUndefined();
  });

  it('keeps identities and wrapped keys in separate prefixes', () => {
    expect(identityPrefix(WS)).not.toBe(wrappedKeyRoot(WS));
    expect(parseWrappedKey(WS, identityKey(WS, 'peer-a'))).toBeUndefined();
    expect(parseIdentityKey(WS, wrappedKeyKey(WS, 'peer-a', 'era'))).toBeUndefined();
  });
});
