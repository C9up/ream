/**
 * The ream errors, one per code.
 *
 * Each is a flare `Exception`, so an application tests `error.code` or
 * `error instanceof errors.E_…` (the `errors` bag of `@c9up/ream`), and the
 * HTTP exception handler reads its `status`. Where an error says how to fix
 * it, the advice is on `help`.
 */
import { createError, Exception } from '@c9up/flare'

export {
  E_HTTP_CLIENT_INVALID_URL,
  E_HTTP_CLIENT_PRIVATE_ADDRESS,
  E_HTTP_CLIENT_REDIRECT_REFUSED,
  E_HTTP_CLIENT_TIMED_OUT,
  E_HTTP_CLIENT_TOO_LARGE,
  E_HTTP_CLIENT_UNREACHABLE,
} from '../http-client/errors.js'

/** `app.setMode()` or `app.setEnvironment()` was called after the application booted. */
export const E_APP_ALREADY_BOOTED = createError<[string]>('%s', 'E_APP_ALREADY_BOOTED')

/** A lazily imported module (`app.importDefault()`, a lazy listener, a route's lazy controller) has no default export. */
export const E_APP_MISSING_DEFAULT_EXPORT = createError<[string]>(
  '%s',
  'E_APP_MISSING_DEFAULT_EXPORT',
)

/** `app.makePath()` (or another path helper) on an application with no root. */
export const E_APP_ROOT_NOT_SET = createError(
  'Application.makePath: app root is not set — construct the Ignitor with `new Ignitor(new URL("../", import.meta.url))`.',
  'E_APP_ROOT_NOT_SET',
)

/** `base64.decode()` or `base64.urlDecode()` in strict mode met a malformed value. */
export const E_BASE64_MALFORMED = createError<[string]>('%s', 'E_BASE64_MALFORMED')

/** The body parser config uses an option that is no longer supported. */
export const E_BODYPARSER_CONFIG = createError<[string]>('%s', 'E_BODYPARSER_CONFIG')

/** A body size limit is neither a number of bytes nor a size such as `'1mb'`. */
export const E_BODYPARSER_INVALID_SIZE = createError<[string]>(
  "Cannot read the size %s: expected a number of bytes or a value such as '512kb', '1.5mb' or '2 gb'.",
  'E_BODYPARSER_INVALID_SIZE',
)

/** A codemod needs `reamrc.ts`, `start/kernel.ts` or `start/env.ts` and the file does not exist. */
export const E_CODEMODS_FILE_NOT_FOUND = createError<[string]>('%s', 'E_CODEMODS_FILE_NOT_FOUND')

/** `defineEnvValidations()` was given a comment over one line, or a rule that is not one complete expression. */
export const E_CODEMODS_INVALID_ENV_VALIDATION = createError<[string]>(
  '%s',
  'E_CODEMODS_INVALID_ENV_VALIDATION',
)

/** An environment variable name is not an identifier, or its value holds a line break. */
export const E_CODEMODS_INVALID_ENV_VARIABLE = createError<[string]>(
  '%s',
  'E_CODEMODS_INVALID_ENV_VARIABLE',
)

/** A codemod option is out of range: a middleware `position` or `tier`, a preload environment. */
export const E_CODEMODS_INVALID_OPTION = createError<[string]>('%s', 'E_CODEMODS_INVALID_OPTION')

/** A middleware is already registered in the other tier of `start/kernel.ts`. */
export const E_CODEMODS_MIDDLEWARE_CONFLICT = createError<[string, string, string]>(
  '[configure] middleware %s is already registered in %s tier — cannot also register in %s tier. Choose one tier or remove the existing registration.',
  'E_CODEMODS_MIDDLEWARE_CONFLICT',
)

/** A codemod could not find what it edits in the file (`providers: [`, `defineConfig({ ... })`, `router.use([`, `Env.create(...)`…). Make the change by hand. */
export const E_CODEMODS_UNRECOGNIZED_SOURCE = createError<[string]>(
  '%s',
  'E_CODEMODS_UNRECOGNIZED_SOURCE',
)

/** A codemod was asked to write outside the project: an absolute path, `..`, a symlink that resolves outside, or an unsafe module path. */
export const E_CODEMODS_UNSAFE_PATH = createError<[string]>('%s', 'E_CODEMODS_UNSAFE_PATH')

/** A command used the application without declaring `startApp: true` in its options. */
export const E_CONSOLE_APP_NOT_STARTED = createError<[string]>(
  '"%s" accessed this.app without booting the application.',
  'E_CONSOLE_APP_NOT_STARTED',
)

/** An assertion on a command run in a test failed (`assertSucceeded()`, `assertLog()`, `assertTableRows()`…). */
export const E_CONSOLE_ASSERTION_FAILED = createError<[string]>('%s', 'E_CONSOLE_ASSERTION_FAILED')

/** No command has this name. */
export const E_CONSOLE_COMMAND_NOT_FOUND = createError<[string]>(
  '%s',
  'E_CONSOLE_COMMAND_NOT_FOUND',
)

/** Two commands claim the same name. */
export const E_CONSOLE_DUPLICATE_COMMAND = createError<[string]>(
  'Two commands claim the name "%s".',
  'E_CONSOLE_DUPLICATE_COMMAND',
)

/** A choice prompt was asked with no options. */
export const E_CONSOLE_EMPTY_CHOICES = createError<[string]>(
  '"%s" was asked with no options.',
  'E_CONSOLE_EMPTY_CHOICES',
)

/** A command alias expands to nothing. */
export const E_CONSOLE_INVALID_ALIAS = Object.assign(
  createError<[string]>('Alias "%s" expands to nothing.', 'E_CONSOLE_INVALID_ALIAS'),
  { help: 'Expected a command name, e.g. "make:controller --resource".' },
)

/** A command declares its arguments in an order that cannot be parsed: an argument after a spread one, or a required one after an optional one. */
export const E_CONSOLE_INVALID_ARGUMENT = createError<[string]>('%s', 'E_CONSOLE_INVALID_ARGUMENT')

/** An entry of `reamrc.ts` `commands` is neither a command loader nor a default-exported command class. */
export const E_CONSOLE_INVALID_COMMAND = createError<[string]>('%s', 'E_CONSOLE_INVALID_COMMAND')

/** A command loader exported metadata that does not describe a command. */
export const E_CONSOLE_INVALID_COMMAND_METADATA = createError<[string, string]>(
  'Invalid command metadata exported from %s: %s.',
  'E_CONSOLE_INVALID_COMMAND_METADATA',
)

/** Short flags were grouped (`-abc`) with one that cannot be grouped. */
export const E_CONSOLE_INVALID_FLAG_GROUP = createError<[string, string, string]>(
  'Cannot group "-%s" with other flags%s — "--%s" expects a value.',
  'E_CONSOLE_INVALID_FLAG_GROUP',
)

/** A flag value of the wrong type. */
export const E_CONSOLE_INVALID_FLAG_VALUE = createError<[string]>(
  '%s',
  'E_CONSOLE_INVALID_FLAG_VALUE',
)

