/**
 * Config store singleton service.
 *
 * Usage:
 *   import config from '@c9up/ream/services/config'
 *   const port = config.get<number>('app.port', 3333)
 *
 * Unlike the other accessors this one keeps no instance of its own: the store
 * IS `app.config`, so it reads through the app locator. One source of truth
 * means the two can never point at different stores after a re-boot.
 */

import type { ConfigStore } from '../ConfigLoader.js'
import { getApp } from './app.js'
import { createServiceProxy } from './createServiceProxy.js'

const config: ConfigStore = createServiceProxy<ConfigStore>(
  () => getApp()?.config,
  'Config accessed before initialization. ' +
    'The store is built during the boot phase — read it from inside a provider, ' +
    'a preload, or a request, not at module top level.',
)

export default config
