/**
 * `JSON.parse` without prototype poisoning — what AdonisJS gets from
 * `safeParse` (`@poppinss/utils/json`, secure-json-parse with
 * `protoAction: 'remove'` and `constructorAction: 'remove'`).
 *
 * `JSON.parse('{"__proto__":{"isAdmin":true}}')` creates an OWN `__proto__`
 * property. Harmless while it stays there, but the first `Object.assign`,
 * spread-into-setter or deep merge that copies it runs the `__proto__` setter
 * and swaps the target's prototype for attacker data. The same goes for a
 * `constructor` object carrying `prototype`, which merge utilities walk into.
 *
 * Both are removed after parsing, in one iterative walk (no recursion, so a
 * deeply nested body cannot overflow the stack). A `constructor` key holding a
 * plain value (`{"constructor":"Ford"}`) is data, and stays.
 *
 * Throws the `SyntaxError` of `JSON.parse` on malformed input.
 */
export function safeJsonParse(text: string): unknown {
  const parsed: unknown = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object') return parsed
  const pending: object[] = [parsed]
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (Object.hasOwn(node, '__proto__')) Reflect.deleteProperty(node, '__proto__')
    const ctor: unknown = Object.hasOwn(node, 'constructor')
      ? Reflect.get(node, 'constructor')
      : undefined
    if (ctor !== null && typeof ctor === 'object' && Object.hasOwn(ctor, 'prototype')) {
      Reflect.deleteProperty(node, 'constructor')
    }
    for (const child of Object.values(node)) {
      if (child !== null && typeof child === 'object') pending.push(child)
    }
  }
  return parsed
}