/** A scripted answer (a prompt trap in a test) was rejected by the prompt's own validation. */
export const E_CONSOLE_INVALID_TRAP_VALUE = Object.assign(
  createError<[string]>(
    'A scripted answer was rejected by its own validation: %s',
    'E_CONSOLE_INVALID_TRAP_VALUE',
  ),
  { help: 'The trap supplies a value the real prompt would refuse — fix the test.' },
)

/** The kernel has finished; it cannot run another command line. */
export const E_CONSOLE_KERNEL_COMPLETED = createError<[string]>('%s', 'E_CONSOLE_KERNEL_COMPLETED')

/** A command is already running through this kernel. */
export const E_CONSOLE_KERNEL_RUNNING = Object.assign(
  createError('A command is already running through this kernel.', 'E_CONSOLE_KERNEL_RUNNING'),
  { help: 'One kernel drives one command line. Use exec() to call another command.' },
)

/** A global flag was declared after the kernel started. */
export const E_CONSOLE_LATE_GLOBAL_FLAG = Object.assign(
  createError<[string, string]>(
    'Global flag "--%s" was declared while the kernel was "%s".',
    'E_CONSOLE_LATE_GLOBAL_FLAG',
  ),
  { help: 'Declare global flags while wiring the kernel, before booting it.' },
)

/** A command loader was added after the kernel started. */
export const E_CONSOLE_LATE_LOADER = Object.assign(
  createError<[string]>(
    'A command loader was added while the kernel was "%s".',
    'E_CONSOLE_LATE_LOADER',
  ),
  { help: 'Add loaders before booting the kernel.' },
)

/** A required argument was not given. */
export const E_CONSOLE_MISSING_ARGUMENT = createError<[string, string]>(
  'Missing required argument "%s"%s.',
  'E_CONSOLE_MISSING_ARGUMENT',
)

/** An argument was given with no value. */
export const E_CONSOLE_MISSING_ARGUMENT_VALUE = createError<[string, string]>(
  'Missing value for argument "%s"%s.',
  'E_CONSOLE_MISSING_ARGUMENT_VALUE',
)

/** A required flag was not given. */
export const E_CONSOLE_MISSING_FLAG = createError<[string, string]>(
  'Missing required flag "--%s"%s.',
  'E_CONSOLE_MISSING_FLAG',
)

/** A flag that takes a value was given without one. */
export const E_CONSOLE_MISSING_FLAG_VALUE = createError<[string]>(
  '%s',
  'E_CONSOLE_MISSING_FLAG_VALUE',
)

/** A console application method was called before the commands were loaded. */
export const E_CONSOLE_NOT_BOOTED = Object.assign(
  createError<[string]>(
    'consoleApp.%s() was called before the commands were loaded.',
    'E_CONSOLE_NOT_BOOTED',
  ),
  { help: 'Await consoleApp.boot() first — consoleApp.exec() does it for you.' },
)

/** A command asked a question while stdin is not interactive. Pass the value as a flag. */
export const E_CONSOLE_NOT_INTERACTIVE = createError<[string]>(
  'Cannot prompt for "%s" — stdin is not interactive.',
  'E_CONSOLE_NOT_INTERACTIVE',
)

/** A command needs the application and the kernel has none. Dispatch through the Ignitor's console kernel. */
export const E_CONSOLE_NO_APP = Object.assign(
  createError<[string]>(
    '"%s" requires a booted application, but this kernel was created without one.',
    'E_CONSOLE_NO_APP',
  ),
  { help: 'Dispatch through the Ignitor console kernel rather than a bare Kernel instance.' },
)

/** The user cancelled a prompt. */
export const E_CONSOLE_PROMPT_CANCELLED = Object.assign(
  createError<[string]>('"%s" was cancelled.', 'E_CONSOLE_PROMPT_CANCELLED'),
  { help: 'Answer the prompt, or pass the value as a flag.' },
)

/** A prompt trap chose an option that was not offered. */
export const E_CONSOLE_TRAP_OUT_OF_RANGE = createError<[string, string]>(
  'A trap chose option %s, but only %s were offered.',
  'E_CONSOLE_TRAP_OUT_OF_RANGE',
)

/** More arguments than the command declares. */
export const E_CONSOLE_UNEXPECTED_ARGUMENT = createError<[string, string, string]>(
  'Unexpected argument%s %s%s.',
  'E_CONSOLE_UNEXPECTED_ARGUMENT',
)

/** A flag the command does not declare. */
export const E_CONSOLE_UNKNOWN_FLAG = createError<[string, string]>(
  'Unknown flag "%s"%s.',
  'E_CONSOLE_UNKNOWN_FLAG',
)

/** `@Service()` or `@inject()` was put on something that is not a class (or, for `@inject()`, one of its methods). */
export const E_CONTAINER_INVALID_DECORATOR_TARGET = createError<[string]>(
  '%s',
  'E_CONTAINER_INVALID_DECORATOR_TARGET',
)

/** `container.call()` named a member of the instance that is not a method. */
export const E_CONTAINER_METHOD_NOT_CALLABLE = createError<[string]>(
  "Container.call: '%s' is not a callable method",
  'E_CONTAINER_METHOD_NOT_CALLABLE',
)

/** `container.when(...).provide()` was called before `asksFor()`: the contextual binding does not say which dependency it replaces. */
export const E_CONTAINER_MISSING_ASKS_FOR = createError(
  'Container.when(): call asksFor(binding) before provide() — a contextual binding needs to know which dependency it replaces.',
  'E_CONTAINER_MISSING_ASKS_FOR',
)

/** A class declares constructor parameters but the container finds no dependency metadata for them. Enable decorator metadata, annotate the parameters with `@inject()`, or declare `static containerInjections`. */
export const E_CONTAINER_MISSING_METADATA = Object.assign(
  createError<[string, string]>(
    'Cannot auto-construct %s: it declares %s constructor parameter(s) but no dependency metadata was found.',
    'E_CONTAINER_MISSING_METADATA',
  ),
  {
    help: 'Enable decorator metadata (swc/tsc emitDecoratorMetadata), annotate constructor params with @Inject(token), or declare static containerInjections.',
  },
)

/** No binding found for the requested token. Includes "did you mean?" suggestions for typos. Register it with `container.singleton()` or decorate the class with `@inject()`. */
export const E_CONTAINER_NOT_FOUND = createError<[string, string]>(
  "No binding found for '%s'.%s",
  'E_CONTAINER_NOT_FOUND',
)

/** The token name reads as an `Object.prototype` key (`constructor`, `__proto__`…). Pick another name. */
export const E_CONTAINER_RESERVED_TOKEN = createError<[string]>(
  "Reserved container token name '%s'.",
  'E_CONTAINER_RESERVED_TOKEN',
)

/** The controller a route names has no such method. Answered with 500. */
export const E_CONTROLLER_METHOD_NOT_FOUND = createError<[string, string]>(
  "Controller method '%s' not found on %s",
  'E_CONTROLLER_METHOD_NOT_FOUND',
)

/** A native crypto call (`hmacSign()`, `randomHex()`…) failed in the engine. */
export const E_CRYPTO_FAILED = createError<[string]>('%s', 'E_CRYPTO_FAILED')

