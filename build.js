#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import pug from 'pug'
import stylus from 'stylus'
import { minify } from 'terser'

const config = {
  src: 'src',
  output: 'dist'
}
if (fs.existsSync('package.json')) {
  const packageJSON = JSON.parse(fs.readFileSync('package.json', 'utf-8'))
  if (packageJSON.webbuilder) {
    Object.assign(config, packageJSON.webbuilder)
  }
}

let jsConfig
if (fs.existsSync('./webbuilder.config.js')) {
  jsConfig = (await import(pathToFileURL(path.resolve('./webbuilder.config.js')))).default
}

const reWinDirSep = /\\/g

async function* getFiles(dir) {
  const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
  for (const dirent of dirents) {
    const res = path.resolve(dir, dirent.name);
    if (dirent.isDirectory()) {
      yield* getFiles(res);
    } else {
      yield res;
    }
  }
}

function customMatch(fileName) {
  if (jsConfig === undefined || !('buildMatch' in jsConfig)) {
    return false
  } else if (typeof jsConfig.buildMatch === 'boolean') {
    return jsConfig.buildMatch
  } else if (typeof jsConfig.buildMatch === 'function') {
    return jsConfig.buildMatch(fileName)
  } else if (typeof jsConfig.buildMatch === 'string') {
    return fileName.endsWith(jsConfig.buildMatch)
  } else if (Symbol.iterator in jsConfig.buildMatch) {
    for (const test of jsConfig.buildMatch) {
      if (typeof test === 'string') {
        if (fileName.endsWith(test)) {
          return true
        } else {
          continue
        }
      } else if (Symbol.match in test) {
        if (!!fileName.match(test)) {
          return true
        } else {
          continue
        }
      }
    }
    return false
  } else if (Symbol.match in jsConfig.buildMatch) {
    return !!fileName.match(jsConfig.buildMatch)
  }
}

function processPug(s, filePath) {
  return pug.render(s, Object.assign({
    filename: filePath,
    basedir: config.src,
    self: true,
    filters: {
      styl(text, options) {
        return processStylus(text, filePath)
      }
    }
  }, config.pugLocals))
}

function processStylus(s, filePath) {
  return stylus.render(s, {
    filename: filePath,
    compress: true,
    paths: [
      path.resolve(path.dirname(filePath)),
      path.resolve('.'),
      ...(config.stylusPaths ?? [])
    ]
  })
}

async function uglifyJS(s) {
  return (await minify(s, Object.assign({
    ecma: 2020,
    compress: {
      keep_fargs: true,
      keep_infinity: true,
      reduce_funcs: false
    },
    module: true
  }, typeof config.uglify === 'object' ? config.uglify : {}))).code
}

if (fs.existsSync(config.output) && !fs.lstatSync(config.output).isDirectory()) {
  throw 'Output path is not a directory'
}

for await (const filePath of getFiles(config.src)) {
  let testPath = path.join(config.src, path.relative(config.src, filePath)).replace(reWinDirSep, '/')
  if (customMatch(testPath)) {
    const outPath = path.join(config.output, path.relative(config.src, filePath))
    if (!fs.existsSync(path.dirname(outPath))) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
    }
    fs.writeFileSync(outPath, await jsConfig.buildHandle(filePath, config, {
      processPug,
      processStylus,
      uglifyJS
    }))
  } else if (path.extname(filePath) === '.pug') {
    const outPath = path.join(config.output, path.relative(config.src, filePath.slice(0, -3) + 'html'))
    if (!fs.existsSync(path.dirname(outPath))) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
    }
    fs.writeFileSync(outPath, processPug(fs.readFileSync(filePath, 'utf-8'), filePath), 'utf-8')
  } else if (path.extname(filePath) === '.styl') {
    const outPath = path.join(config.output, path.relative(config.src, filePath.slice(0, -4) + 'css'))
    if (!fs.existsSync(path.dirname(outPath))) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
    }
    fs.writeFileSync(outPath, processStylus(fs.readFileSync(filePath, 'utf-8'), filePath), 'utf-8')
  } else if (config.uglify && path.extname(filePath) === '.js') {
    const outPath = path.join(config.output, path.relative(config.src, filePath))
    if (!fs.existsSync(path.dirname(outPath))) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
    }
    fs.writeFileSync(outPath, await uglifyJS(fs.readFileSync(filePath, 'utf-8')), 'utf-8')
  } else if (!config.keepJSON && path.extname(filePath) === '.json') {
    const outPath = path.join(config.output, path.relative(config.src, filePath))
    if (!fs.existsSync(path.dirname(outPath))) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
    }
    fs.writeFileSync(outPath, JSON.stringify(JSON.parse(fs.readFileSync(filePath))), 'utf-8')
  } else {
    const outPath = path.join(config.output, path.relative(config.src, filePath))
    if (!fs.existsSync(path.dirname(outPath))) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
    }
    await fs.promises.copyFile(filePath, outPath)
  }
}
