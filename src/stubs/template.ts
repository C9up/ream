/**
 * The stub template engine.
 *
 * A port of the one upstream uses (tempura), grammar for grammar: comments,
 * declared props, inline variables, conditionals, loops, custom blocks, and
 * the two interpolation forms. A template is compiled into a JavaScript
 * function once and then called — the same design, for the same reason: a
 * tree-walking interpreter re-reads the template on every render, and a stub
 * is rendered in a loop by the generators.
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
 * `new Function` compiles the result. That is how upstream does it too, and
 * the trust boundary is the same: a stub ships inside a package whose
 * `configure` hook is already executing.
 */

/** What a template may read. Scalars, lists and nested records. */
export type StubValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | StubValue[]
  | { [key: string]: StubValue }

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

/** Raised when a template cannot be read, naming what is wrong with it. */
export class StubSyntaxError extends Error {
  readonly code = 'E_REAM_STUB_SYNTAX'
  constructor(message: string) {
    super(message)
    this.name = 'StubSyntaxError'
  }
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

const CURLY = /{{{?\s*([\s\S]*?)\s*}}}?/g
const BLOCK = /^#\s*(\w[\w\d]*)\s*([^]*)/
const ARGS = /([a-zA-Z$_][^\s=]*)\s*=\s*((["`'])(?:(?=(\\?))\4.)*?\3|{[^}]*}|\[[^\]]*]|\S+)/g

/**
 * Compile a template into the body of a function.
 *
 * Kept separate from `compile` so a test can read what a template became —
 * the generated source is the only place a subtle mistake shows itself.
 */
export function generate(input: string, options: TemplateOptions = {}): string {
  const blocks = options.blocks ?? {}
  const declared = new Set<string>(options.props ?? [])
  const stack: string[] = []

  let body = ''
  let literal = ''
  let last = 0
  CURLY.lastIndex = 0

  /** Flush the literal text collected since the last tag. */
  const flush = (): void => {
    if (literal.length > 0) {
      body += `${body ? 'x+=' : '='}\`${literal}\`;`
    } else if (body.length === 0) {
      body = '="";'
    }
    literal = ''
  }

  let match: RegExpExecArray | null = CURLY.exec(input)
  while (match !== null) {
    literal += escapeForTemplate(input.slice(last, match.index))
    last = match.index + match[0].length

    const inner = (match[1] ?? '').trim()
    const first = inner.charAt(0)

    if (first === '!') {
      // A comment. It leaves no trace in the output.
    } else if (first === '#') {
      flush()
      const parsed = BLOCK.exec(inner)
      if (parsed === null) {
        throw new StubSyntaxError(`Unreadable block: {{${inner}}}`)
      }
      const action = parsed[1] ?? ''
      const rest = (parsed[2] ?? '').trim()
      body += openBlock(action, rest, stack, declared, blocks)
    } else if (first === '/') {
      const closing = inner.slice(1).trim()
      const opened = stack.pop()
      flush()
      if (opened === undefined) {
        throw new StubSyntaxError(`Closed "${closing}" with nothing open.`)
      }
      if (opened !== closing) {
        throw new StubSyntaxError(`Expected to close "${opened}"; closed "${closing}" instead.`)
      }
      body += '}'
    } else {
      // Both forms interpolate the same way — see the header.
      literal += `\${$$e(${inner})}`
    }

    match = CURLY.exec(input)
  }

  if (stack.length > 0) {
    throw new StubSyntaxError(`Unterminated "${stack.pop()}" block.`)
  }
  if (last < input.length) {
    literal += escapeForTemplate(input.slice(last))
  }
  flush()

  const bindings = declared.size > 0 ? `{${[...declared].join()}}=$$s,x` : ' x'
  return `var${bindings}${body}return x`
}

function openBlock(
  action: string,
  rest: string,
  stack: string[],
  declared: Set<string>,
  blocks: Record<string, StubBlock>,
): string {
  if (action === 'expect') {
    // Names the template reads. Declaring them is what lets an unknown one
    // fail as `x is not defined` rather than as `undefined` in the output.
    for (const key of rest.split(/[\n\r\s\t]*,[\n\r\s\t]*/g)) {
      if (key !== '') declared.add(key)
    }
    return ''
  }

  if (action === 'var') {
    const at = rest.indexOf('=')
    if (at === -1) {
      throw new StubSyntaxError(`{{#var}} needs an assignment: {{#var ${rest}}}`)
    }
    const name = rest.slice(0, at).trim()
    const value = rest
      .slice(at + 1)
      .trim()
      .replace(/;$/, '')
    return `var ${name}=${value};`
  }

  if (action === 'each') {
    stack.push(action)
    const at = rest.indexOf(' as ')
    if (at === -1) {
      return `for(var i=0,$$a=${rest};i<$$a.length;i++){`
    }
    const list = rest.slice(0, at).trim()
    const [item = 'item', index = 'i'] = rest
      .slice(at + 4)
      .trim()
      .replace(/[()\s]/g, '')
      .split(',')
    return `for(var ${index}=0,${item},$$a=${list};${index}<$$a.length;${index}++){${item}=$$a[${index}];`
  }

  if (action === 'if') {
    stack.push(action)
    return `if(${rest}){`
  }
  if (action === 'elif') return `}else if(${rest}){`
  if (action === 'else') return '}else{'

  if (action in blocks) {
    // `{{#note tone="warn" }}` — the arguments become one object.
    const args: string[] = []
    let found: RegExpExecArray | null = ARGS.exec(rest)
    while (found !== null) {
      args.push(`${found[1]}:${found[2]}`)
      found = ARGS.exec(rest)
    }
    ARGS.lastIndex = 0
    return `x+=$$b.${action}(${args.length > 0 ? `{${args.join()}}` : '{}'});`
  }

  throw new StubSyntaxError(
    `Unknown "${action}" block. Known: expect, var, if, elif, else, each${
      Object.keys(blocks).length > 0 ? `, ${Object.keys(blocks).join(', ')}` : ''
    }.`,
  )
}

/** Protect the literal text from the template literal it is about to live in. */
function escapeForTemplate(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${')
}

/** Compile a template into a render function. */
export function compile(
  input: string,
  options: TemplateOptions = {},
): (state: StubState) => string {
  const source = generate(input, options)
  let render: (escape: (value: unknown) => string, blocks: unknown, state: StubState) => string
  try {
    // eslint-disable-next-line no-new-func -- the whole point of a compiler
    render = new Function('$$e', '$$b', '$$s', source) as typeof render
  } catch (error) {
    throw new StubSyntaxError(
      `This stub does not compile: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const escape = options.escape ?? asIs
  const blocks = options.blocks ?? {}
  return (state: StubState) => render(escape, blocks, state)
}

/** Compile and render in one go. */
export function render(
  input: string,
  state: StubState = {},
  options: TemplateOptions = {},
): string {
  return compile(input, { props: Object.keys(state), ...options })(state)
}