/** Two routes declare the same method and path. */
export const E_DUPLICATE_ROUTE = createError<[string, string]>(
  'Duplicate route found. "%s: %s" route already exists.',
  'E_DUPLICATE_ROUTE',
)

/** Two routes carry the same name. */
export const E_DUPLICATE_ROUTE_NAME = createError<[string, string, string, string, string]>(
  'A route with name "%s" already exists (%s %s); %s %s reuses it. It may happen when two routes share a controller — give each an explicit name.',
  'E_DUPLICATE_ROUTE_NAME',
)

/** `.guard()`, `.role()` or `.permission()` was called with nothing, a group, an RPC group or a GraphQL resolver was given an empty `guards`, `roles` or `permissions` list, or a controller action's `@Role()`, `@Permission()` or `@Guard()` names nothing. An empty requirement would protect nothing. */
export const E_EMPTY_GATE_REQUIREMENT = Object.assign(
  createError<[string, string]>(
    '%s: %s names nothing to require, so it would leave what it is meant to protect open to every request.',
    'E_EMPTY_GATE_REQUIREMENT',
  ),
  {
    help: "Name at least one guard, role or permission — `.guard('jwt')`, `.role('admin')` — or remove the call. A list read from configuration must not be empty.",
  },
)

/** `ENV_PATH` names a directory that holds none of the `.env` files. */
export const E_ENV_PATH_NO_FILE = createError<[string, string]>(
  'ENV_PATH points at %s, which holds none of %s',
  'E_ENV_PATH_NO_FILE',
)

/** An event assertion failed (`assertEmitted()`, `assertNotEmitted()`, on the helpers or the `FakeBus`). */
export const E_EVENTS_ASSERTION_FAILED = createError<[string]>('%s', 'E_EVENTS_ASSERTION_FAILED')

/** The native event bus failed: its task panicked or was cancelled, or an event would not serialize. */
export const E_EVENTS_BUS_FAILED = createError<[string]>(
  'The native event bus failed: %s',
  'E_EVENTS_BUS_FAILED',
)

/** `FakeBus.onRequest()` was given a second handler for the same name. */
export const E_EVENTS_DUPLICATE_REQUEST_HANDLER = createError<[string]>(
  'FakeBus.onRequest: a handler is already registered for "%s". Call reset() between registrations.',
  'E_EVENTS_DUPLICATE_REQUEST_HANDLER',
)

/** A request handler panicked, or refused the request with an error of its own. */
export const E_EVENTS_HANDLER_FAILED = createError<[string]>('%s', 'E_EVENTS_HANDLER_FAILED')

/** `onAny()` without a listener, or `waitForChain()` with no event names. */
export const E_EVENTS_INVALID_ARGUMENT = createError<[string]>('%s', 'E_EVENTS_INVALID_ARGUMENT')

/** A listener class has no method of the name the listener was registered with. */
export const E_EVENTS_MISSING_LISTENER_METHOD = createError<[string, string]>(
  'Missing method "%s" on listener %s',
  'E_EVENTS_MISSING_LISTENER_METHOD',
)

/** `emitter.request()` (or `FakeBus.request()`) named a request no handler answers. */
export const E_EVENTS_NO_REQUEST_HANDLER = createError<[string]>(
  'no request handler registered for "%s"',
  'E_EVENTS_NO_REQUEST_HANDLER',
)

/** An awaited event, event chain or fake request reply did not arrive within its timeout. */
export const E_EVENTS_TIMEOUT = createError<[string]>('%s', 'E_EVENTS_TIMEOUT')

/** `config/events.ts` holds an option nothing reads (`retries` included), or is not an object. */
export const E_EVENTS_UNSUPPORTED_OPTION = createError<[string]>(
  '%s',
  'E_EVENTS_UNSUPPORTED_OPTION',
)

/** `config/events.ts` names a `store` other than `'memory'`, the only one this build has. */
export const E_EVENTS_UNSUPPORTED_STORE = Object.assign(
  createError<[string]>(
    "config/events.ts: store '%s' is not available",
    'E_EVENTS_UNSUPPORTED_STORE',
  ),
  { help: "Only the in-memory store exists in this build; use store: 'memory'." },
)

/** A GraphQL resolver returned a value its field's declared type cannot hold: an object under a `String`, something that is not a list under `[Task]`, a value of an interface or union whose object type is not known. */
export const E_GRAPHQL_INVALID_RESULT = createError<[string]>('%s', 'E_GRAPHQL_INVALID_RESULT', 500)

/** The GraphQL schema (SDL) does not parse, or names a type it does not declare, so the fields its types declare cannot be read. */
export const E_GRAPHQL_INVALID_SCHEMA = createError<[string]>(
  'The GraphQL schema could not be read: %s',
  'E_GRAPHQL_INVALID_SCHEMA',
)

/** The GraphQL provider was registered twice on the same container. */
export const E_GRAPHQL_PROVIDER_ALREADY_REGISTERED = Object.assign(
  createError(
    "Container token 'graphql' is already bound to a different instance",
    'E_GRAPHQL_PROVIDER_ALREADY_REGISTERED',
  ),
  {
    help: 'Only one GraphQLProvider can own the graphql binding. Remove the duplicate provider from your reamrc.ts.',
  },
)

/** The GraphQL `schemaPath` names a file that does not exist. */
export const E_GRAPHQL_SCHEMA_NOT_FOUND = createError<[string]>(
  'GraphQL schema not found: %s',
  'E_GRAPHQL_SCHEMA_NOT_FOUND',
)

/** The native GraphQL parser could not serialize its result. */
export const E_GRAPHQL_SERIALIZE_FAILED = createError<[string]>('%s', 'E_GRAPHQL_SERIALIZE_FAILED')

/** A memory health check threshold is not a byte size, or not a percentage between 0 and 100. */
export const E_HEALTH_INVALID_THRESHOLD = createError<[string]>('%s', 'E_HEALTH_INVALID_THRESHOLD')

/** `HttpContext.getOrFail()` was called outside a request, or with ambient-context tracking turned off. Pass `ctx` explicitly. */
export const E_HTTP_CONTEXT_NOT_FOUND = createError<[string]>('%s', 'E_HTTP_CONTEXT_NOT_FOUND')

/** `warmUp()` was called while the application was already past that phase. */
export const E_IGNITOR_ALREADY_STARTED = createError<[string]>('%s', 'E_IGNITOR_ALREADY_STARTED')

/** A gRPC handler is registered, but this server cannot serve gRPC. */
export const E_IGNITOR_GRPC_UNSUPPORTED = Object.assign(
  createError(
    'A gRPC handler is registered, but this server cannot serve gRPC.',
    'E_IGNITOR_GRPC_UNSUPPORTED',
  ),
  { help: 'Use the native HyperServer, or a test server that implements onGrpc().' },
)

/** An `http.<key>` limit is not a whole number in range. */
export const E_IGNITOR_INVALID_HTTP_CONFIG = createError<[string]>(
  '%s',
  'E_IGNITOR_INVALID_HTTP_CONFIG',
)

