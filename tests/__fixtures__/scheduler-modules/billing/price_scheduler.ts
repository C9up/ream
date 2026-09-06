/**
 * A scheduled task declared where the folder-structure guide says domain code
 * lives: inside a module. Loaded ONLY if `reamrc.modules.autoload` names this
 * file — which is the point of the tests that use it.
 */

import { Service } from '../../../../src/decorators/Service.js'
import { Schedule } from '../../../../src/scheduler/Schedule.js'

@Service()
export class PriceScheduler {
  @Schedule('*/5 * * * *')
  refreshPrices(): void {}
}
