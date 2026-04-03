/**
 * Mail — send emails via pluggable transports.
 *
 * Like AdonisJS Mail:
 *   await mail.send((message) => {
 *     message.to('user@example.com')
 *     message.subject('Welcome')
 *     message.html('<h1>Hello</h1>')
 *   })
 *
 * Transports: SMTP, log (dev), custom.
 * Configured via config/mail.ts.
 */

import { createTransport } from 'node:net'

export interface MailMessage {
  from: string
  to: string[]
  cc: string[]
  bcc: string[]
  replyTo?: string
  subject: string
  html?: string
  text?: string
  attachments: MailAttachment[]
  headers: Record<string, string>
}

export interface MailAttachment {
  filename: string
  content: Buffer | string
  contentType?: string
}

export interface MailTransport {
  send(message: MailMessage): Promise<void>
}

export interface MailConfig {
  default: string
  from: string
  transports: Record<string, { transport: string; [key: string]: unknown }>
}

/**
 * Message builder — fluent API for composing an email.
 */
export class MessageBuilder {
  private msg: MailMessage = {
    from: '',
    to: [],
    cc: [],
    bcc: [],
    subject: '',
    attachments: [],
    headers: {},
  }

  from(address: string): this { this.msg.from = address; return this }
  to(address: string): this { this.msg.to.push(address); return this }
  cc(address: string): this { this.msg.cc.push(address); return this }
  bcc(address: string): this { this.msg.bcc.push(address); return this }
  replyTo(address: string): this { this.msg.replyTo = address; return this }
  subject(text: string): this { this.msg.subject = text; return this }
  html(content: string): this { this.msg.html = content; return this }
  text(content: string): this { this.msg.text = content; return this }

  attach(filename: string, content: Buffer | string, contentType?: string): this {
    this.msg.attachments.push({ filename, content, contentType })
    return this
  }

  header(key: string, value: string): this {
    this.msg.headers[key] = value
    return this
  }

  build(): MailMessage { return this.msg }
}

/**
 * SMTP transport — sends via raw SMTP connection.
 */
export class SmtpTransport implements MailTransport {
  private host: string
  private port: number
  private secure: boolean
  private auth?: { user: string; pass: string }

  constructor(config: Record<string, unknown>) {
    this.host = (config.host as string) ?? 'localhost'
    this.port = (config.port as number) ?? 587
    this.secure = (config.secure as boolean) ?? false
    if (config.user && config.pass) {
      this.auth = { user: config.user as string, pass: config.pass as string }
    }
  }

  async send(message: MailMessage): Promise<void> {
    // Use nodemailer-compatible SMTP via net.createConnection
    const net = await import('node:net')
    const tls = await import('node:tls')

    return new Promise((resolve, reject) => {
      const socket = this.secure
        ? tls.connect({ host: this.host, port: this.port })
        : net.createConnection({ host: this.host, port: this.port })

      let buffer = ''
      const lines: string[] = []

      const sendLine = (line: string) => {
        socket.write(line + '\r\n')
      }

      const buildEmailData = (): string => {
        const parts: string[] = []
        parts.push(`From: ${message.from}`)
        parts.push(`To: ${message.to.join(', ')}`)
        if (message.cc.length) parts.push(`Cc: ${message.cc.join(', ')}`)
        parts.push(`Subject: ${message.subject}`)
        parts.push('MIME-Version: 1.0')
        for (const [k, v] of Object.entries(message.headers)) parts.push(`${k}: ${v}`)

        if (message.html) {
          parts.push('Content-Type: text/html; charset=UTF-8')
          parts.push('')
          parts.push(message.html)
        } else if (message.text) {
          parts.push('Content-Type: text/plain; charset=UTF-8')
          parts.push('')
          parts.push(message.text)
        }
        return parts.join('\r\n')
      }

      let step = 0

      socket.on('data', (data: Buffer) => {
        buffer += data.toString()
        while (buffer.includes('\r\n')) {
          const idx = buffer.indexOf('\r\n')
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)

          if (step === 0 && line.startsWith('220')) {
            sendLine(`EHLO localhost`)
            step = 1
          } else if (step === 1 && (line.startsWith('250') || line.startsWith('220'))) {
            if (this.auth) {
              sendLine(`AUTH LOGIN`)
              step = 10
            } else {
              sendLine(`MAIL FROM:<${message.from}>`)
              step = 2
            }
          } else if (step === 10) {
            sendLine(Buffer.from(this.auth!.user).toString('base64'))
            step = 11
          } else if (step === 11) {
            sendLine(Buffer.from(this.auth!.pass).toString('base64'))
            step = 12
          } else if (step === 12 && line.startsWith('235')) {
            sendLine(`MAIL FROM:<${message.from}>`)
            step = 2
          } else if (step === 2 && line.startsWith('250')) {
            const allRecipients = [...message.to, ...message.cc, ...message.bcc]
            sendLine(`RCPT TO:<${allRecipients[0]}>`)
            lines.push(...allRecipients.slice(1))
            step = 3
          } else if (step === 3 && line.startsWith('250')) {
            if (lines.length > 0) {
              sendLine(`RCPT TO:<${lines.shift()}>`)
            } else {
              sendLine('DATA')
              step = 4
            }
          } else if (step === 4 && line.startsWith('354')) {
            sendLine(buildEmailData())
            sendLine('.')
            step = 5
          } else if (step === 5 && line.startsWith('250')) {
            sendLine('QUIT')
            step = 6
          } else if (step === 6) {
            socket.end()
            resolve()
          } else if (line.startsWith('5') || line.startsWith('4')) {
            socket.end()
            reject(new Error(`SMTP error: ${line}`))
          }
        }
      })

      socket.on('error', reject)
      socket.on('timeout', () => reject(new Error('SMTP connection timeout')))
      socket.setTimeout(30000)
    })
  }
}

/**
 * Log transport — logs emails to console (development).
 */
export class LogTransport implements MailTransport {
  async send(message: MailMessage): Promise<void> {
    console.log(`[MAIL] To: ${message.to.join(', ')} | Subject: ${message.subject}`)
    if (message.text) console.log(`  Body: ${message.text.slice(0, 200)}`)
  }
}

const transportFactories: Record<string, (config: Record<string, unknown>) => MailTransport> = {
  smtp: (config) => new SmtpTransport(config),
  log: () => new LogTransport(),
}

/**
 * Mail manager — send emails via configured transport.
 */
export class Mail {
  private transports: Map<string, MailTransport> = new Map()
  private defaultTransport: string
  private defaultFrom: string

  constructor(config: MailConfig) {
    this.defaultTransport = config.default
    this.defaultFrom = config.from

    for (const [name, transportConfig] of Object.entries(config.transports)) {
      const factory = transportFactories[transportConfig.transport]
      if (factory) {
        this.transports.set(name, factory(transportConfig))
      }
    }
  }

  /** Send an email using the fluent message builder. */
  async send(callback: (message: MessageBuilder) => void, transport?: string): Promise<void> {
    const builder = new MessageBuilder()
    builder.from(this.defaultFrom)
    callback(builder)
    const message = builder.build()

    const t = this.transports.get(transport ?? this.defaultTransport)
    if (!t) throw new Error(`Mail transport '${transport ?? this.defaultTransport}' not configured`)
    await t.send(message)
  }

  /** Get a specific transport. */
  use(name: string): MailTransport {
    const t = this.transports.get(name)
    if (!t) throw new Error(`Mail transport '${name}' not configured`)
    return t
  }
}