/** `PORT` is not an integer between 0 and 65535. */
export const E_IGNITOR_INVALID_PORT = Object.assign(
  createError<[string]>(
    "PORT must be an integer between 0 and 65535, received '%s'.",
    'E_IGNITOR_INVALID_PORT',
  ),
  { help: 'Set PORT in .env, or pass { port } to the Ignitor.' },
)

/** `httpServer()` was called with no `serverFactory` in the config. */
export const E_IGNITOR_NO_SERVER_FACTORY = Object.assign(
  createError('httpServer() requires a serverFactory in config', 'E_IGNITOR_NO_SERVER_FACTORY'),
  { help: 'Example: new Ignitor({ serverFactory: (port, host) => new HyperServer(port, host) })' },
)

/** An application assembled with `warmUp()` was started. Build a fresh Ignitor to run one. */
export const E_IGNITOR_WARMUP_ONLY = Object.assign(
  createError<[string]>(
    "Cannot start an application assembled in '%s' mode.",
    'E_IGNITOR_WARMUP_ONLY',
  ),
  { help: 'warmUp() is for inspecting an application; build a fresh Ignitor to run one.' },
)

/** A route handler string is not of the form `'Controller.method'`. */
export const E_INVALID_CONTROLLER_REFERENCE = createError<[string]>(
  'Invalid controller reference "%s" — expected the form "ControllerName.method".',
  'E_INVALID_CONTROLLER_REFERENCE',
)

/** A duration (a session age, a cookie `maxAge`, a signed URL expiry…) is neither a number nor a string such as `'30m'`. */
export const E_INVALID_DURATION = createError<[string]>('%s', 'E_INVALID_DURATION')

/** `router.resource()` was given an empty name. */
export const E_INVALID_RESOURCE_NAME = createError<[string]>(
  'Invalid resource name "%s"',
  'E_INVALID_RESOURCE_NAME',
)

/** A route domain has a parameter without a name, or the same parameter twice. */
export const E_INVALID_ROUTE_DOMAIN = createError<[string, string]>(
  'The route domain "%s" has %s.',
  'E_INVALID_ROUTE_DOMAIN',
)

/** A native WebSocket limit of 0 bytes. */
export const E_INVALID_WEBSOCKET_CONFIG = createError<[string]>('%s', 'E_INVALID_WEBSOCKET_CONFIG')

/** A middleware entry with no declared parameters was read as a lazy import, and it did not resolve to a module with a default export. */
export const E_MIDDLEWARE_ENTRY = createError(
  'A middleware entry with no declared parameters was treated as a lazy import, but it did not resolve to a module with a default export. If this is an inline middleware (e.g. `handle.bind(this)` or `(...args) => …`), register it on the route or group — `router.get(...).use(fn)` — rather than in `router.use([...])`, which takes imports of middleware classes, as AdonisJS does.',
  'E_MIDDLEWARE_ENTRY',
)

/** A route, RPC method or GraphQL resolver names a middleware nothing declared. Declare it with `router.named()` (or `middleware.register()`). An HTTP route's names are checked when the kernel is built, at boot. */
export const E_MIDDLEWARE_NOT_FOUND = createError<[string]>('%s', 'E_MIDDLEWARE_NOT_FOUND')

/** Two providers registered a migration source under the same name. */
export const E_MIGRATION_SOURCE_CONFLICT = createError<[string]>(
  "A migration source named '%s' is already registered. Two providers cannot claim one name — one of them would migrate nothing while the run still reported success.",
  'E_MIGRATION_SOURCE_CONFLICT',
)

/** A named group prefixes a route that has no name of its own. Name every route of a named group. */
export const E_MISSING_ROUTE_NAME = createError<[string, string, string]>(
  'Cannot apply group name "%s": route %s %s has no name. Name every route in a named group (`.as(...)`), or move the unnamed route out of the group.',
  'E_MISSING_ROUTE_NAME',
)

/** A URL was built for a route without one of its required parameters. */
export const E_MISSING_ROUTE_PARAMS = createError<[string, string]>(
  "Cannot generate URL for route '%s': missing params %s",
  'E_MISSING_ROUTE_PARAMS',
)

/** `file.move()` found a file at the destination and `overwrite` is off. */
export const E_MULTIPART_FILE_EXISTS = createError<[string, string]>(
  '"%s" already exists at "%s". Set "overwrite = true" to overwrite it',
  'E_MULTIPART_FILE_EXISTS',
)

/** `file.move()` was given, or derived from the client's file name, a name that is not a plain file name. */
export const E_MULTIPART_UNSAFE_FILE_NAME = createError<[string]>(
  '%s',
  'E_MULTIPART_UNSAFE_FILE_NAME',
)

/** A Rust panic in a native binding, caught at the boundary instead of crashing the process. */
export const E_NATIVE_PANIC = Object.assign(createError<[string]>('%s', 'E_NATIVE_PANIC'), {
  help: 'This is a bug in Ream. Please report it with the stack trace.',
})

/** A JavaScript callback the native binding could not hold (napi refused to wrap it). */
export const E_NATIVE_CALLBACK_FAILED = createError<[string]>('%s', 'E_NATIVE_CALLBACK_FAILED')

/** `router.on(path).render()` was used and no template engine is installed. */
export const E_NO_VIEW_ENGINE = createError<[string, string]>(
  "router.on('%s').render('%s') needs a template engine. Register one (its provider installs `ctx.view`), or seed `ctx.store` with a `view` that has a render() method.",
  'E_NO_VIEW_ENGINE',
)

/** A middleware called `next()` more than once. Each middleware should call `next()` at most once. */
export const E_PIPELINE_DOUBLE_NEXT = Object.assign(
  createError('next() called multiple times', 'E_PIPELINE_DOUBLE_NEXT'),
  {
    help: 'A middleware called next() more than once. Each middleware should call next() at most once.',
  },
)

/** `reamrc.ts` `tests` holds an option that does not exist. */
export const E_REAMRC_UNKNOWN_OPTION = createError<[string]>(
  '`tests` has no option named %s.',
  'E_REAMRC_UNKNOWN_OPTION',
)

/** An invariant inside `@c9up/ream` broke; a bug to report. */
export const E_REAM_INTERNAL = createError<[string]>('%s', 'E_REAM_INTERNAL')

/** No stub at the given path. */
export const E_REAM_STUB_NOT_FOUND = createError<[string]>('%s', 'E_REAM_STUB_NOT_FOUND')

/** A stub declares no destination (no `to:` front-matter line), or an empty one. */
export const E_REAM_STUB_NO_DESTINATION = createError<[string]>('%s', 'E_REAM_STUB_NO_DESTINATION')

/** A stub template has a syntax error. */
export const E_REAM_STUB_SYNTAX = createError<[string]>('%s', 'E_REAM_STUB_SYNTAX')

/** A stub path, or the destination a stub declares, is absolute or leaves its root. */
export const E_REAM_STUB_UNSAFE_PATH = createError<[string]>('%s', 'E_REAM_STUB_UNSAFE_PATH')

/** `redirect().toRoute()` with no route URL resolver wired. */
export const E_REDIRECT_NO_ROUTER = createError(
  'Route URL resolver not configured. Cannot redirect to named route.',
  'E_REDIRECT_NO_ROUTER',
)

