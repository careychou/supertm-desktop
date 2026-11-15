/** Memory attached to a chat or a working folder: free-text notes plus files (usually shared chat exports). */
export interface Memory { files: string[]; notes: string }

export const emptyMemory = (): Memory => ({ files: [], notes: '' })
export const hasMemory = (m?: Partial<Memory> | null): boolean => !!m && (!!m.files?.length || !!m.notes?.trim())

/** Reads a stored memory column: JSON {files, notes}, or the older JSON array of file paths. */
export function parseMemory(raw?: string | null): Memory {
  if (!raw) return emptyMemory()
  try {
    const v = JSON.parse(raw)
    if (Array.isArray(v)) return { files: v.filter((x) => typeof x === 'string'), notes: '' }
    return { files: Array.isArray(v?.files) ? v.files.filter((x: unknown) => typeof x === 'string') : [], notes: typeof v?.notes === 'string' ? v.notes : '' }
  } catch { return emptyMemory() }
}

/** Stored form; null when empty so the column stays blank. */
export const serializeMemory = (m: Memory): string | null =>
  hasMemory(m) ? JSON.stringify({ files: [...new Set(m.files)], notes: m.notes }) : null
