/**
 * Who the request came from.
 *
 * These are the tests behind the one failure mode that would hand the account to
 * anyone on the Docker network: believing a header from an untrusted peer. Three
 * things have to hold, and each has bitten a real deployment somewhere:
 *
 *  - **An IPv4 client on a dual-stack listener still matches an IPv4 range.** Node
 *    reports it as `::ffff:10.0.0.5`. Unnormalised, every CIDR gate refuses every
 *    real request, and the bug looks like a configuration mistake.
 *  - **A bad CIDR is a startup failure, not a silent "matches nothing".**
 *  - **A missing peer address is untrusted.** Absent must never read as inside.
 */
import { describe, expect, it } from 'vitest'
import type { FastifyRequest } from 'fastify'
import { inCidrs, isTrustedPeer, parseCidrs, peerAddress } from '../../src/server/net.ts'

const asRequest = (remoteAddress: string | undefined): FastifyRequest =>
  ({ socket: { remoteAddress } }) as unknown as FastifyRequest

describe('parseCidrs', () => {
  it('accepts a bare address as a single host, the way trustProxy does', () => {
    const list = parseCidrs(['10.0.0.5'], 'TEST')
    expect(inCidrs('10.0.0.5', list)).toBe(true)
    expect(inCidrs('10.0.0.6', list)).toBe(false)
  })

  it('throws naming the offending entry rather than matching nothing', () => {
    expect(() => parseCidrs(['172.16.0.0/12', 'not-an-ip'], 'TRUSTED_PROXY_CIDRS')).toThrow(
      /TRUSTED_PROXY_CIDRS.*"not-an-ip"/,
    )
    // A plausible typo: /33 does not exist, and reading it as /32 would silently
    // narrow the range someone thought they had configured.
    expect(() => parseCidrs(['10.0.0.0/33'], 'TEST')).toThrow(/TEST/)
  })

  it('tolerates surrounding whitespace from a hand-edited .env', () => {
    const list = parseCidrs([' 192.168.1.0/24 '], 'TEST')
    expect(inCidrs('192.168.1.7', list)).toBe(true)
  })

  it('parses IPv6 ranges', () => {
    const list = parseCidrs(['fd00::/8'], 'TEST')
    expect(inCidrs('fd00::1', list)).toBe(true)
    expect(inCidrs('fe80::1', list)).toBe(false)
  })
})

describe('inCidrs', () => {
  const docker = parseCidrs(['172.16.0.0/12'], 'TEST')

  it('matches inside and refuses outside the range', () => {
    expect(inCidrs('172.18.0.4', docker)).toBe(true)
    expect(inCidrs('172.32.0.1', docker)).toBe(false)
    expect(inCidrs('8.8.8.8', docker)).toBe(false)
  })

  it('normalises an IPv4-mapped IPv6 address', () => {
    // This is what Node hands us for an IPv4 client on a dual-stack socket. Left
    // alone it matches no IPv4 range at all.
    expect(inCidrs('::ffff:172.18.0.4', docker)).toBe(true)
    expect(inCidrs('::ffff:8.8.8.8', docker)).toBe(false)
  })

  it('treats an absent, empty or unparseable address as outside', () => {
    expect(inCidrs(undefined, docker)).toBe(false)
    expect(inCidrs(null, docker)).toBe(false)
    expect(inCidrs('', docker)).toBe(false)
    expect(inCidrs('garbage', docker)).toBe(false)
  })

  it('does not throw when the address family differs from the range', () => {
    // ipaddr.js `match` throws on a kind mismatch; an IPv6 client against an
    // IPv4-only allow-list is a normal outcome, not an error.
    expect(inCidrs('2001:db8::1', docker)).toBe(false)
    expect(inCidrs('10.0.0.1', parseCidrs(['fd00::/8'], 'TEST'))).toBe(false)
  })

  it('matches nothing against an empty list', () => {
    expect(inCidrs('10.0.0.1', parseCidrs([], 'TEST'))).toBe(false)
  })
})

describe('peerAddress and isTrustedPeer', () => {
  const trusted = parseCidrs(['172.16.0.0/12'], 'TEST')

  it('reads the socket, which an HTTP client cannot choose', () => {
    expect(peerAddress(asRequest('172.18.0.4'))).toBe('172.18.0.4')
    expect(isTrustedPeer(asRequest('172.18.0.4'), trusted)).toBe(true)
  })

  it('refuses a peer outside the range however its headers read', () => {
    expect(isTrustedPeer(asRequest('203.0.113.9'), trusted)).toBe(false)
  })

  it('refuses a request whose socket is already gone', () => {
    expect(peerAddress(asRequest(undefined))).toBeNull()
    expect(isTrustedPeer(asRequest(undefined), trusted)).toBe(false)
  })
})
