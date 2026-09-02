/**
 * Who the request actually came from.
 *
 * This file exists because of one failure mode that this exact stack — Cloudflare
 * in front of Traefik in front of Authentik — makes easy to get wrong: if the
 * application believes `X-Forwarded-For` or `X-authentik-username` from whoever
 * sent it, then anyone who can reach the container directly authenticates as the
 * owner by setting a header. Docker networks are routable from other containers,
 * so "reaching the container directly" is not a hypothetical.
 *
 * The distinction that prevents it is between two different addresses:
 *
 *  - **The peer** (`peerAddress`) is the TCP socket's remote address. It cannot
 *    be forged by an HTTP client — it is whoever actually opened the connection.
 *  - **The client** (`request.ip`) is what Fastify resolved *from headers* after
 *    consulting `trustProxy`. It is the right answer for logging and rate
 *    limiting, and the wrong answer for deciding whether to believe a header.
 *
 * So: forwarded identity is honoured only when `isTrustedPeer` says the peer is
 * inside `TRUSTED_PROXY_CIDRS`, and that check reads the socket, never a header.
 *
 * `ipaddr.js` does the parsing rather than a regex of our own. It is what
 * Fastify's own `trustProxy` uses underneath, so it is already in the dependency
 * tree — and IPv4-mapped IPv6, which is what Node reports for an IPv4 client on a
 * dual-stack listener, is precisely the case a hand-rolled matcher gets wrong.
 */
import ipaddr from 'ipaddr.js'
import type { FastifyRequest } from 'fastify'

type Address = ipaddr.IPv4 | ipaddr.IPv6
type Range = [Address, number]

/** A parsed allow-list. Opaque on purpose: parse once at startup, match often. */
export type CidrList = readonly Range[]

/**
 * Parses a list of CIDRs, or throws naming the offending entry.
 *
 * A bare address is accepted and read as a single host, matching how
 * `trustProxy` treats the same value — a configuration that means `10.0.0.5`
 * should not have to say `/32` to be understood.
 *
 * Throwing is the point: a typo in `TRUSTED_PROXY_CIDRS` that silently parsed as
 * "match nothing" would disable OIDC header trust, and a typo that parsed as
 * "match everything" would hand the account to anyone on the Docker network.
 * Both are startup failures.
 */
export function parseCidrs(entries: readonly string[], label: string): CidrList {
  return entries.map((entry) => {
    const value = entry.trim()
    try {
      if (value.includes('/')) return ipaddr.parseCIDR(value)
      const address = ipaddr.parse(value)
      return [address, address.kind() === 'ipv4' ? 32 : 128] as Range
    } catch {
      throw new Error(`${label} contains an invalid CIDR or address: "${entry}"`)
    }
  })
}

/**
 * The address as it should be compared: an IPv4-mapped IPv6 becomes its IPv4.
 *
 * Node reports an IPv4 client on a dual-stack socket as `::ffff:10.0.0.5`. Left
 * alone, that address matches no IPv4 range at all, so every CIDR gate in the
 * app would quietly refuse every real request — the kind of bug that looks like
 * a configuration mistake for an afternoon.
 */
function normalise(address: string): Address | null {
  try {
    const parsed = ipaddr.parse(address)
    return parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()
      ? (parsed as ipaddr.IPv6).toIPv4Address()
      : parsed
  } catch {
    return null
  }
}

/** True when the address falls inside any range. An unparseable address is false. */
export function inCidrs(address: string | undefined | null, cidrs: CidrList): boolean {
  if (address === undefined || address === null || address === '') return false
  const parsed = normalise(address)
  if (parsed === null) return false

  return cidrs.some(([range, bits]) => {
    // `match` throws when the kinds differ, which is a normal outcome here: an
    // IPv6 client against an IPv4-only allow-list simply does not match.
    if (range.kind() !== parsed.kind()) return false
    return parsed.match(range as never, bits)
  })
}

/**
 * The socket's remote address — the one an HTTP client cannot choose.
 *
 * Null when the socket is already gone, which is treated as untrusted
 * everywhere: an absent address must never read as "inside the allow-list".
 */
export function peerAddress(request: FastifyRequest): string | null {
  return request.socket.remoteAddress ?? null
}

/**
 * Whether this request's forwarded headers may be believed.
 *
 * Deliberately takes the parsed list rather than reading config, so a test can
 * state the range it is testing and so the parse happens once at startup.
 */
export function isTrustedPeer(request: FastifyRequest, trusted: CidrList): boolean {
  return inCidrs(peerAddress(request), trusted)
}
