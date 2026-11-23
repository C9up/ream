/**
 * The stub template engine.
 *
 * The grammar upstream's engine (tempura) reads, tag for tag: comments,
 * declared props, inline variables, conditionals, loops, custom blocks, and
 * the two interpolation forms.
 *
 *     {{! a comment }}
 *     {{#expect name, entity }}
 *     {{#var plural = name + 's' }}
 *     {{#if entity.isModel }}…{{#elif entity.isView }}…{{#else}}…{{/if}}
 *     {{#each items as item, index }}…{{/each}}
 *     {{ name }}      the value
 *     {{{ name }}}    the value, unescaped
 *
 * NAMED DEVIATION — upstream escapes HTML in `{{ }}` and leaves `{{{ }}}`
 * raw, because its templates are web pages. Ours are SOURCE FILES: escaping
 * `"` into `&quot;` there produces code that does not parse, and the mistake
 * is silent. So `{{ }}` does not escape by default, `{{{ }}}` is accepted as
 * the same thing (a stub written for upstream keeps working), and an `escape`
 * option turns it back on for anyone templating markup.
 *
 * NAMED DEVIATION — upstream compiles a template into JavaScript and runs it
 * through `new Function`, so a tag holds any JavaScript and a template is
 * code. Here a template is parsed once into a tree and interpreted; nothing
 * is ever compiled from its text. An expression is the part of JavaScript a
 * stub needs — literals, names, `a.b`, `a?.b`, `a[b]`, calls, `! - + * / %`,
 * comparisons, `&& || ??`, `? :`, `[…]` and `{…}` — and it reaches only what
 * it is given: the state's own properties (plus `length` of a string or a
 * list), never a prototype (`constructor`, `__proto__`), never a global. A
 * function is callable only when the state hands it over. So a stub — which
 * a package ships, and which a project may publish and edit — can shape
 * text, and cannot run code.
 */

import {
  E_REAM_STUB_EVALUATION,
  E_REAM_STUB_FORBIDDEN_KEY,
  E_REAM_STUB_SYNTAX,
} from '../errors/codes.js'

/** What a template may read. Scalars, lists, nested records, and helpers. */
export type StubValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | StubValue[]
  | { [key: string]: StubValue }
  | StubFunction

/** A helper the state hands to the template — `{{ string.pascalCase(name) }}`. */
export type StubFunction = (...args: StubValue[]) => StubValue

export type StubState = Record<string, StubValue>

/** A custom block — `{{#myBlock key=value }}` calls it with those arguments. */
export type StubBlock = (args: Record<string, StubValue>) => string

export interface TemplateOptions {
  /** Names the template may read even when the state does not carry them. */
  props?: string[]
  /** Custom `{{#name}}` blocks. */
  blocks?: Record<string, StubBlock>
  /** Applied to every `{{ }}`. Identity by default — see the header. */
  escape?: (value: unknown) => string
}

/** HTML escaping, for a stub that does template markup. */
export function escapeHtml(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value)
  return text.replace(/[&"<>]/g, (char) => {
    if (char === '&') return '&amp;'
    if (char === '"') return '&quot;'
    if (char === '<') return '&lt;'
    return '&gt;'
  })
}

/** The default: a source file wants its quotes and its angle brackets back. */
function asIs(value: unknown): string {
  return value === null || value === undefined ? '' : String(value)
}

// ─── Expressions ────────────────────────────────────────────

type Expr =
  | { kind: 'literal'; value: StubValue }
  | { kind: 'name'; name: string }
  | { kind: 'member'; object: Expr; property: Expr; optional: boolean }
  | { kind: 'call'; callee: Expr; args: Expr[]; optional: boolean }
  | { kind: 'unary'; operator: '!' | '-' | '+'; operand: Expr }
  | { kind: 'binary'; operator: string; left: Expr; right: Expr }
  | { kind: 'conditional'; test: Expr; then: Expr; otherwise: Expr }
  | { kind: 'array'; items: Expr[] }
  | { kind: 'object'; entries: Array<{ key: string; value: Expr }> }

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'punct'; value: string }

