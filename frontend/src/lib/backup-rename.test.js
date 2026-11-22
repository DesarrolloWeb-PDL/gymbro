import { describe, it, expect } from 'vitest'
import { NAME_RE, backupName } from './webdav.js'
import { BACKUP_JSON, readBackupFile } from './backup-media.js'
import { zipStore } from './zip.js'

/* The backup file name changed with the fork, and nothing a user already stored may become
 * unreachable because of it. Two directions, one rule each:
 *
 *   read  - both prefixes, because every backup written before the rename is still theirs
 *   write - only the new one, or the rename never happens
 *
 * The WebDAV index (webdav.js INDEX_NAME) and the chosen-folder record (mobile.js
 * BACKUP_FOLDER_FILE) are deliberately left alone: they are bookkeeping nobody looks at, and
 * renaming either would orphan a file a server or a phone already has.
 */

const STATE = JSON.stringify({ workouts: [], routines: [] })

describe('discovering a dated backup', () => {
  it('finds one written before the rename', () => {
    expect(NAME_RE.test('opengym-backup-2026-11-05.json')).toBe(true)
  })

  it('finds one written after it', () => {
    expect(NAME_RE.test('gymbro-backup-2026-11-05.json')).toBe(true)
  })

  it('refuses the index, the folder record, a path that climbs, and a date that is not one', () => {
    const nope = [
      'opengym-backups.json', 'gymbro-backups.json', 'gymbro-backup-folder.json',
      '../../etc/passwd', 'gymbro-backup-2026-11.json', 'gymbro-backup-today.json',
      'gymbro-backup-2026-11-05.txt',
    ]
    for (const n of nope) expect(NAME_RE.test(n), n).toBe(false)
  })

  it('names a new backup after the brand', () => {
    expect(backupName(new Date('2026-11-05T12:00:00Z'))).toBe('gymbro-backup-2026-11-05.json')
  })
})

describe('the entry inside the zip', () => {
  it('is named after the brand in a zip this app writes', () => {
    expect(BACKUP_JSON).toBe('gymbro-backup.json')
  })

  it('imports a zip packed before the rename', async () => {
    const zip = await zipStore([{ name: 'opengym-backup.json', blob: new Blob([STATE]) }])
    const { state, files } = await readBackupFile(new File([zip], 'old.zip'))
    expect(state.workouts).toEqual([])
    expect(state.routines).toEqual([])
    expect(files).toEqual([])
  })

  it('imports a zip packed after it', async () => {
    const zip = await zipStore([{ name: BACKUP_JSON, blob: new Blob([STATE]) }])
    const { state } = await readBackupFile(new File([zip], 'new.zip'))
    expect(state.workouts).toEqual([])
  })

  it('still refuses a zip that is not a backup', async () => {
    const zip = await zipStore([{ name: BACKUP_JSON, blob: new Blob(['{"hello":1}']) }])
    await expect(readBackupFile(new File([zip], 'x.zip'))).rejects.toThrow()
  })
})
