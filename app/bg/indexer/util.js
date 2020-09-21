import promisePool from 'tiny-promise-pool'
import { timer } from '../../lib/time'
import { joinPath, parseSimplePathSpec } from '../../lib/strings'
import { normalizeOrigin } from '../../lib/urls'
import * as filesystem from '../filesystem/index'
import * as drives from '../hyper/drives'
import { query } from '../filesystem/query'
import { READ_TIMEOUT, READ_DIFF_TIMEOUT } from './const'

// typedefs
// =

/**
 * @typedef {import('./const').Site} Site
 * @typedef {import('./const').ParsedUrl} ParsedUrl
 * @typedef {import('../../lib/session-permissions').EnumeratedSessionPerm} EnumeratedSessionPerm
 */

// exported api
// =

/**
 * @param {Object} db
 * @returns {Promise<Boolean>}
 */
export async function getIsFirstRun (db) {
  var res = await db('sites').select(db.raw(`count(sites.rowid) as count`))
  return !res || !res[0] || !res[0].count
}

/**
 * @param {Object} db
 * @param {String} origin 
 * @returns {Promise<Object[]>}
 */
export async function getIndexState (db, origin) {
  return await db('sites')
    .select('origin', 'last_indexed_version', 'last_indexed_ts')
    .where({origin})
    .andWhere('last_indexed_version', '>', 0)
}

/**
 * @param {Object} db
 * @param {Site} site 
 * @returns {Promise<void>}
 */
export async function updateIndexState (db, site) {
  await db('sites').update({
    last_indexed_version: site.current_version,
    last_indexed_ts: Date.now()
  }).where({origin: site.origin})
}

/**
 * @param {Object} db
 * @param {Site} site 
 * @param {Object} flags
 * @param {Boolean} [flags.is_index_target] - indicates this site is being indexed (subbed, my profile, etc)
 * @param {Boolean} [flags.is_indexed] - indicates this site's index is now ready to be queried
 * @returns {Promise<void>}
 */
export async function setSiteFlags (db, site, flags) {
  var update = {}
  if (typeof flags.is_index_target !== 'undefined') update.is_index_target = flags.is_index_target ? 1 : 0
  if (typeof flags.is_indexed !== 'undefined') update.is_indexed = flags.is_indexed ? 1 : 0
  await db('sites').update(update).where({origin: site.origin})
}

/**
 * @returns {Promise<String[]>}
 */
export async function listMyOrigins () {
  let driveMetas = await filesystem.listDriveMetas()
  return ['hyper://private'].concat(driveMetas.filter(dm => dm.writable).map(dm => normalizeOrigin(dm.url)))
}


/**
 * @param {Object} db
 * @returns {Promise<String[]>}
 */
export async function listOriginsToIndex (db) {
  var fs = filesystem.get()
  var addressBook = await filesystem.getAddressBook()
  var subscriptions = await db('records')
    .select('records_data.value as href')
    .innerJoin('sites', 'records.site_rowid', 'sites.rowid')
    .innerJoin('records_data', function () {
      this.on('records_data.record_rowid', 'records.rowid')
        .andOn('records_data.key', db.raw('?', ['href']))
    })
    .where({
      prefix: '/subscriptions',
      extension: '.goto'
    })
    .whereIn('origin', [
      'hyper://private',
      ...addressBook.profiles.map(item => 'hyper://' + item.key)
    ])
  var origins = new Set([
    'hyper://private',
    ...addressBook.profiles.map(item => 'hyper://' + item.key),
    ...subscriptions.map(sub => normalizeOrigin(sub.href))
  ])
  return Array.from(origins)
}

/**
 * @returns {Promise<String[]>}
 */
export async function listOriginsToCapture () {
  var fs = filesystem.get()
  try {
    var drivesJson = await fs.pda.readFile('/drives.json', 'json')
    return drivesJson.drives.map(item => 'hyper://' + item.key)
  } catch {
    return []
  }
}

/**
 * @param {Object} db
 * @param {String[]} originsToIndex
 * @returns {Promise<String[]>}
 */
export async function listOriginsToDeindex (db, originsToIndex) {
  var indexedSites = await db('sites')
    .select('sites.origin')
    .where('last_indexed_version', '>', 0)
  return indexedSites
    .map(row => normalizeOrigin(row.origin))
    .filter(origin => !originsToIndex.includes(origin))
}

/**
 * @param {Object} db
 * @param {String} origin
 * @param {Object} [opts]
 * @param {Function} [opts.onIsFirstIndex]
 * @returns {Promise<Site>}
 */