const PUNCTUATORS = [
  '===',
  '!==',
  '?.',
  '??',
  '&&',
  '||',
  '==',
  '!=',
  '<=',
  '>=',
  '.',
  '[',
  ']',
  '(',
  ')',
  '{',
  '}',
  ',',
  ':',
  '?',
  '!',
  '+',
  '-',
  '*',
  '/',
  '%',
  '<',
  '>',
]

/** Binding power of each binary operator; higher binds tighter. */
const PRECEDENCE: Record<string, number> = {
  '??': 1,
  '||': 2,
  '&&': 3,
  '==': 4,
  '!=': 4,
  '===': 4,
  '!==': 4,
  '<': 5,
  '>': 5,
  '<=': 5,
  '>=': 5,
  '+': 6,
  '-': 6,
  '*': 7,
  '/': 7,
  '%': 7,
}

const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', '0': '\0' }

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let at = 0
  while (at < source.length) {
    const char = source.charAt(at)
    if (/\s/.test(char)) {
      at++
      continue
    }
    if (/[0-9]/.test(char)) {
      const match = /^\d+(?:\.\d+)?/.exec(source.slice(at))
      const text = match?.[0] ?? char
      tokens.push({ kind: 'number', value: Number(text) })
      at += text.length
      continue
    }
    if (/[A-Za-z_$]/.test(char)) {
      const match = /^[A-Za-z_$][\w$]*/.exec(source.slice(at))
      const text = match?.[0] ?? char
      tokens.push({ kind: 'name', value: text })
      at += text.length
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      let value = ''
      let end = at + 1
      for (; end < source.length; end++) {
        const next = source.charAt(end)
        if (next === char) break
        if (char === '`' && next === '$' && source.charAt(end + 1) === '{') {
          throw new E_REAM_STUB_SYNTAX([
            `A template literal cannot interpolate in a stub expression: ${source}`,
          ])
        }
        if (next === '\\') {
          end++
          const escaped = source.charAt(end)
          value += ESCAPES[escaped] ?? escaped
        } else {
          value += next
        }
      }
      if (end >= source.length) throw new E_REAM_STUB_SYNTAX([`Unterminated string in: ${source}`])
      tokens.push({ kind: 'string', value })
      at = end + 1
      continue
    }
    const punct = PUNCTUATORS.find((candidate) => source.startsWith(candidate, at))
    if (punct === undefined) {
      throw new E_REAM_STUB_SYNTAX([`Unexpected "${char}" in: ${source}`])
    }
    tokens.push({ kind: 'punct', value: punct })
    at += punct.length
  }
  return tokens
}

const KEYWORDS: Record<string, StubValue> = {
  true: true,
  false: false,
  null: null,
  undefined: undefined,
}

