/**
 * The stub template engine.
 *
 * A port of upstream's, so the cases are its grammar: comments, declared
 * props, inline variables, conditionals with their chain, loops with and
 * without names, custom blocks, and both interpolation forms.
 */

import { describe, expect, it } from 'vitest'
import { errors } from '../../src/index.js'
import { compile, escapeHtml, render } from '../../src/stubs/template.js'

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
    const source = `const a = \`x \${y}\``
    const out = render(source, {})
    expect(out).toBe(source)
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
    expect(() => render('{{#if a b c}}x{{/if}}', {})).toThrowError(errors.E_REAM_STUB_SYNTAX)
  })
})

describe('stub templates — expressions', () => {
  it('computes what a stub needs', () => {
    const state = { name: 'user', items: ['a', 'b'], entity: { path: null } }
    expect(render("{{ name + 's' }}", state)).toBe('users')
    expect(render('{{ items.length > 1 ? "many" : "one" }}', state)).toBe('many')
    expect(render("{{ entity.path ?? 'root' }}", state)).toBe('root')
    expect(render('{{ entity?.missing?.deep }}|{{ items[1] }}', state)).toBe('|b')
    expect(render('{{ (!items.length) }}{{ -2 * 3 + 1 }}{{ 7 % 4 }}', state)).toBe('false-53')
    expect(render('{{ 1 == "1" }}{{ null == undefined }}{{ 0 == null }}', state)).toBe(
      'truetruefalse',
    )
  })

  it('calls a helper the state hands over, with its owner as `this`', () => {
    const string = {
      prefix: 'App',
      pascal(this: { prefix: string }, value: unknown) {
        return `${this.prefix}${String(value).charAt(0).toUpperCase()}${String(value).slice(1)}`
      },
    }
    expect(render('{{ string.pascal(name) }}', { name: 'user', string })).toBe('AppUser')
  })

  it('hands a block the values its arguments compute', () => {
    const out = compile('{{#note tone=level list=[1, 2] meta={ a: 1 } }}', {
      props: ['level'],
      blocks: { note: (args) => JSON.stringify(args) },
    })({ level: 'warn' })
    expect(out).toBe('{"tone":"warn","list":[1,2],"meta":{"a":1}}')
  })
})

describe('stub templates — what a stub cannot reach', () => {
  // The engine used to compile a template with `new Function`: a stub was
  // code. These are the ways out a template could try, and each one stops.
  it('reads no prototype — the road back to a Function constructor', () => {
    expect(() => render('{{ name.constructor }}', { name: 'x' })).toThrowError(
      /cannot read "constructor"/,
    )
    expect(() => render('{{ name.constructor }}', { name: 'x' })).toThrowError(
      expect.objectContaining({ code: 'E_REAM_STUB_FORBIDDEN_KEY' }),
    )
    expect(() =>
      render("{{ name.constructor.constructor('return process')() }}", { name: 'x' }),
    ).toThrowError(/cannot read "constructor"/)
    expect(() => render('{{ entity.__proto__ }}', { entity: {} })).toThrowError(/__proto__/)
    expect(() => render("{{ entity['constr' + 'uctor'] }}", { entity: {} })).toThrowError(
      /constructor/,
    )
  })

  it('sees no inherited method, so it calls none', () => {
    expect(render('[{{ entity.toString }}]', { entity: {} })).toBe('[]')
    expect(() => render('{{ name.toUpperCase() }}', { name: 'x' })).toThrowError(
      /is not a function/,
    )
    expect(() => render('{{ name.toUpperCase() }}', { name: 'x' })).toThrowError(
      expect.objectContaining({ code: 'E_REAM_STUB_EVALUATION' }),
    )
  })

  it('sees no global', () => {
    for (const global of ['process', 'globalThis', 'require', 'Function', 'eval']) {
      expect(() => render(`{{ ${global} }}`, {})).toThrowError(
        expect.objectContaining({
          code: 'E_REAM_STUB_EVALUATION',
          message: `${global} is not defined`,
        }),
      )
    }
  })

  it('refuses JavaScript it does not interpret, at compile time', () => {
    for (const source of ['{{ a = 1 }}', '{{ (() => 1)() }}', `{{ \`$\{a}\` }}`, '{{ a; b }}']) {
      expect(() => compile(source, { props: ['a', 'b'] })).toThrowError(errors.E_REAM_STUB_SYNTAX)
    }
  })

  it('refuses an elif or an else with no if open', () => {
    expect(() => render('{{#else}}x', {})).toThrowError(/outside an \{\{#if\}\}/)
    expect(() => render('{{#each items}}{{#elif a}}{{/each}}', { items: [], a: 1 })).toThrowError(
      errors.E_REAM_STUB_SYNTAX,
    )
  })
})
