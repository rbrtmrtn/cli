const objFilterCtor = require('through2-filter').objCtor
const objWriter = require('flush-write-stream').obj
const { normalizePath, isExe } = require('./util')
const transform = require('parallel-transform')
const hasha = require('hasha')
const path = require('path')
const fs = require('fs')
const map = require('through2-map').obj

// a parallel transform stream segment ctor that hashes fileObj's created by folder-walker
exports.hasherCtor = ({ concurrentHash, hashAlgorithm = 'sha1' }) => {
  if (!concurrentHash) throw new Error('Missing required opts')
  return transform(concurrentHash, { objectMode: true, ordered: false }, (fileObj, cb) => {
    hasha
      .fromFile(fileObj.filepath, { algorithm: hashAlgorithm })
      // insert hash and asset type to file obj
      .then(hash => cb(null, Object.assign({}, fileObj, { hash })))
      .catch(err => cb(err))
  })
}

// Inject normalized function names into normalizedPath and assetType
exports.fnNormalizerCtor = fnNormalizerCtor
function fnNormalizerCtor({ assetType = 'function' }) {
  return map(fileObj => {
    return Object.assign({}, fileObj, { assetType, normalizedPath: path.basename(fileObj.basename, fileObj.extname) })
  })
}

// Inject normalized file names into normalizedPath and assetType
exports.fileNormalizerCtor = fileNormalizerCtor
function fileNormalizerCtor({ assetType = 'file' }) {
  return map(fileObj => {
    return Object.assign({}, fileObj, { assetType, normalizedPath: normalizePath(fileObj.relname) })
  })
}

// A writable stream segment ctor that normalizes file paths, and writes shaMap's
exports.manifestCollectorCtor = (filesObj, shaMap) => {
  return objWriter((fileObj, _, cb) => {
    filesObj[fileObj.normalizedPath] = fileObj.hash

    // We map a hash to multiple fileObj's because the same file
    // might live in two different locations

    if (Array.isArray(shaMap[fileObj.hash])) {
      shaMap[fileObj.hash].push(fileObj)
    } else {
      shaMap[fileObj.hash] = [fileObj]
    }

    cb(null)
  })
}

// transform stream ctor that filters folder-walker results for only files
exports.fileFilterCtor = objFilterCtor(
  fileObj => fileObj.type === 'file' && (fileObj.relname.match(/(\/__MACOSX|\/\.)/) ? false : true)
)

// parallel stream ctor similar to folder-walker but specialized for netlify functions
// Stream in names of files that may be functions, and this will stat the file and return a fileObj
exports.fnStatFilterCtor = ({ root, concurrentStat }) => {
  if (!concurrentStat || !root) throw new Error('Missing required opts')
  return transform(concurrentStat, { objectMode: true, ordered: false }, (name, cb) => {
    const filepath = path.join(root, name)

    fs.stat(filepath, (err, stat) => {
      if (err) return cb(err)

      const item = {
        root,
        filepath,
        stat,
        relname: path.relative(root, filepath),
        basename: path.basename(name),
        extname: path.extname(name),
        type: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : null
      }

      if (item.type !== 'file') return cb() // skip folders

      if (['.zip', '.js'].some(ext => item.extname === ext)) {
        item.runtime = 'js'
        return cb(null, item)
      }

      if (isExe(item.stat)) {
        item.runtime = 'go'
        return cb(null, item)
      }

      // skip anything else
      return cb()
    })
  })
}