/** Parse one expression; the whole of `source` must be that expression. */
function parseExpression(source: string): Expr {
  const tokens = tokenize(source)
  let at = 0

  const peek = (): Token | undefined => tokens[at]
  const isPunct = (value: string): boolean => {
    const token = peek()
    return token?.kind === 'punct' && token.value === value
  }
  const expect = (value: string): void => {
    if (!isPunct(value)) {
      const token = peek()
      throw new E_REAM_STUB_SYNTAX([
        `Expected "${value}"${token === undefined ? ' at the end' : ` before "${String(token.value)}"`} in: ${source}`,
      ])
    }
    at++
  }

  const list = (close: string): Expr[] => {
    const items: Expr[] = []
    while (!isPunct(close)) {
      items.push(expression(0))
      if (!isPunct(close)) expect(',')
    }
    expect(close)
    return items
  }

  const primary = (): Expr => {
    const token = peek()
    if (token === undefined) throw new E_REAM_STUB_SYNTAX([`Expression expected in: ${source}`])
    at++
    if (token.kind === 'number' || token.kind === 'string') {
      return { kind: 'literal', value: token.value }
    }
    if (token.kind === 'name') {
      if (token.value in KEYWORDS) return { kind: 'literal', value: KEYWORDS[token.value] }
      return { kind: 'name', name: token.value }
    }
    if (token.value === '(') {
      const inner = expression(0)
      expect(')')
      return inner
    }
    if (token.value === '[') return { kind: 'array', items: list(']') }
    if (token.value === '{') {
      const entries: Array<{ key: string; value: Expr }> = []
      while (!isPunct('}')) {
        const key = peek()
        if (key === undefined || (key.kind !== 'name' && key.kind !== 'string')) {
          throw new E_REAM_STUB_SYNTAX([`An object key is a name or a string, in: ${source}`])
        }
        at++
        let value: Expr = { kind: 'name', name: String(key.value) }
        if (isPunct(':')) {
          at++
          value = expression(0)
        } else if (key.kind !== 'name') {
          throw new E_REAM_STUB_SYNTAX([`Expected ":" after "${key.value}" in: ${source}`])
        }
        entries.push({ key: String(key.value), value })
        if (!isPunct('}')) expect(',')
      }
      expect('}')
      return { kind: 'object', entries }
    }
    if (token.value === '!' || token.value === '-' || token.value === '+') {
      return { kind: 'unary', operator: token.value, operand: unaryOperand() }
    }
    throw new E_REAM_STUB_SYNTAX([`Unexpected "${token.value}" in: ${source}`])
  }

  /** A unary operator applies to a postfix expression, not to a binary one. */
  const unaryOperand = (): Expr => postfix(primary())

  const postfix = (start: Expr): Expr => {
    let node = start
    for (;;) {
      if (isPunct('.') || isPunct('?.')) {
        const optional = isPunct('?.')
        at++
        if (optional && isPunct('(')) {
          at++
          node = { kind: 'call', callee: node, args: list(')'), optional: true }
          continue
        }
        if (optional && isPunct('[')) {
          at++
          const property = expression(0)
          expect(']')
          node = { kind: 'member', object: node, property, optional: true }
          continue
        }
        const name = peek()
        if (name?.kind !== 'name') {
          throw new E_REAM_STUB_SYNTAX([`A property name is expected after "." in: ${source}`])
        }
        at++
        node = {
          kind: 'member',
          object: node,
          property: { kind: 'literal', value: name.value },
          optional,
        }
      } else if (isPunct('[')) {
        at++
        const property = expression(0)
        expect(']')
        node = { kind: 'member', object: node, property, optional: false }
      } else if (isPunct('(')) {
        at++
        node = { kind: 'call', callee: node, args: list(')'), optional: false }
      } else {
        return node
      }
    }
  }

  const expression = (minimum: number): Expr => {
    let left = postfix(primary())
    for (;;) {
      const token = peek()
      if (token?.kind !== 'punct') break
      if (token.value === '?' && minimum === 0) {
        at++
        const then = expression(0)
        expect(':')
        const otherwise = expression(0)
        left = { kind: 'conditional', test: left, then, otherwise }
        continue
      }
      const power = PRECEDENCE[token.value]
      if (power === undefined || power <= minimum) break
      at++
      const right = expression(power)
      left = { kind: 'binary', operator: token.value, left, right }
    }
    return left
  }

  const result = expression(0)
  const rest = peek()
  if (rest !== undefined) {
    throw new E_REAM_STUB_SYNTAX([`Unexpected "${String(rest.value)}" in: ${source}`])
  }
  return result
}

// ─── Evaluation ─────────────────────────────────────────────

/** Never readable, whoever owns them: the way out of a sandbox. */
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype'])

