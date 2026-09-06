/**
 * A scheduled task NOTHING in the suite ever imports.
 *
 * That is its whole job: the negative cases assert this class is absent from
 * the registry, and an assertion like that is only worth anything if no other
 * test can have put it there. Using the same fixture for the positive case
 * meant the negatives passed or failed depending on test order.
 */
import { Service } from '../../../../src/decorators/Service.js'
import { Schedule } from '../../../../src/scheduler/Schedule.js'

@Service()
export class InvoiceScheduler {
  @Schedule('*/5 * * * *')
  refreshInvoices(): void {}
}
