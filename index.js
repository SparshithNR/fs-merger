"use strict";
const fs = require('fs-extra');
const walkSync = require('walk-sync');
const path = require('path');
const nodefs = require('fs');
const broccoliNodeInfo = require('broccoli-node-info');

const WHITELISTEDOPERATION = new Set([
  'readFileSync',
  'existsSync',
  'lstatSync',
  'statSync',
  'readdirSync',
  'readDir',
  'readFileMeta',
  'entries'
]);

function getRootAndPrefix(node) {
  let root = '';
  let prefix = '';
  let getDestinationPath = undefined;
  if (typeof node == 'string') {
    root = node;
  } else if(node.root) {
    root = node.root;
  } else {
    let { nodeType, sourceDirectory } = broccoliNodeInfo.getNodeInfo(node);
    root = nodeType == 'source' ? sourceDirectory : node.outputPath;
  }
  return {
    root: path.normalize(root),
    prefix: node.prefix || prefix,
    getDestinationPath: node.getDestinationPath || getDestinationPath
  }
}

function getValues(object) {
  if (Object.values) {
    return Object.values(object);
  } else {
    return Object.keys(object).map(function(key) {
      return object[key];
    });
  }
}

function handleOperation({ target, propertyName }, relativePath, ...fsArguments) {
  if (!this.MAP) {
    this._generateMap();
  }
  if (!path.isAbsolute(relativePath)) {
    // if property is present in the FSMerge do not hijack it with fs operations
    if (this[propertyName]) {
      return this[propertyName](relativePath, ...fsArguments);
    }
    let { _dirList } = this;
    let fullPath = relativePath;
    for (let i=_dirList.length-1; i > -1; i--) {
      let { root } = this.PREFIXINDEXMAP[i];
      let tempPath = root + '/' + relativePath;
      if(fs.existsSync(tempPath)) {
        fullPath = tempPath;
      }
    }
    return target[propertyName](fullPath, ...fsArguments);
  } else {
    throw new Error(`Relative path is expected, path ${relativePath} is an absolute path. inputPath gets prefixed to the reltivePath provided.`);
  }
}

class FSMerge {
  constructor(trees) {
    this._dirList = Array.isArray(trees) ? trees : [trees];
    this.MAP = null;
    this.PREFIXINDEXMAP = {};
    this._atList = [];
    let self = this;
    this.fs = new Proxy(nodefs, {
      get(target, propertyName) {
        if(WHITELISTEDOPERATION.has(propertyName) || self[propertyName]) {
          return handleOperation.bind(self, {target, propertyName})
        } else {
          throw new Error(`Operation ${propertyName} is not allowed with FSMerger.fs. Allowed operations are ${Array.from(WHITELISTEDOPERATION).toString()}`);
        }
      }
    });
  }

  readFileSync(filePath, options) {
    if (!this.MAP) {
      this._generateMap();
    }
    let { _dirList } = this;
    for (let i=_dirList.length-1; i > -1; i--) {
      let { root } = this.PREFIXINDEXMAP[i];
      let fullPath = root + '/' + filePath;
      if(fs.existsSync(fullPath)) {
        return fs.readFileSync(fullPath, options);
      }
    }
  }

  at(index) {
    if(!this._atList[index]) {
      this._atList[index] = new FSMerge(this._dirList[index]);
    }
    return this._atList[index]
  }

  _generateMap() {
    this.MAP = this._dirList.reduce((map, tree, index) => {
      let parsedTree = getRootAndPrefix(tree);
      map[parsedTree.root] = parsedTree;
      this.PREFIXINDEXMAP[index] = parsedTree;
      return map;
    }, {});
  }

  readFileMeta(filePath, options) {
    if (!this.MAP) {
      this._generateMap();
    }
    let { _dirList } = this;
    let result = null;
    let { basePath } = options || {};
    basePath = basePath && path.normalize(basePath);
    if (this.MAP[basePath]) {
      let { root, prefix, getDestinationPath } = this.MAP[basePath];
      return {
        path: path.join(root, filePath),
        prefix: prefix,
        getDestinationPath: getDestinationPath
      }
    }
    for (let i=_dirList.length-1; i > -1; i--) {
      let { root, prefix, getDestinationPath } = this.PREFIXINDEXMAP[i];
      let fullPath = path.join(root, filePath);
      if (basePath == root || fs.existsSync(fullPath)) {
        return {
          path: fullPath,
          prefix: prefix,
          getDestinationPath: getDestinationPath
        };
      }
    }
    return result;
  }

  readdirSync(dirPath, options) {
    if (!this.MAP) {
      this._generateMap();
    }
    let { _dirList } = this;
    let result = [], errorCount = 0;
    let fullDirPath = '';
    for (let i=0; i < _dirList.length; i++) {
      let { root } = this.PREFIXINDEXMAP[i];
      fullDirPath = root + '/' + dirPath;
      fullDirPath = fullDirPath.replace(/(\/|\/\/)$/, '');
      if(fs.existsSync(fullDirPath)) {
        result.push.apply(result, fs.readdirSync(fullDirPath, options));
      } else {
        errorCount += 1;
      }
    }
    if (errorCount == _dirList.length) {
      fs.readdirSync(fullDirPath);
    }
    return [...new Set(result)];
  }

  readdir(dirPath, callback) {
    if (!this.MAP) {
      this._generateMap();
    }
    let result = [];
    let { _dirList } = this;
    let fullDirPath = '';
    let existingPath = [];
    for (let i=0; i < _dirList.length; i++) {
      let { root } = this.PREFIXINDEXMAP[i];
      fullDirPath = root + '/' + dirPath;
      fullDirPath = fullDirPath.replace(/(\/|\/\/)$/, '');
      if(fs.existsSync(fullDirPath)) {
        existingPath.push(fullDirPath);
      }
    }
    if (!existingPath.length) {
      fs.readdir(fullDirPath, callback);
    }
    let readComplete = 0;
    for (let i = 0; i < existingPath.length; i++) {
      fs.readdir(existingPath[i], (err, list) => {
        readComplete += 1;
        result.push.apply(result, list);
        if (readComplete == existingPath.length || err) {
          if (err) {
            result = undefined;
          } else {
            result = [...new Set(result)];
          }
          callback(err, result);
        }
      });
    }
  }

  entries(dirPath = '', options) {
    if (!this.MAP) {
      this._generateMap();
    }
    let { _dirList } = this;
    let result = [];
    let hashStore = {};
    for (let i=0; i < _dirList.length; i++) {
      let { root, prefix, getDestinationPath } = this.PREFIXINDEXMAP[i];
      if (!root) {
        throw new Error('FSMerger must be instatiated with string or BroccoliNode or Object with root');
      }
      let fullDirPath = dirPath ? root + '/' + dirPath : root;
      fullDirPath = fullDirPath.replace(/(\/|\/\/)$/, '');
      if(fs.existsSync(fullDirPath)) {
        let curEntryList = walkSync.entries(fullDirPath, options);
        hashStore = curEntryList.reduce((hashStoreAccumulated, entry) => {
          let relativePath = getDestinationPath ? getDestinationPath(entry.relativePath) : entry.relativePath;
          relativePath = prefix ? path.join(prefix, relativePath) : relativePath;
          hashStoreAccumulated[relativePath] = entry;
          return hashStoreAccumulated;
        }, hashStore);
      }
    }
    result = getValues(hashStore);
    result.sort((entryA, entryB) => (entryA.relativePath > entryB.relativePath) ? 1 : -1);
    return result;
  }
}

module.exports = FSMerge;