interface Scope {
  readonly state: StubState
  readonly declared: ReadonlySet<string>
  readonly locals: Map<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Read `property` of `object`: its own properties, and a string's or a list's length. */
function readProperty(object: unknown, property: unknown): unknown {
  const key = typeof property === 'number' ? property : String(property)
  if (typeof key === 'string' && FORBIDDEN.has(key)) {
    throw new E_REAM_STUB_FORBIDDEN_KEY([`A stub cannot read "${key}".`])
  }
  if (typeof object === 'string' || Array.isArray(object)) {
    if (key === 'length') return object.length
    if (typeof object === 'string') {
      return typeof key === 'number' || /^\d+$/.test(key) ? object.charAt(Number(key)) : undefined
    }
  }
  if (isRecord(object) || typeof object === 'function') {
    return Object.hasOwn(object, key) ? Reflect.get(object, key) : undefined
  }
  if (object === null || object === undefined) {
    throw new E_REAM_STUB_EVALUATION([`Cannot read "${String(key)}" of ${String(object)}.`])
  }
  return undefined
}

function lookup(name: string, scope: Scope): unknown {
  if (scope.locals.has(name)) return scope.locals.get(name)
  if (scope.declared.has(name)) {
    return Object.hasOwn(scope.state, name) ? scope.state[name] : undefined
  }
  // As before: an undeclared name is the template's mistake, not an empty value.
  throw new E_REAM_STUB_EVALUATION([`${name} is not defined`])
}

function describe(expr: Expr): string {
  if (expr.kind === 'name') return expr.name
  if (expr.kind === 'member' && expr.property.kind === 'literal') {
    return `${describe(expr.object)}.${String(expr.property.value)}`
  }
  return 'the expression'
}

function plus(left: unknown, right: unknown): unknown {
  if (typeof left === 'number' && typeof right === 'number') return left + right
  if (typeof left === 'string' || typeof right === 'string' || isRecord(left) || isRecord(right)) {
    return `${asText(left)}${asText(right)}`
  }
  return Number(left) + Number(right)
}

/** `String()` as `+` does it, so `'a' + null` is `'anull'`, as in JavaScript. */
function asText(value: unknown): string {
  return String(value)
}

/**
 * `==` between data: `null` and `undefined` equal each other and nothing else,
 * and a number, a string or a boolean compare as numbers when their types
 * differ. (Objects compare by identity, as they do with `==`.)
 */
function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  const aMissing = a === null || a === undefined
  const bMissing = b === null || b === undefined
  if (aMissing || bMissing) return aMissing && bMissing
  const scalar = (value: unknown): boolean =>
    typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean'
  if (scalar(a) && scalar(b) && typeof a !== typeof b) return Number(a) === Number(b)
  return false
}

function compare(operator: string, left: unknown, right: unknown): boolean {
  const both = typeof left === 'string' && typeof right === 'string'
  const a = both ? String(left) : Number(left)
  const b = both ? String(right) : Number(right)
  if (operator === '<') return a < b
  if (operator === '>') return a > b
  if (operator === '<=') return a <= b
  return a >= b
}

function binary(operator: string, left: Expr, right: Expr, scope: Scope): unknown {
  if (operator === '&&') {
    const value = evaluate(left, scope)
    return value ? evaluate(right, scope) : value
  }
  if (operator === '||') {
    const value = evaluate(left, scope)
    return value ? value : evaluate(right, scope)
  }
  if (operator === '??') {
    const value = evaluate(left, scope)
    return value === null || value === undefined ? evaluate(right, scope) : value
  }
  const a = evaluate(left, scope)
  const b = evaluate(right, scope)
  switch (operator) {
    case '===':
      return a === b
    case '!==':
      return a !== b
    case '==':
      return looseEqual(a, b)
    case '!=':
      return !looseEqual(a, b)
    case '+':
      return plus(a, b)
    case '-':
      return Number(a) - Number(b)
    case '*':
      return Number(a) * Number(b)
    case '/':
      return Number(a) / Number(b)
    case '%':
      return Number(a) % Number(b)
    default:
      return compare(operator, a, b)
  }
}