/** Cookie options a browser rejects: `sameSite: true`, `SameSite=None` or `partitioned` without `secure`, or an invalid `expires` date. */
export const E_RESPONSE_INVALID_COOKIE = createError<[string]>('%s', 'E_RESPONSE_INVALID_COOKIE')

/** A header name or value carries CR, LF or NUL, which would split the response. */
export const E_RESPONSE_INVALID_HEADER = createError<[string]>(
  "CRLF / NUL byte in header '%s' is not allowed (response-splitting protection).",
  'E_RESPONSE_INVALID_HEADER',
)

/** `response.redirect()` on a response built outside a request. */
export const E_RESPONSE_NO_CONTEXT = createError(
  'redirect() requires an HttpContext. Response was created outside a request handler.',
  'E_RESPONSE_NO_CONTEXT',
)

/** `response.sse()` on a server that has no stream backend. */
export const E_RESPONSE_SSE_UNSUPPORTED = createError(
  '[ream] response.sse() requires a streaming-capable HyperServer host. The current server has no stream backend wired.',
  'E_RESPONSE_SSE_UNSUPPORTED',
)

/** An RPC method name is empty or not a string. */
export const E_RPC_INVALID_METHOD_NAME = createError(
  'An RPC method name must be a non-empty string',
  'E_RPC_INVALID_METHOD_NAME',
)

/** The RPC provider was registered twice on the same container. */
export const E_RPC_PROVIDER_ALREADY_REGISTERED = Object.assign(
  createError(
    "Container token 'rpc' is already bound to a different instance",
    'E_RPC_PROVIDER_ALREADY_REGISTERED',
  ),
  {
    help: 'Only one RpcProvider can own the rpc binding. Remove the duplicate provider from your reamrc.ts.',
  },
)

/** An RPC method takes a reserved name (`rpc.*`). */
export const E_RPC_RESERVED_METHOD_NAME = Object.assign(
  createError<[string]>("'%s' is a reserved RPC method name", 'E_RPC_RESERVED_METHOD_NAME'),
  {
    help: 'JSON-RPC 2.0 reserves names starting with "rpc." for rpc-internal methods; pick another prefix.',
  },
)

/** An RPC route names a controller method that does not exist. */
export const E_RPC_UNKNOWN_CONTROLLER_METHOD = createError<[string]>(
  '%s',
  'E_RPC_UNKNOWN_CONTROLLER_METHOD',
)

/** A call into the native scheduler failed. */
export const E_SCHEDULER_NATIVE_ERROR = Object.assign(
  createError<[string]>('ream-scheduler NAPI call failed: %s', 'E_SCHEDULER_NATIVE_ERROR'),
  { help: 'This is likely a bug in the scheduler. Please file an issue with the stack trace.' },
)

/** An anonymous class declares `@Schedule`; its task names would collide. */
export const E_SCHEDULE_ANONYMOUS_CLASS = Object.assign(
  createError(
    'Anonymous classes cannot declare @Schedule — task names would collide',
    'E_SCHEDULE_ANONYMOUS_CLASS',
  ),
  {
    help: 'Name the class explicitly (e.g. `export class Jobs { ... }`) so task names are unique and debuggable.',
  },
)

/** The quasar connection lacks the commands a scheduler lock sends. */
export const E_SCHEDULE_INCOMPLETE_CONNECTION = createError<[string]>(
  '%s',
  'E_SCHEDULE_INCOMPLETE_CONNECTION',
)

/** `Scheduler.register()` was given something other than a function. */
export const E_SCHEDULE_INVALID_CALLBACK = createError<[string, string]>(
  "Scheduler.register expected a function callback for task '%s', got %s",
  'E_SCHEDULE_INVALID_CALLBACK',
)

/** `errorReporter` is not a function. */
export const E_SCHEDULE_INVALID_ERROR_REPORTER = createError(
  'Scheduler options.errorReporter must be a function',
  'E_SCHEDULE_INVALID_ERROR_REPORTER',
)

/** `eventSink` does not implement `emit(event)`. */
export const E_SCHEDULE_INVALID_EVENT_SINK = createError(
  'Scheduler options.eventSink must implement emit(event)',
  'E_SCHEDULE_INVALID_EVENT_SINK',
)

/** `lockBackend` does not implement `acquire(name, ttlMs)` and `release(name)`. */
export const E_SCHEDULE_INVALID_LOCK_BACKEND = createError(
  'Scheduler options.lockBackend must implement acquire(name, ttlMs) and release(name)',
  'E_SCHEDULE_INVALID_LOCK_BACKEND',
)

/** `defaultLockTtlMs` is not a finite positive number. */
export const E_SCHEDULE_INVALID_LOCK_TTL = createError<[string]>(
  '%s',
  'E_SCHEDULE_INVALID_LOCK_TTL',
)

/** `@Schedule` was put on a static method. */
export const E_SCHEDULE_INVALID_TARGET = createError<[string]>('%s', 'E_SCHEDULE_INVALID_TARGET')

/** `Scheduler.register()` was given an empty task name. */
export const E_SCHEDULE_INVALID_TASK_NAME = createError(
  'Scheduler.register requires a non-empty task name',
  'E_SCHEDULE_INVALID_TASK_NAME',
)

/** A scheduled method is not callable on the instance the container resolved. */
export const E_SCHEDULE_METHOD_NOT_FOUND = createError<[string]>(
  'Scheduled method %s is not callable on resolved instance',
  'E_SCHEDULE_METHOD_NOT_FOUND',
)

/** The scheduler provider was registered twice on the same container. */
export const E_SCHEDULE_PROVIDER_ALREADY_REGISTERED = Object.assign(
  createError(
    "Container token 'scheduler' is already bound to a different instance",
    'E_SCHEDULE_PROVIDER_ALREADY_REGISTERED',
  ),
  {
    help: 'Only one ScheduleProvider can own the scheduler binding. Remove the duplicate provider from your reamrc.ts.',
  },
)

/** The scheduler lock names a quasar connection and `@c9up/quasar` is not installed. */
export const E_SCHEDULE_QUASAR_MISSING = createError<[string]>(
  "Ream: the scheduler lock asks for the '%s' quasar connection, but @c9up/quasar is not installed.\n  pnpm add @c9up/quasar",
  'E_SCHEDULE_QUASAR_MISSING',
)

/** `@Schedule` was put on a symbol-keyed method. */
export const E_SCHEDULE_SYMBOL_METHOD = Object.assign(
  createError<[string]>(
    "@Schedule on symbol-keyed method is not supported on class '%s'",
    'E_SCHEDULE_SYMBOL_METHOD',
  ),
  { help: 'Use a regular named method so the task can be addressed uniquely.' },
)

/** A task did not complete within its `timeoutMs`; it keeps running in the background. */
export const E_SCHEDULE_TASK_TIMEOUT = createError<[string, string]>(
  "Task '%s' did not complete within %s ms (background execution continues)",
  'E_SCHEDULE_TASK_TIMEOUT',
)

/** `runTaskNow()` named a task that is not registered. */
export const E_SCHEDULE_TASK_UNKNOWN = createError<[string]>(
  "runTaskNow called with unknown task name: '%s'",
  'E_SCHEDULE_TASK_UNKNOWN',
)

