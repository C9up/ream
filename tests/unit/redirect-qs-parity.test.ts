/**
 * `redirect().withQs()` in the four shapes AdonisJS accepts, plus `clearQs()`.
 * Read off @adonisjs/http-server's RedirectBuilder: one `withQs(name, value)`
 * implementation branching on the argument type, and a composition order that
 * puts the forwarded query string first and explicit values on top.
 */
import { describe, expect, it } from 'vitest'
import { RedirectBuilder } from '../../src/http/RedirectBuilder.js'
import { Response } from '../../src/http/Response.js'

function build(requestUrl = '/search?page=1&tag=news') {
  const response = new Response()
  const redirect = new RedirectBuilder(response, {
    requestUrl,
    routeUrlResolver: (name) => `/${name}`,
  })
  return { response, redirect }
}

function location(response: Response): string {
  return String(response.getHeaders().location ?? '')
}

describe('ream > redirect().withQs (AdonisJS parity)', () => {
  it('forwards the request query string with no arguments', () => {
    const { response, redirect } = build()
    redirect.withQs().toPath('/dashboard')
    expect(location(response)).toBe('/dashboard?page=1&tag=news')
  })

  it('stops forwarding when passed false', () => {
    const { response, redirect } = build()
    redirect.withQs().withQs(false).toPath('/dashboard')
    expect(location(response)).toBe('/dashboard')
  })

  it('merges an object of values', () => {
    const { response, redirect } = build('/x')
    redirect.withQs({ utm_source: 'newsletter', ref: 'a' }).toPath('/dashboard')
    expect(location(response)).toBe('/dashboard?utm_source=newsletter&ref=a')
  })

  it('sets a single name/value pair', () => {
    const { response, redirect } = build('/x')
    redirect.withQs('page', 2).toPath('/dashboard')
    expect(location(response)).toBe('/dashboard?page=2')
  })

  it('accumulates across calls rather than replacing', () => {
    const { response, redirect } = build('/x')
    redirect.withQs('a', 1).withQs({ b: 2 }).toPath('/dashboard')
    expect(location(response)).toBe('/dashboard?a=1&b=2')
  })

  it('lets an explicit value override a forwarded one', () => {
    // Adonis parses the forwarded string first, then Object.assign's the
    // explicit values over it.
    const { response, redirect } = build()
    redirect.withQs().withQs('page', 9).toPath('/dashboard')
    expect(location(response)).toBe('/dashboard?page=9&tag=news')
  })

  it('clearQs() drops both the values and the forwarding', () => {
    const { response, redirect } = build()
    redirect.withQs().withQs('a', 1).clearQs().toPath('/dashboard')
    expect(location(response)).toBe('/dashboard')
  })
})
