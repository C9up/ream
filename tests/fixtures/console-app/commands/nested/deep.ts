import { BaseCommand } from '../../../../../src/console/BaseCommand.js'

export default class Deep extends BaseCommand {
  static override commandName = 'deep:command'
  static override description = 'Lives in a subdirectory'

  run(): void {}
}