export async function loadSite (db, origin, opts) {
  var record = undefined
  origin = normalizeOrigin(origin)
  var res = await db('sites')
    .select('sites.rowid as rowid', 'last_indexed_version', 'last_indexed_ts')
    .where({origin})

  if (typeof opts?.onIsFirstIndex === 'function' && (!res[0] || res[0].last_indexed_version === 0)) {
    opts?.onIsFirstIndex()
  }

  var drive, driveInfo
  await timer(READ_TIMEOUT, async (checkin) => {
    checkin('loading hyperdrive from the network')
    drive = await drives.getOrLoadDrive(origin)
    checkin('reading hyperdrive information from the network')
    driveInfo = await drives.getDriveInfo(origin)
  })

  if (!driveInfo || driveInfo.version === 0) {
    throw new Error('Failed to load hyperdrive from the network')
  }

  if (!res[0]) {
    res = await db('sites').insert({
      origin,
      title: driveInfo.title,
      description: driveInfo.description,
      writable: driveInfo.writable ? 1 : 0
    })
    record = {
      rowid: res[0],
      last_indexed_version: 0,
      last_indexed_ts: undefined,
      is_index_target: false,
      is_indexed: false
    }
  } else {
    record = {
      rowid: res[0].rowid,
      last_indexed_version: res[0].last_indexed_version,
      last_indexed_ts: res[0].last_indexed_ts,
      is_index_target: Boolean(res[0].is_index_target),
      is_indexed: Boolean(res[0].is_indexed)
    }
    /*dont await*/ db('sites').update({
      title: driveInfo.title,
      description: driveInfo.description,
      writable: driveInfo.writable ? 1 : 0
    }).where({origin})
  }

  var site = {
    origin,
    rowid: record.rowid,
    current_version: driveInfo.version,
    last_indexed_version: record.last_indexed_version,
    last_indexed_ts: record.last_indexed_ts,
    is_index_target: record.is_index_target,
    is_indexed: record.is_indexed,
    title: driveInfo.title,
    description: driveInfo.description,
    writable: driveInfo.writable,

    async stat (path) {
      return drive.pda.stat(path)
    },

    async fetch (path) {
      return drive.pda.readFile(path, 'utf8')
    },

    async listUpdates () {
      return timer(READ_DIFF_TIMEOUT, async (checkin) => {
        checkin('fetching recent updates')

        // HACK
        // in certain network conditions, diff() will give partial results without erroring
        // this completely fucks the indexer's state because it believes it got _all_ the data for a version range
        // by calling readdir first, we ensure that the full metadata log is downloaded, avoiding partial results
        // unlike diff(), if the data is not reachable, readdir will fail - which is what we want to happen
        // -prf
        await drive.pda.readdir('/', {recursive: true})

        let changes = await drive.pda.diff(+record.last_indexed_version || 0)
        return changes.filter(change => ['put', 'del'].includes(change.type)).map(change => ({
          path: '/' + change.name,
          remove: change.type === 'del',
          metadata: change?.value?.stat?.metadata,
          ctime: Number(change?.value?.stat?.ctime || 0),
          mtime: Number(change?.value?.stat?.mtime || 0)
        }))
      })
    },

    async listMatchingFiles (pathQuery) {
      if (pathQuery) {
        return query(drive, {path: toArray(pathQuery)})
      }
      let files = await drive.pda.readdir('/', {includeStats: true, recursive: true})
      return files.map(file => ({
        url: joinPath(drive.url, file.name),
        path: '/' + file.name,
        stat: file.stat
      }))
    }
  }
  return site
}

/**
 * @param {Object} opts
 * @param {String|String[]} [opts.path]
 * @param {Object} [permissions]
 * @param {EnumeratedSessionPerm[]} [permissions.query]
 */
export function checkShouldExcludePrivate (opts, permissions) {
  var shouldExcludePrivate = false
  if (permissions?.query) {
    shouldExcludePrivate = true
    // only include private if the query 100% matches permissions
    if (opts?.path) {
      shouldExcludePrivate = false
      for (let path of toArray(opts.path)) {
        let pathSpec = parseSimplePathSpec(path)
        let match = permissions.query.find(perm => (
          perm.prefix === pathSpec.prefix && 
          (!perm.extension || perm.extension === pathSpec.extension)
        ))
        if (!match) {
          shouldExcludePrivate = true
          break
        }
      }
    }
  }
  return shouldExcludePrivate
}

/**
 * @param {String} url
 * @param {String} [base]
 * @returns {ParsedUrl}
 */
export function parseUrl (url, base = undefined) {
  let {protocol, hostname, port, pathname, search, hash} = new URL(url, base)
  return {
    origin: `${protocol}//${hostname}${(port ? `:${port}` : '')}`,
    path: pathname + search + hash,
    pathname
  }
}

const IS_URL_RE = /^[\S]*:\/\/[\S]*$/
/**
 * @param {String} v 
 * @returns {Boolean}
 */
export function isUrl (v) {
  return IS_URL_RE.test(v)
}

export function toArray (v) {
  return Array.isArray(v) ? v : [v]
}

export function parallel (arr, fn, ...args) {
  return promisePool({
    threads: 10,
    promises: ({index}) => index < arr.length ? fn(arr[index], ...args) : null
  })
}

