import type { AppContext } from '../Provider.js'
import { Hash } from './Hash.js'
import type { HashConfig } from './Hash.js'

export default class HashProvider {
  constructor(protected app: AppContext) {}

  register() {
    this.app.container.singleton(Hash, () => {
      const config = this.app.config.get<HashConfig>('hash')
      return new Hash(config ?? {
        default: 'scrypt',
        drivers: {
          scrypt: { driver: 'scrypt' },
        },
      })
    })

    this.app.container.singleton('hash', () => {
      return this.app.container.resolve<Hash>(Hash)
    })
  }

  async boot() {}
  async start() {}
  async ready() {}
  async shutdown() {}
}
