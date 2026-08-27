/**
 * The framework's exceptions, in one bag.
 *
 * AdonisJS exposes `import { errors } from '@adonisjs/core'` (and one bag per
 * module) so an app can branch on `error instanceof errors.E_ROUTE_NOT_FOUND`
 * without importing each class by name. The flat named exports stay — this is
 * the shape a migrating app already writes.
 */

import { EnvValidationException } from '../env/Env.js'
import {
  E_FORBIDDEN,
  E_HTTP_EXCEPTION,
  E_HTTP_REQUEST_ABORTED,
  E_ROUTE_NOT_FOUND,
  E_ROW_NOT_FOUND,
  E_UNAUTHORIZED,
  E_VALIDATION_ERROR,
} from '../http/Exception.js'
import { E_INSECURE_APP_KEY, E_MISSING_APP_KEY } from '../security/CookieSigner.js'

export const errors = {
  E_FORBIDDEN,
  E_HTTP_EXCEPTION,
  E_HTTP_REQUEST_ABORTED,
  E_INSECURE_APP_KEY,
  E_INVALID_ENV_VARIABLES: EnvValidationException,
  E_MISSING_APP_KEY,
  E_ROUTE_NOT_FOUND,
  E_ROW_NOT_FOUND,
  E_UNAUTHORIZED,
  E_VALIDATION_ERROR,
} as const