function evaluate(expr: Expr, scope: Scope): unknown {
  switch (expr.kind) {
    case 'literal':
      return expr.value
    case 'name':
      return lookup(expr.name, scope)
    case 'member': {
      const object = evaluate(expr.object, scope)
      if (expr.optional && (object === null || object === undefined)) return undefined
      return readProperty(object, evaluate(expr.property, scope))
    }
    case 'call': {
      let self: unknown
      let callee: unknown
      if (expr.callee.kind === 'member') {
        self = evaluate(expr.callee.object, scope)
        if (expr.callee.optional && (self === null || self === undefined)) return undefined
        callee = readProperty(self, evaluate(expr.callee.property, scope))
      } else {
        callee = evaluate(expr.callee, scope)
      }
      if (expr.optional && (callee === null || callee === undefined)) return undefined
      if (typeof callee !== 'function') {
        throw new E_REAM_STUB_EVALUATION([`${describe(expr.callee)} is not a function`])
      }
      return Reflect.apply(
        callee,
        self,
        expr.args.map((arg) => evaluate(arg, scope)),
      )
    }
    case 'unary': {
      const value = evaluate(expr.operand, scope)
      if (expr.operator === '!') return !value
      return expr.operator === '-' ? -Number(value) : Number(value)
    }
    case 'binary':
      return binary(expr.operator, expr.left, expr.right, scope)
    case 'conditional':
      return evaluate(expr.test, scope)
        ? evaluate(expr.then, scope)
        : evaluate(expr.otherwise, scope)
    case 'array':
      return expr.items.map((item) => evaluate(item, scope))
    case 'object': {
      const out: Record<string, unknown> = {}
      for (const entry of expr.entries) {
        if (FORBIDDEN.has(entry.key))
          throw new E_REAM_STUB_FORBIDDEN_KEY([`A stub cannot set "${entry.key}".`])
        out[entry.key] = evaluate(entry.value, scope)
      }
      return out
    }
  }
}

/** What a block receives: the values the template computed, checked to be data. */
function isStubValue(value: unknown): value is StubValue {
  if (value === null || value === undefined) return true
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean' || type === 'function') {
    return true
  }
  if (Array.isArray(value)) return value.every(isStubValue)
  return isRecord(value) && Object.values(value).every(isStubValue)
}

// ─── Templates ──────────────────────────────────────────────

type Node =
  | { kind: 'text'; text: string }
  | { kind: 'output'; expr: Expr }
  | { kind: 'var'; name: string; expr: Expr }
  | { kind: 'if'; branches: Array<{ test: Expr; body: Node[] }>; otherwise?: Node[] }
  | { kind: 'each'; list: Expr; item?: string; index: string; body: Node[] }
  | { kind: 'block'; name: string; args: Array<{ key: string; value: Expr }> }

interface Template {
  readonly nodes: Node[]
  readonly declared: ReadonlySet<string>
}

