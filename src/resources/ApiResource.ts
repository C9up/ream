/**
 * ApiResource — transform entities into API responses.
 *
 * Controls which fields are exposed, how relationships are serialized,
 * and provides pagination metadata.
 *
 * Usage:
 *   class UserResource extends ApiResource<User> {
 *     serialize(user: User) {
 *       return { id: user.id, email: user.email, name: user.name }
 *     }
 *   }
 *
 *   ctx.response.json(new UserResource().item(user))
 *   ctx.response.json(new UserResource().collection(users, { page: 1, perPage: 20, total: 100 }))
 *
 * @implements MISS-23
 */

export interface PaginationMeta {
  page: number
  perPage: number
  total: number
  lastPage: number
  hasMore: boolean
}

export abstract class ApiResource<T> {
  /** Transform a single entity into its API representation. */
  abstract serialize(item: T): Record<string, unknown>

  /** Transform a single item with wrapper. */
  item(entity: T): { data: Record<string, unknown> } {
    return { data: this.serialize(entity) }
  }

  /** Transform a collection with optional pagination. */
  collection(
    entities: T[],
    pagination?: { page: number; perPage: number; total: number },
  ): { data: Record<string, unknown>[]; meta?: PaginationMeta } {
    const data = entities.map((e) => this.serialize(e))

    if (pagination) {
      const lastPage = Math.ceil(pagination.total / pagination.perPage)
      return {
        data,
        meta: {
          page: pagination.page,
          perPage: pagination.perPage,
          total: pagination.total,
          lastPage,
          hasMore: pagination.page < lastPage,
        },
      }
    }

    return { data }
  }

  /** Transform with relationships loaded via a callback. */
  with<R>(
    entity: T,
    relation: string,
    resourceClass: new () => ApiResource<R>,
    related: R | R[] | null,
  ): Record<string, unknown> {
    const base = this.serialize(entity)
    if (related === null) {
      base[relation] = null
    } else if (Array.isArray(related)) {
      const res = new resourceClass()
      base[relation] = related.map((r) => res.serialize(r))
    } else {
      base[relation] = new resourceClass().serialize(related)
    }
    return base
  }
}
