import type { AppContext } from '../Provider.js'
import { Mail } from './Mail.js'
import type { MailConfig } from './Mail.js'

export default class MailProvider {
  constructor(protected app: AppContext) {}

  register() {
    this.app.container.singleton(Mail, () => {
      const config = this.app.config.get<MailConfig>('mail')
      return new Mail(config ?? {
        default: 'log',
        from: 'noreply@localhost',
        transports: { log: { transport: 'log' } },
      })
    })

    this.app.container.singleton('mail', () => {
      return this.app.container.resolve<Mail>(Mail)
    })
  }

  async boot() {}
  async start() {}
  async ready() {}
  async shutdown() {}
}