const CURLY = /{{{?\s*([\s\S]*?)\s*}}}?/g
const BLOCK = /^#\s*(\w[\w\d]*)\s*([\s\S]*)/
const ARGS = /([a-zA-Z$_][^\s=]*)\s*=\s*((["`'])(?:(?=(\\?))\4.)*?\3|{[^}]*}|\[[^\]]*]|\S+)/g
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

function identifier(name: string, where: string): string {
  if (!IDENTIFIER.test(name)) throw new E_REAM_STUB_SYNTAX([`"${name}" is not a name, in ${where}`])
  if (FORBIDDEN.has(name)) throw new E_REAM_STUB_SYNTAX([`"${name}" cannot be bound, in ${where}`])
  return name
}

/** Wrap a parse failure of one tag so the message names the tag. */
function expressionOf(source: string, tag: string): Expr {
  try {
    return parseExpression(source)
  } catch (error) {
    if (error instanceof E_REAM_STUB_SYNTAX) {
      throw new E_REAM_STUB_SYNTAX([`This stub does not compile — ${tag}: ${error.message}`])
    }
    throw error
  }
}

interface Frame {
  readonly kind: 'if' | 'each'
  readonly node: Extract<Node, { kind: 'if' | 'each' }>
  /** Where the tags read now go: the open branch, the else, or the loop body. */
  target: Node[]
}

/** Read a template into its tree, once. */
function parse(input: string, options: TemplateOptions): Template {
  const blocks = options.blocks ?? {}
  const declared = new Set<string>(options.props ?? [])
  const root: Node[] = []
  const stack: Frame[] = []
  const target = (): Node[] => stack.at(-1)?.target ?? root

  const text = (value: string): void => {
    if (value !== '') target().push({ kind: 'text', text: value })
  }

  let last = 0
  CURLY.lastIndex = 0
  let match: RegExpExecArray | null = CURLY.exec(input)
  while (match !== null) {
    text(input.slice(last, match.index))
    last = match.index + match[0].length
    const tag = match[0]
    const inner = (match[1] ?? '').trim()
    const first = inner.charAt(0)

    if (first === '!') {
      // A comment. It leaves no trace in the output.
    } else if (first === '#') {
      const parsed = BLOCK.exec(inner)
      if (parsed === null) throw new E_REAM_STUB_SYNTAX([`Unreadable block: {{${inner}}}`])
      const action = parsed[1] ?? ''
      const rest = (parsed[2] ?? '').trim()
      openBlock(action, rest, tag)
    } else if (first === '/') {
      const closing = inner.slice(1).trim()
      const opened = stack.pop()
      if (opened === undefined) {
        throw new E_REAM_STUB_SYNTAX([`Closed "${closing}" with nothing open.`])
      }
      if (opened.kind !== closing) {
        throw new E_REAM_STUB_SYNTAX([
          `Expected to close "${opened.kind}"; closed "${closing}" instead.`,
        ])
      }
    } else {
      // Both forms interpolate the same way — see the header.
      target().push({ kind: 'output', expr: expressionOf(inner, tag) })
    }
    match = CURLY.exec(input)
  }

  const open = stack.pop()
  if (open !== undefined) throw new E_REAM_STUB_SYNTAX([`Unterminated "${open.kind}" block.`])
  text(input.slice(last))
  return { nodes: root, declared }

  function openBlock(action: string, rest: string, tag: string): void {
    if (action === 'expect') {
      // Names the template reads. Declaring them is what lets an unknown one
      // fail as `x is not defined` rather than as `undefined` in the output.
      for (const key of rest.split(/[\n\r\s\t]*,[\n\r\s\t]*/g)) {
        if (key !== '') declared.add(identifier(key, tag))
      }
      return
    }

    if (action === 'var') {
      const at = rest.indexOf('=')
      if (at === -1) {
        throw new E_REAM_STUB_SYNTAX([`{{#var}} needs an assignment: {{#var ${rest}}}`])
      }
      const name = identifier(rest.slice(0, at).trim(), tag)
      const value = rest
        .slice(at + 1)
        .trim()
        .replace(/;$/, '')
      declared.add(name)
      target().push({ kind: 'var', name, expr: expressionOf(value, tag) })
      return
    }

    if (action === 'each') {
      const at = rest.indexOf(' as ')
      const listSource = at === -1 ? rest : rest.slice(0, at).trim()
      const [item, index = 'i'] =
        at === -1
          ? [undefined, 'i']
          : rest
              .slice(at + 4)
              .trim()
              .replace(/[()\s]/g, '')
              .split(',')
      const node: Extract<Node, { kind: 'each' }> = {
        kind: 'each',
        list: expressionOf(listSource, tag),
        index: identifier(index, tag),
        body: [],
      }
      if (item !== undefined) node.item = identifier(item === '' ? 'item' : item, tag)
      declared.add(node.index)
      if (node.item !== undefined) declared.add(node.item)
      target().push(node)
      stack.push({ kind: 'each', node, target: node.body })
      return
    }

    if (action === 'if') {
      const node: Extract<Node, { kind: 'if' }> = {
        kind: 'if',
        branches: [{ test: expressionOf(rest, tag), body: [] }],
      }
      target().push(node)
      stack.push({ kind: 'if', node, target: node.branches[0]?.body ?? [] })
      return
    }

    if (action === 'elif' || action === 'else') {
      const frame = stack.at(-1)
      if (frame === undefined || frame.node.kind !== 'if' || frame.node.otherwise !== undefined) {
        throw new E_REAM_STUB_SYNTAX([`{{#${action}}} outside an {{#if}}: ${tag}`])
      }
      if (action === 'elif') {
        const branch = { test: expressionOf(rest, tag), body: [] }
        frame.node.branches.push(branch)
        frame.target = branch.body
      } else {
        frame.node.otherwise = []
        frame.target = frame.node.otherwise
      }
      return
    }

    if (Object.hasOwn(blocks, action)) {
      // `{{#note tone="warn" }}` — the arguments become one object.
      const args: Array<{ key: string; value: Expr }> = []
      ARGS.lastIndex = 0
      let found: RegExpExecArray | null = ARGS.exec(rest)
      while (found !== null) {
        args.push({
          key: identifier(found[1] ?? '', tag),
          value: expressionOf(found[2] ?? '', tag),
        })
        found = ARGS.exec(rest)
      }
      ARGS.lastIndex = 0
      target().push({ kind: 'block', name: action, args })
      return
    }

    throw new E_REAM_STUB_SYNTAX([
      `Unknown "${action}" block. Known: expect, var, if, elif, else, each${
        Object.keys(blocks).length > 0 ? `, ${Object.keys(blocks).join(', ')}` : ''
      }.`,
    ])
  }
}

function run(
  nodes: Node[],
  scope: Scope,
  escaper: (value: unknown) => string,
  blocks: Record<string, StubBlock>,
): string {
  let out = ''
  for (const node of nodes) {
    switch (node.kind) {
      case 'text':
        out += node.text
        break
      case 'output':
        out += escaper(evaluate(node.expr, scope))
        break
      case 'var':
        scope.locals.set(node.name, evaluate(node.expr, scope))
        break
      case 'if': {
        const branch = node.branches.find((candidate) => evaluate(candidate.test, scope))
        const body = branch?.body ?? node.otherwise
        if (body !== undefined) out += run(body, scope, escaper, blocks)
        break
      }
      case 'each': {
        const list = evaluate(node.list, scope)
        const items: unknown[] =
          typeof list === 'string' ? [...list] : Array.isArray(list) ? list : []
        if (!Array.isArray(list) && typeof list !== 'string') {
          throw new E_REAM_STUB_EVALUATION([
            `{{#each}} needs a list; got ${list === null ? 'null' : typeof list}.`,
          ])
        }
        for (let index = 0; index < items.length; index++) {
          scope.locals.set(node.index, index)
          if (node.item !== undefined) scope.locals.set(node.item, items[index])
          out += run(node.body, scope, escaper, blocks)
        }
        break
      }
      case 'block': {
        const args: Record<string, StubValue> = {}
        for (const arg of node.args) {
          const value = evaluate(arg.value, scope)
          if (!isStubValue(value)) {
            throw new E_REAM_STUB_EVALUATION([
              `{{#${node.name}}} received a value that is not data: ${arg.key}`,
            ])
          }
          args[arg.key] = value
        }
        const block = blocks[node.name]
        if (block !== undefined) out += block(args)
        break
      }
    }
  }
  return out
}

/** Read a template once into a render function. */
export function compile(
  input: string,
  options: TemplateOptions = {},
): (state: StubState) => string {
  const template = parse(input, options)
  const escaper = options.escape ?? asIs
  const blocks = options.blocks ?? {}
  return (state: StubState) =>
    run(template.nodes, { state, declared: template.declared, locals: new Map() }, escaper, blocks)
}

/** Compile and render in one go. */
export function render(
  input: string,
  state: StubState = {},
  options: TemplateOptions = {},
): string {
  return compile(input, { props: Object.keys(state), ...options })(state)
}
