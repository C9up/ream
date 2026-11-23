/**
 * The errors of the outbound HTTP client, one per code. Each carries `url`,
 * the target without its query string (which may carry credentials).
 *
 * Status 500, the default: left uncaught in a handler, one answers a generic
 * 500, and its message, which names hosts and addresses, never reaches the
 * client.
 */
import { Exception } from '@c9up/flare'

/** An error class of the client, whose instances carry the URL asked for. */
export interface HttpClientErrorClass {
  new (url: URL | string, message: string, options?: ErrorOptions): HttpClientException
  readonly code: string
}

/** An instance of one of the client's error classes. */
export interface HttpClientException extends Exception {
  /** The target, without its query string. */
  readonly url: string
}

/** The URL with its query string and fragment dropped. */
function describeUrl(url: URL | string): string {
  if (typeof url === 'string') {
    try {
      return describeUrl(new URL(url))
    } catch {
      return url.split('?')[0] ?? url
    }
  }
  return `${url.origin}${url.pathname}`
}

function httpClientError(code: string): HttpClientErrorClass {
  return class extends Exception {
    static override code = code
    readonly url: string

    constructor(url: URL | string, message: string, options?: ErrorOptions) {
      super(message, options)
      this.name = code
      this.url = describeUrl(url)
    }
  }
}

/** The URL cannot be parsed, is not http or https, or carries credentials. */
export const E_HTTP_CLIENT_INVALID_URL = httpClientError('E_HTTP_CLIENT_INVALID_URL')

/** The host is, or resolves to, an address that is not public. */
export const E_HTTP_CLIENT_PRIVATE_ADDRESS = httpClientError('E_HTTP_CLIENT_PRIVATE_ADDRESS')

/** The host could not be reached. */
export const E_HTTP_CLIENT_UNREACHABLE = httpClientError('E_HTTP_CLIENT_UNREACHABLE')

/** The request did not complete within its timeout. */
export const E_HTTP_CLIENT_TIMED_OUT = httpClientError('E_HTTP_CLIENT_TIMED_OUT')

/** The response body is over the size limit. */
export const E_HTTP_CLIENT_TOO_LARGE = httpClientError('E_HTTP_CLIENT_TOO_LARGE')

/** A redirect was refused: too many of them, from https to http, or to another host. */
export const E_HTTP_CLIENT_REDIRECT_REFUSED = httpClientError('E_HTTP_CLIENT_REDIRECT_REFUSED')

const ALL: readonly HttpClientErrorClass[] = [
  E_HTTP_CLIENT_INVALID_URL,
  E_HTTP_CLIENT_PRIVATE_ADDRESS,
  E_HTTP_CLIENT_UNREACHABLE,
  E_HTTP_CLIENT_TIMED_OUT,
  E_HTTP_CLIENT_TOO_LARGE,
  E_HTTP_CLIENT_REDIRECT_REFUSED,
]

/** Whether `value` is one of the client's errors. */
export function isHttpClientError(value: unknown): value is HttpClientException {
  return ALL.some((ErrorClass) => value instanceof ErrorClass)
}
