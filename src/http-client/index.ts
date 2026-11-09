/**
 * `@c9up/ream/http-client` — outbound HTTP with an SSRF guard, and its test fake.
 */

export { isPublicAddress } from './addresses.js'
export {
  FakeHttpClient,
  type FakeMatcher,
  type FakeResponse,
  fakeHttp,
  type RecordedRequest,
} from './fake.js'
export {
  HttpClient,
  HttpClientError,
  type HttpClientFailure,
  type HttpClientOptions,
  type HttpRequestOptions,
  HttpResponse,
  type OutgoingRequest,
} from './HttpClient.js'
