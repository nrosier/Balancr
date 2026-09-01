/**
 * Process-wide logger.
 *
 * Redaction is configured here rather than at each call site: this app handles
 * a budget password, an OIDC client secret, a Ghostfolio token and a Gemini
 * key, and any of them can end up inside an error object attached to a log
 * line. A denylist at the sink is the only version of this that stays true as
 * the code grows.
 */
import pino from 'pino'
import { config } from './config.ts'

export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: [
      'password',
      'e2ePassword',
      'accessToken',
      'securityToken',
      'apiKey',
      'clientSecret',
      'authorization',
      'cookie',
      '*.password',
      '*.accessToken',
      '*.apiKey',
      'req.headers.authorization',
      'req.headers.cookie',
    ],
    censor: '[redacted]',
  },
  // Pretty output in development only; production logs are JSON for the
  // container's log driver.
  ...(config.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss' } } }
    : {}),
})

export type Logger = typeof logger
