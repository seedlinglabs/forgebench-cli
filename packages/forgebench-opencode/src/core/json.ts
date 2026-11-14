export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined

/** Plain JSON copy: drops undefined, functions and class identity before storage or the wire. */
export const toJson = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json
