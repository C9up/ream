import 'reflect-metadata'
import { beforeEach, describe, expect, it } from 'vitest'
import { clearServiceRegistry, getScheduleMetadata, Schedule, Service } from '../../src/index.js'
import { SCHEDULE_METADATA_KEY } from '../../src/scheduler/Schedule.js'

describe('@Schedule decorator', () => {
  beforeEach(() => {
    clearServiceRegistry()
  })

  it('stores a single metadata entry for a decorated method', () => {
    class Jobs {
      @Schedule('0 */5 * * *')
      runCleanup() {}
    }

    const meta = getScheduleMetadata(Jobs)
    expect(meta).toHaveLength(1)
    expect(meta[0]?.cronExpr).toBe('0 */5 * * *')
    expect(meta[0]?.methodName).toBe('runCleanup')
    expect(meta[0]?.target).toBe(Jobs)
  })

  it('accumulates multiple @Schedule decorators on different methods', () => {
    class Jobs {
      @Schedule('0 0 * * *')
      daily() {}

      @Schedule('0 */1 * * *')
      hourly() {}

      @Schedule('*/5 * * * *')
      fiveMinutes() {}
    }

    const meta = getScheduleMetadata(Jobs)
    expect(meta).toHaveLength(3)
    const byMethod = new Map(meta.map((m) => [m.methodName, m.cronExpr]))
    expect(byMethod.get('daily')).toBe('0 0 * * *')
    expect(byMethod.get('hourly')).toBe('0 */1 * * *')
    expect(byMethod.get('fiveMinutes')).toBe('*/5 * * * *')
  })

  it('returns an empty array for a class with no @Schedule decorators', () => {
    @Service()
    class Plain {
      doWork() {}
    }
    expect(getScheduleMetadata(Plain)).toEqual([])
  })

  it('stores metadata via Reflect under the documented symbol key', () => {
    class Jobs {
      @Schedule('0 12 * * *')
      noon() {}
    }

    const raw = Reflect.getMetadata(SCHEDULE_METADATA_KEY, Jobs)
    expect(Array.isArray(raw)).toBe(true)
    expect(raw).toHaveLength(1)
    expect(raw[0].cronExpr).toBe('0 12 * * *')
  })

  it('does not leak metadata across unrelated classes', () => {
    class A {
      @Schedule('0 0 * * *')
      a() {}
    }
    class B {
      b() {}
    }

    expect(getScheduleMetadata(A)).toHaveLength(1)
    expect(getScheduleMetadata(B)).toHaveLength(0)
  })

  it('subclasses do not inherit or mutate parent class @Schedule metadata', () => {
    class Base {
      @Schedule('0 0 * * *')
      baseJob() {}
    }
    class Child extends Base {
      @Schedule('*/5 * * * *')
      childJob() {}
    }

    // Own metadata only: parent keeps 1 entry, child sees 1 entry.
    const baseMeta = getScheduleMetadata(Base)
    const childMeta = getScheduleMetadata(Child)

    expect(baseMeta).toHaveLength(1)
    expect(baseMeta[0]?.methodName).toBe('baseJob')

    expect(childMeta).toHaveLength(1)
    expect(childMeta[0]?.methodName).toBe('childJob')
  })

  it('returns a defensive shallow copy (mutating the result does not affect future reads)', () => {
    class Owner {
      @Schedule('0 0 * * *')
      original() {}
    }
    const first = getScheduleMetadata(Owner)
    first.push({
      cronExpr: 'injected',
      methodName: 'ghost',
      target: Owner,
    })
    const second = getScheduleMetadata(Owner)
    expect(second).toHaveLength(1)
    expect(second[0]?.methodName).toBe('original')
  })

  it('rejects @Schedule on static methods', () => {
    expect(() => {
      // biome-ignore lint/complexity/noStaticOnlyClass: testing static-method decorator rejection requires a class with a static method
      class BadStatic {
        @Schedule('*/5 * * * *')
        static willFail() {}
      }
      expect(BadStatic).toBeDefined()
    }).toThrow(expect.objectContaining({ code: 'E_SCHEDULE_INVALID_TARGET' }))
  })

  it('rejects @Schedule on getters', () => {
    expect(() => {
      class BadGetter {
        @Schedule('*/5 * * * *')
        get notAMethod() {
          return 1
        }
      }
      expect(BadGetter).toBeDefined()
    }).toThrow(expect.objectContaining({ code: 'E_SCHEDULE_INVALID_TARGET' }))
  })
})