/** The native HTTP server could not bind its address (the port is taken, or the address is not local). */
export const E_SERVER_BIND_FAILED = createError<[string]>('%s', 'E_SERVER_BIND_FAILED')

/** A second gRPC handler was registered on the server. */
export const E_SERVER_GRPC_ALREADY_SET = Object.assign(
  createError('A gRPC handler is already registered.', 'E_SERVER_GRPC_ALREADY_SET'),
  { help: 'Only one package can serve gRPC on the HTTP port.' },
)

/** A gRPC message size limit is not a whole number of bytes, or `-1` for no limit. */
export const E_SERVER_GRPC_INVALID_LIMIT = createError<[string, string]>(
  '%s must be a whole number of bytes, or -1 for no limit — got %s.',
  'E_SERVER_GRPC_INVALID_LIMIT',
)

/** A body limit handed to the native server is not a byte count or a part count of zero or more. */
export const E_SERVER_INVALID_BODY_LIMIT = createError<[string]>(
  '%s',
  'E_SERVER_INVALID_BODY_LIMIT',
)

/** The native server's bind address is not an IPv4 or IPv6 address, nor `localhost`. */
export const E_SERVER_INVALID_HOST = createError<[string]>('%s', 'E_SERVER_INVALID_HOST')

/** The native server's port is above 65535. */
export const E_SERVER_INVALID_PORT = createError<[string]>('%s', 'E_SERVER_INVALID_PORT')

/** A trusted-proxy entry is not an address, a CIDR range, a netmask range, a named range or `*`. */
export const E_SERVER_INVALID_TRUSTED_PROXY = createError<[string]>(
  '%s',
  'E_SERVER_INVALID_TRUSTED_PROXY',
)

/** A lock of the native server was left poisoned by a panic. */
export const E_SERVER_LOCK_POISONED = Object.assign(
  createError<[string]>('%s', 'E_SERVER_LOCK_POISONED'),
  {
    help: 'This is a bug in Ream. Please report it with the stack trace.',
  },
)

/** The native server's port was read before `listen()`. */
export const E_SERVER_NOT_STARTED = createError('Server not started', 'E_SERVER_NOT_STARTED')

/** The native server was started with no request handler. */
export const E_SERVER_NO_HANDLER = createError(
  'No handler registered. Call onRequest() before listen()',
  'E_SERVER_NO_HANDLER',
)

/** A `@c9up/ream/services/*` accessor, `urlFor()` or `signedUrlFor()` was used before the application booted it. */
export const E_SERVICE_NOT_BOOTED = createError<[string]>('%s', 'E_SERVICE_NOT_BOOTED')

/** Another request kept the session file locked longer than the store waits. */
export const E_SESSION_FILE_LOCKED = createError<[string]>(
  'Session file is locked: %s',
  'E_SESSION_FILE_LOCKED',
)

/** The quasar connection lacks the commands a session store sends. */
export const E_SESSION_INCOMPLETE_CONNECTION = createError<[string]>(
  '%s',
  'E_SESSION_INCOMPLETE_CONNECTION',
)

/** The database session store's `connection` lacks `query()` and `execute()`. */
export const E_SESSION_INVALID_CONNECTION = createError(
  'Database session driver requires a `connection` exposing query() and execute().',
  'E_SESSION_INVALID_CONNECTION',
)

/** `gcProbability` is not a percentage between 0 and 100. */
export const E_SESSION_INVALID_GC_PROBABILITY = createError<[string]>(
  'Session gcProbability must be a percentage between 0 and 100, got %s.',
  'E_SESSION_INVALID_GC_PROBABILITY',
)

/** The session table name is not a plain identifier. */
export const E_SESSION_INVALID_TABLE_NAME = createError<[string]>(
  'Session table name "%s" is not a plain identifier — letters, digits and underscores only.',
  'E_SESSION_INVALID_TABLE_NAME',
)

/** The file session store has no `location`. */
export const E_SESSION_MISSING_LOCATION = createError(
  'File session driver requires a `location`. Set session.location (or stores.<name>.location) to a writable directory.',
  'E_SESSION_MISSING_LOCATION',
)

/** The cookie session store has no secret. */
export const E_SESSION_MISSING_SECRET = createError<[string]>('%s', 'E_SESSION_MISSING_SECRET')

/** A Redis session store names a quasar connection and `@c9up/quasar` is not installed. */
export const E_SESSION_QUASAR_MISSING = createError<[string]>(
  "Ream: the '%s' session store asks for a quasar connection, but @c9up/quasar is not installed.\n  pnpm add @c9up/quasar",
  'E_SESSION_QUASAR_MISSING',
)

/** The template engine is installed but the session tags cannot be registered on it. */
export const E_SESSION_TEMPLATE_ENGINE_UNUSABLE = Object.assign(
  createError<[string]>(
    'The template engine is installed but the session tags cannot be registered: %s',
    'E_SESSION_TEMPLATE_ENGINE_UNUSABLE',
  ),
  {
    help: '`@c9up/inker` must default-export its plugin registrar (`inker.use(plugin)`), whose plugins receive an engine with `registerTag()`.',
  },
)

/** The session config names a driver that does not exist. */
export const E_SESSION_UNKNOWN_DRIVER = createError<[string]>(
  'Unknown session driver: %s',
  'E_SESSION_UNKNOWN_DRIVER',
)

/** The server refused a fresh server-sent event stream id. */
export const E_STREAM_REGISTER = createError<[string]>(
  '[ream] failed to reserve SSE stream id %s — collision in the registry',
  'E_STREAM_REGISTER',
)

/** `withCsrf()` was called with no token and no CSRF cookie set. */
export const E_TEST_CLIENT_MISSING_CSRF_TOKEN = createError<[string, string]>(
  "RequestBuilder: withCsrf() found no '%s' cookie. Set it first via .cookie('%s', token) (extracted from a prior safe GET) or pass the token: withCsrf(token).",
  'E_TEST_CLIENT_MISSING_CSRF_TOKEN',
)

/** `withAuth()` or `asUser()` was used without an `auth` strategy in the client options. */
export const E_TEST_CLIENT_NO_AUTH_STRATEGY = createError(
  'RequestBuilder: `withAuth()` / `asUser()` called but no AuthStrategy was provided via the client `auth` option.',
  'E_TEST_CLIENT_NO_AUTH_STRATEGY',
)

/** The test client's `visit()` needs `routes: router.namedManifest()` in the client options. */
export const E_TEST_CLIENT_NO_ROUTE_MANIFEST = createError(
  'TestClient: visit() needs a named-route manifest. Pass `routes: router.namedManifest()` in the client options.',
  'E_TEST_CLIENT_NO_ROUTE_MANIFEST',
)

/** `loginAs()` with a session guard, and no `sessionSeeder` in the client options. */
export const E_TEST_CLIENT_NO_SESSION_SEEDER = createError(
  'RequestBuilder: `loginAs()` was given a session-based guard, which needs a session to be written before the request. Pass `sessionSeeder` in the client options (it receives the values and returns the session cookie).',
  'E_TEST_CLIENT_NO_SESSION_SEEDER',
)

