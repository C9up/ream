/**
 * The stub template engine.
 *
 * A port of upstream's, so the cases are its grammar: comments, declared
 * props, inline variables, conditionals with their chain, loops with and
 * without names, custom blocks, and both interpolation forms.
 */

import { describe, expect, it } from 'vitest'
import { compile, escapeHtml, generate, render, StubSyntaxError } from '../../src/stubs/template.js'

describe('stub templates — interpolation', () => {
  it('reads a value, and reaches into an object', () => {
    expect(render('Hello {{ name }}', { name: 'Ada' })).toBe('Hello Ada')
    expect(render('{{ entity.name }}', { entity: { name: 'User' } })).toBe('User')
  })

  it('treats the triple form as the same thing', () => {
    // Upstream escapes HTML in `{{ }}` and leaves `{{{ }}}` raw, because its
    // templates are web pages. A stub is a SOURCE FILE: escaping `"` into
    // `&quot;` there produces code that does not parse.
    const state = { value: 'a "quoted" <thing>' }
    expect(render('{{ value }}', state)).toBe('a "quoted" <thing>')
    expect(render('{{{ value }}}', state)).toBe('a "quoted" <thing>')
  })

  it('escapes on request, for a stub that does template markup', () => {
    expect(
      compile('{{ value }}', { props: ['value'], escape: escapeHtml })({
        value: '<b>&</b>',
      }),
    ).toBe('&lt;b&gt;&amp;&lt;/b&gt;')
  })

  it('renders nothing for null and undefined, not "null"', () => {
    expect(render('[{{ a }}][{{ b }}]', { a: null, b: undefined })).toBe('[][]')
  })

  it('leaves a backtick and a dollar-brace alone', () => {
    // The literal text ends up inside a template literal; unescaped, these
    // would end the string or interpolate.
    const out = render('const a = `x ${y}`', {})
    expect(out).toBe('const a = `x ${y}`')
  })
})

describe('stub templates — blocks', () => {
  it('drops a comment', () => {
    expect(render('a{{! nothing to see }}b', {})).toBe('ab')
  })

  it('branches, with the whole chain', () => {
    const template = '{{#if count == 0}}none{{#elif count == 1}}one{{#else}}many{{/if}}'
    expect(render(template, { count: 0 })).toBe('none')
    expect(render(template, { count: 1 })).toBe('one')
    expect(render(template, { count: 7 })).toBe('many')
  })

  it('declares an inline variable', () => {
    expect(render('{{#var n = items.length }}{{ n }}', { items: [1, 2] })).toBe('2')
  })

  it('loops, named or not', () => {
    expect(render('{{#each items as item}}[{{ item }}]{{/each}}', { items: ['a', 'b'] })).toBe(
      '[a][b]',
    )
    expect(
      render('{{#each items as item, at}}{{ at }}:{{ item }} {{/each}}', {
        items: ['a', 'b'],
      }),
    ).toBe('0:a 1:b ')
    // No `as`: the index is `i`, as upstream names it.
    expect(render('{{#each items}}{{ i }}{{/each}}', { items: ['x', 'y'] })).toBe('01')
  })

  it('nests a loop inside a branch', () => {
    const out = render(
      '{{#if items.length}}{{#each items as item}}{{ item }}{{/each}}{{#else}}empty{{/if}}',
      { items: ['a', 'b'] },
    )
    expect(out).toBe('ab')
  })

  it('names what a template may read through expect', () => {
    // Declared, so an absent one is `undefined` rather than a ReferenceError.
    expect(render('{{#expect title }}[{{ title }}]', {})).toBe('[]')
  })

  it('calls a custom block with its arguments', () => {
    const out = compile('{{#note tone="warn" }}', {
      blocks: {
        note: (args) => `<!-- ${String(args.tone)} -->`,
      },
    })({})
    expect(out).toBe('<!-- warn -->')
  })
})

describe('stub templates — what it refuses', () => {
  it('names an unknown block instead of ignoring it', () => {
    expect(() => render('{{#nope x }}', {})).toThrowError(/Unknown "nope" block/)
  })

  it('refuses an unterminated block, and a mismatched close', () => {
    expect(() => render('{{#if a}}x', { a: true })).toThrowError(/Unterminated "if"/)
    expect(() => render('{{#if a}}x{{/each}}', { a: true })).toThrowError(
      /Expected to close "if"; closed "each"/,
    )
    expect(() => render('x{{/if}}', {})).toThrowError(/nothing open/)
  })

  it('refuses a var with no assignment', () => {
    expect(() => render('{{#var broken }}', {})).toThrowError(/needs an assignment/)
  })

  it('reports a template that does not compile as a stub error', () => {
    expect(() => render('{{#if a b c}}x{{/if}}', {})).toThrowError(StubSyntaxError)
  })
})

describe('stub templates — the generated source', () => {
  it('is readable, which is where a subtle mistake shows', () => {
    // Exposed on purpose: the compiled body is the only place to see what a
    // template actually became.
    expect(generate('Hi {{ name }}', { props: ['name'] })).toBe(
      'var{name}=$$s,x=`Hi ${$$e(name)}`;return x',
    )
  })
})
