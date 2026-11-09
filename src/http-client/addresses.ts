/**
 * Which addresses an outbound request may connect to.
 *
 * Everything that is not a globally routable unicast address is refused:
 * loopback, private and shared ranges, link-local (the cloud metadata
 * endpoint `169.254.169.254` lives there), documentation and benchmarking
 * ranges, multicast, and the IPv6 transition prefixes that tunnel to an IPv4
 * address (IPv4-compatible, NAT64, 6to4, Teredo) — through those, a "public" IPv6 address can
 * still reach `10.0.0.5`. An IPv4-mapped IPv6 address (`::ffff:10.0.0.5`) is
 * judged by the IPv4 rules.
 */

import { BlockList, isIP } from 'node:net'

const NON_PUBLIC_V4: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
]

const NON_PUBLIC_V6: ReadonlyArray<readonly [string, number]> = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['::', 96], // IPv4-compatible (deprecated), embeds an IPv4 address
  ['64:ff9b::', 96], // NAT64, embeds an IPv4 address
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard
  ['2001::', 23], // IETF protocol assignments, Teredo included
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4, embeds an IPv4 address
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
]

const nonPublic = new BlockList()
for (const [network, prefix] of NON_PUBLIC_V4) nonPublic.addSubnet(network, prefix, 'ipv4')
for (const [network, prefix] of NON_PUBLIC_V6) nonPublic.addSubnet(network, prefix, 'ipv6')

/** True for a globally routable unicast address; false for anything else, including a non-address. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 0) return false
  return !nonPublic.check(address, family === 4 ? 'ipv4' : 'ipv6')
}