/** A test client request, or a test WebSocket message, did not arrive within its timeout. */
export const E_TEST_CLIENT_TIMEOUT = createError<[string]>('%s', 'E_TEST_CLIENT_TIMEOUT')

/** `serialize()` named a serializer that is not registered. */
export const E_TEST_CLIENT_UNKNOWN_SERIALIZER = createError<[string]>(
  'RequestBuilder: no serializer registered for "%s" (see RequestBuilder.addSerializer).',
  'E_TEST_CLIENT_UNKNOWN_SERIALIZER',
)

/** `urlFor()`, `findOrFail()` or the test client's `visit()` named a route that does not exist. */
export const E_CANNOT_LOOKUP_ROUTE = createError<[routeIdentifier: string]>(
  'Cannot lookup route "%s"',
  'E_CANNOT_LOOKUP_ROUTE',
  500,
)

/** A route names a controller by string that is not registered. */
export const E_UNREGISTERED_CONTROLLER = createError<[string, string, string, string]>(
  "Route %s %s references controller '%s', which is not registered. Register it with router.controllers({ %s: () => import('...') }).",
  'E_UNREGISTERED_CONTROLLER',
)

/** A route names a validator that is not registered. */
export const E_VALIDATOR_NOT_FOUND = createError<[string]>('%s', 'E_VALIDATOR_NOT_FOUND')

/** A route validator exposes none of `validateResultAsync()`, `validateResult()` or `validate()`. */
export const E_VALIDATOR_UNUSABLE = createError(
  'Route validator exposes none of validateResultAsync(), validateResult() or validate().',
  'E_VALIDATOR_UNUSABLE',
)

/** `socket.close()` with a code a close frame may not carry (RFC 6455 §7.4). */
export const E_WEBSOCKET_CLOSE_CODE = createError<[string]>('%s', 'E_WEBSOCKET_CLOSE_CODE')

/** A close reason over 123 bytes. */
export const E_WEBSOCKET_CLOSE_REASON = createError<[string]>('%s', 'E_WEBSOCKET_CLOSE_REASON')

/** A WebSocket route's handler ran without its socket (called outside the kernel). */
export const E_WEBSOCKET_CONTEXT = createError<[string]>(
  '%s ran without its socket',
  'E_WEBSOCKET_CONTEXT',
)

/** `socket.acceptProtocol()` named a subprotocol the client did not offer. */
export const E_WEBSOCKET_PROTOCOL = createError<[string, string]>(
  "'%s' was not offered by the client (offered: %s)",
  'E_WEBSOCKET_PROTOCOL',
)

/** The native server refused a fresh socket id. */
export const E_WEBSOCKET_REGISTER = createError(
  'the native server refused a fresh socket id',
  'E_WEBSOCKET_REGISTER',
)

/** `app.import()` / `app.importDefault(id)` on an application built without an `importer`. */
export class E_APP_MISSING_IMPORTER extends Exception {
  static override code = 'E_APP_MISSING_IMPORTER'
  static override help =
    'Pass `importer: (filePath) => import(filePath)` to the Ignitor, from a file of the application.'

  /** The module that was asked for. */
  readonly moduleIdentifier: string

  constructor(moduleIdentifier: string) {
    super(
      `Cannot import "${moduleIdentifier}". Register a module importer with the application first.`,
    )
    this.moduleIdentifier = moduleIdentifier
  }
}

/** Circular dependency (or circular alias) detected during resolution. */
export class E_CIRCULAR_DEPENDENCY extends Exception {
  static override code = 'E_CIRCULAR_DEPENDENCY'

  /** The bindings of the cycle, `A -> B -> A`. */
  readonly chain: string

  constructor(kind: 'alias' | 'dependency', chain: string) {
    super(`Circular ${kind} detected: ${chain}`)
    this.chain = chain
    this.help =
      kind === 'alias'
        ? 'An alias chain must end at a real binding — remove one of the aliases.'
        : 'Break the cycle by resolving one dependency lazily inside a method (`await container.make(Dep)`) instead of injecting it in the constructor.'
  }
}

/** A `.env` value `file:<path>` names a file that does not exist. */
export class E_ENV_FILE_NOT_FOUND extends Exception {
  static override code = 'E_ENV_FILE_NOT_FOUND'
  static override help =
    'A `file:` value is read relative to the application root; an absolute path is allowed.'

  /** The variable whose value names the file. */
  readonly key: string
  /** The file that was looked for. */
  readonly path: string

  constructor(key: string, path: string) {
    super(`Cannot process "${key}" env variable. Unable to locate file "${path}"`)
    this.key = key
    this.path = path
  }
}

/** `Env.defineIdentifier()` was given a name already registered. */
export const E_IDENTIFIER_ALREADY_DEFINED = Object.assign(
  createError<[identifier: string]>(
    'The identifier "%s" is already defined',
    'E_IDENTIFIER_ALREADY_DEFINED',
    500,
  ),
  {
    help: 'Use defineIdentifierIfMissing() to register only when the name is free, or removeIdentifier() first.',
  },
)

/** `.env` values reference each other in a loop (`A=$B`, `B=$A`). */
export class E_ENV_CIRCULAR_REFERENCE extends Exception {
  static override code = 'E_ENV_CIRCULAR_REFERENCE'
  static override help = 'Break the loop: one of these variables needs a literal value.'

  /** The variable that references itself. */
  readonly key: string

  constructor(key: string, chain: string) {
    super(`Env variable "${key}" references itself: ${chain}`)
    this.key = key
  }
}

/** A route references a named middleware that is not registered. */
export class E_PIPELINE_UNKNOWN_MIDDLEWARE extends Exception {
  static override code = 'E_PIPELINE_UNKNOWN_MIDDLEWARE'

  /** The middleware name the route uses. */
  readonly middleware: string
  /** The registered names, comma separated. */
  readonly registered: string

  constructor(middleware: string, registered: string) {
    super(`Middleware '${middleware}' is not registered`)
    this.middleware = middleware
    this.registered = registered
    this.help = `Register it with middleware.register('${middleware}', handler) before using it on routes.`
  }
}

/** A response body is over the configured ceiling. */
export class E_RESPONSE_TOO_LARGE extends Exception {
  static override code = 'E_RESPONSE_TOO_LARGE'
  static override help =
    'The body is held whole in memory (and base64-encoded, ~2.3x) because responses are not streamed yet. ' +
    'Raise `maxResponseBytes` in the kernel config, or serve large files with a signed URL from @c9up/archive.'

  /** The size of the body, in bytes. */
  readonly bytes: number
  /** The ceiling it is over, in bytes. */
  readonly ceiling: number

  constructor(bytes: number, ceiling: number) {
    super(
      `Response body is ${Math.round(bytes / 1_048_576)}MB, over the ${Math.round(ceiling / 1_048_576)}MB ceiling.`,
    )
    this.bytes = bytes
    this.ceiling = ceiling
  }
}

/** A scheduled task's cron expression could not be registered. */
export class E_SCHEDULE_INVALID_CRON extends Exception {
  static override code = 'E_SCHEDULE_INVALID_CRON'

