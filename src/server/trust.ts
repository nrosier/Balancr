/**
 * The CIDR allow-lists, parsed once at startup.
 *
 * Separate from `net.ts` so that file stays free of configuration and testable
 * against ranges a test states itself, and separate from `config.ts` so parsing
 * addresses is not the environment loader's job.
 *
 * Parsing here rather than at first use is deliberate: `parseCidrs` throws on a
 * bad entry, and a typo in `TRUSTED_PROXY_CIDRS` must stop the process at boot
 * rather than surface as a request that mysteriously is not trusted.
 */
import { config } from '../config.ts'
import { parseCidrs } from './net.ts'

/** Peers whose `X-Forwarded-*` / `X-authentik-*` headers may be believed. */
export const TRUSTED_PROXIES = parseCidrs(config.TRUSTED_PROXY_CIDRS, 'TRUSTED_PROXY_CIDRS')

/**
 * Where break-glass local login is allowed from.
 *
 * Used by the local login routes (v0.5.0 slice C) against the *peer* address, so
 * that a request arriving through the public tunnel cannot claim a LAN address.
 */
export const LOCAL_LOGIN_CIDRS = parseCidrs(
  config.AUTH_LOCAL_ALLOWED_CIDRS,
  'AUTH_LOCAL_ALLOWED_CIDRS',
)
