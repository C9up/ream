import { BaseCommand } from '../../../../src/console/BaseCommand.js'
import { args } from '../../../../src/console/decorators.js'

export default class Greet extends BaseCommand {
  static override commandName = 'greet'
  static override description = 'Greet someone by name'

  @args.string()
  declare name: string

  run(): void {
    this.logger.success(`Hello ${this.name}`)
  }
}