  /** The task that could not be registered. */
  readonly task: string
  /** Its cron expression. */
  readonly cronExpr: string

  constructor(task: string, cronExpr: string, reason: string, options?: ErrorOptions) {
    super(`Failed to register scheduled task '${task}': ${reason}`, options)
    this.task = task
    this.cronExpr = cronExpr
  }
}

/**
 * An error raised at a stage of the request pipeline, with the stage it
 * happened at. Its `code` is the code of the error it wraps (the `cause`), or
 * `E_PIPELINE_ERROR` when that one has none.
 */
export class E_PIPELINE_ERROR extends Exception {
  static override code = 'E_PIPELINE_ERROR'

  /** The stage, as `position (name)`: `5/10 (Guard)`. */
  readonly pipelineStage: string
  /** The caller's context, with `stage`, `position` and `nextStage` added. */
  readonly context: Record<string, string>

  constructor(
    message: string,
    options: {
      code?: string
      cause: unknown
      pipelineStage: string
      context: Record<string, string>
      help: string
    },
  ) {
    super(message, { code: options.code, cause: options.cause })
    this.pipelineStage = options.pipelineStage
    this.context = options.context
    this.help = options.help
  }
}

/** Several terminating or shutdown hooks failed; `errors` holds each failure. */
export class E_APP_SHUTDOWN_FAILED extends Exception {
  static override code = 'E_APP_SHUTDOWN_FAILED'

  /** Each failure, in the order the hooks ran (terminating hooks run last-registered first). */
  readonly errors: unknown[]

  constructor(errors: unknown[], message: string) {
    super(message)
    this.errors = errors
  }
}

/**
 * `Env.create()` found environment variables that fail their schema. `help`
 * lists each one, a `- ` line per variable.
 */
export class E_INVALID_ENV_VARIABLES extends Exception {
  static override code = 'E_INVALID_ENV_VARIABLES'
  static override message = 'Validation failed for one or more environment variables'

  /** One line per failed variable. */
  readonly failures: string[]

  constructor(failures: string[]) {
    super()
    this.failures = failures
    this.help = failures.map((failure) => `- ${failure}`).join('\n')
  }
}

/**
 * The test client's WebSocket handshake was refused, or failed. On a refusal,
 * `status` and `body` are the application's answer.
 */
export class E_TEST_CLIENT_WEBSOCKET_REFUSED extends Exception {
  static override code = 'E_TEST_CLIENT_WEBSOCKET_REFUSED'

  /** The body of the refusal, `''` when there was none. */
  readonly body: string

  constructor(path: string, refusal?: { status: number; body: string }) {
    super(
      refusal === undefined
        ? `WebSocket handshake to ${path} failed`
        : `WebSocket handshake refused with ${refusal.status}${refusal.body === '' ? '' : `: ${refusal.body}`}`,
      refusal === undefined ? undefined : { status: refusal.status },
    )
    this.body = refusal?.body ?? ''
  }
}

/** A JSON body is malformed (400), or under `json.strict` is neither an object nor an array (422). */
export class E_BODYPARSER_INVALID_JSON extends Exception {
  static override code = 'E_BODYPARSER_INVALID_JSON'
  static override status = 400

  constructor(message: string, status?: number) {
    super(message, status === undefined ? undefined : { status })
  }
}

/**
 * The request body is compressed with a `Content-Encoding` the body parser
 * cannot read.
 */
export const E_ENCODING_UNSUPPORTED = createError<[encoding: string]>(
  'Unsupported Content-Encoding: %s',
  'E_ENCODING_UNSUPPORTED',
  415,
)

/** A `providers` entry of the rc file has no `file`. */
export const E_MISSING_PROVIDER_FILE = createError<[entry: string]>(
  'Invalid provider entry "%s". Missing file property',
  'E_MISSING_PROVIDER_FILE',
)

/** A `providers` entry of the rc file has a `file` that is not a function. */
export const E_INVALID_PROVIDER = createError<[entry: string]>(
  'Invalid provider entry "%s". The file property must be a function',
  'E_INVALID_PROVIDER',
)

/** A `preloads` entry of the rc file has no `file`. */
export const E_MISSING_PRELOAD_FILE = createError<[entry: string]>(
  'Invalid preload entry "%s". Missing file property',
  'E_MISSING_PRELOAD_FILE',
)

/** A `preloads` entry of the rc file has a `file` that is not a function. */
export const E_INVALID_PRELOAD_FILE = createError<[entry: string]>(
  'Invalid preload entry "%s". The file property must be a function',
  'E_INVALID_PRELOAD_FILE',
)

/** The request body is over the body parser's limit. */
export const E_REQUEST_ENTITY_TOO_LARGE = createError<[string]>(
  '%s',
  'E_REQUEST_ENTITY_TOO_LARGE',
  413,
)

/** An assertion of the test client's response failed. */
export const E_TEST_CLIENT_ASSERTION_FAILED = createError<[string]>(
  '%s',
  'E_TEST_CLIENT_ASSERTION_FAILED',
)

/** A stub template failed while rendering: an unknown name, a property of nothing, a call to what is not a function. */
export const E_REAM_STUB_EVALUATION = createError<[string]>('%s', 'E_REAM_STUB_EVALUATION')

/** A stub template reads or sets a key it may not reach (`constructor`, `__proto__`…). */
export const E_REAM_STUB_FORBIDDEN_KEY = createError<[string]>('%s', 'E_REAM_STUB_FORBIDDEN_KEY')

/** The native scheduler refused a cron expression. */
export const E_SCHEDULER_INVALID_CRON = createError<[string]>('%s', 'E_SCHEDULER_INVALID_CRON')

/** The native scheduler refused a cron expression that never fires. */
export const E_SCHEDULER_CRON_NO_FIRE = createError<[string]>('%s', 'E_SCHEDULER_CRON_NO_FIRE')

/** The native scheduler already has a task of that name. */
export const E_SCHEDULER_DUPLICATE_TASK = createError<[string]>('%s', 'E_SCHEDULER_DUPLICATE_TASK')

/** No prebuilt native binary exists for this platform. */
export const E_REAM_NAPI_UNSUPPORTED_PLATFORM = createError<[string]>(
  'Unsupported platform: %s',
  'E_REAM_NAPI_UNSUPPORTED_PLATFORM',
)

/**
 * A native binary exists but cannot be loaded. The message names the binary
 * and the fix; the load error, which carries paths on the host, is the `cause`.
 */
export const E_REAM_NAPI_LOAD_FAILED = Object.assign(
  createError<[binary: string, file: string, fix: string]>(
    'The %s NAPI binary (%s) failed to load. Fix: %s',
    'E_REAM_NAPI_LOAD_FAILED',
  ),
  {
    help: 'Check that the binary was built for the current platform and Node ABI. Rebuild with `pnpm --filter @c9up/ream build:napi`.',
  },
)

/** A native binary is not found. */
export const E_REAM_NAPI_NOT_FOUND = createError<[string, string]>(
  '%s NAPI binary not found. Expected %s',
  'E_REAM_NAPI_NOT_FOUND',
)
