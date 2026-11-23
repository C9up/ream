/**
 * The framework's exceptions, in one bag.
 *
 * AdonisJS exposes `import { errors } from '@adonisjs/core'` (and one bag per
 * module) so an app can branch on `error instanceof errors.E_ROUTE_NOT_FOUND`
 * without importing each class by name. Every code ream raises has its class
 * here, under that code.
 */

import { DumpDieException } from '../dumper/errors.js'
import {
  E_AUTHORIZATION_FAILURE,
  E_HTTP_EXCEPTION,
  E_HTTP_REQUEST_ABORTED,
  E_ROUTE_NOT_FOUND,
  E_UNAUTHORIZED_ACCESS,
  E_VALIDATION_ERROR,
} from '../http/Exception.js'
import { E_WEBSOCKET_UNSUPPORTED, E_WEBSOCKET_UPGRADE_REQUIRED } from '../http/WebSocket.js'
import { E_INSECURE_ENCRYPTER_KEY, E_MISSING_ENCRYPTER_KEY } from '../security/CookieSigner.js'
import {
  E_SESSION_COOKIE_NOT_HTTP_ONLY,
  E_SESSION_NOT_READY,
  E_SESSION_STORE_NOT_CONDITIONAL,
  E_SESSION_STORE_NOT_CONFIGURED,
  E_SESSION_TAGGING_NOT_SUPPORTED,
} from '../session/errors.js'
import * as codes from './codes.js'

export const errors = {
  ...codes,
  E_AUTHORIZATION_FAILURE,
  E_DUMP_DIE_EXCEPTION: DumpDieException,
  E_HTTP_EXCEPTION,
  E_HTTP_REQUEST_ABORTED,
  E_INSECURE_ENCRYPTER_KEY,
  E_MISSING_ENCRYPTER_KEY,
  E_ROUTE_NOT_FOUND,
  E_SESSION_COOKIE_NOT_HTTP_ONLY,
  E_SESSION_NOT_READY,
  E_SESSION_STORE_NOT_CONDITIONAL,
  E_SESSION_STORE_NOT_CONFIGURED,
  E_SESSION_TAGGING_NOT_SUPPORTED,
  E_UNAUTHORIZED_ACCESS,
  E_VALIDATION_ERROR,
  E_WEBSOCKET_UNSUPPORTED,
  E_WEBSOCKET_UPGRADE_REQUIRED,
} as const
