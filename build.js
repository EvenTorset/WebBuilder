#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import child_process from 'node:child_process'

import pug from 'pug'
import stylus from 'stylus'
import { minify as minifyJS } from 'terser'
import { minify as minifyCSS } from 'csso'

import processTaggedTemplates from './tagged_templates.js'

const config = {
  src: 'src',
  output: 'dist',
  uglify: true
}
if (fs.existsSync('package.json')) {
  const packageJSON = JSON.parse(fs.readFileSync('package.json', 'utf-8'))
  if (packageJSON.webbuilder) {
    Object.assign(config, packageJSON.webbuilder)
  }
}

let jsConfig = {}
if (fs.existsSync('./webbuilder.config.js')) {
  jsConfig = (await import(pathToFileURL(path.resolve('./webbuilder.config.js')))).default
}

const reWinDirSep = /\\/g
const reJSExt = /\.[mc]?js$/

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
  if (jsConfig === undefined || !('buildFile' in jsConfig) || !Array.isArray(jsConfig.buildFile) || jsConfig.buildFile.length === 0) {
    return false
  }
  for (const [i, handler] of jsConfig.buildFile.entries()) {
    if (typeof handler.match === 'function' && handler.match(fileName) || typeof handler.match === 'string' && fileName.endsWith(handler.match) || Symbol.match in handler.match && fileName.match(handler.match)) {
      return i
    } else if (Symbol.iterator in handler.match) {
      for (const test of handler.match) {
        if (typeof test === 'function' && test(fileName) || typeof test === 'string' && fileName.endsWith(test) || Symbol.match in test && fileName.match(test)) {
          return i
        }
      }
    }
  }
  return false
}

const customPugFilters = typeof jsConfig.pugFilters === 'function' ?
  jsConfig.pugFilters({
    processPug,
    processStylus,
    uglifyJS: uglifyJSSync
  })
:
  jsConfig.pugFilters ?? {}

function processPug(s, filePath) {
  return pug.render(s, Object.assign({
    filename: filePath,
    basedir: config.src,
    self: true,
    filters: {
      styl(text, options) {
        return processStylus(text, filePath)
      },
      uglify(text, options) {
        return uglifyJSSync(text)
      },
      taggedTemplates(text, options) {
        return processTaggedTemplates(text, filePath, {
          processPug,
          processStylus,
          uglifyJS: uglifyJSSync
        })
      },
      ...customPugFilters
    },
    env: 'production'
  }, config.pugLocals))
}

function processStylus(s, filePath) {
  return minifyCSS(stylus.render(s, {
    filename: filePath,
    compress: true,
    paths: [
      path.resolve(path.dirname(filePath)),
      path.resolve('.'),
      ...(config.stylusPaths ?? [])
    ]
  })).css
}

const terserConfig = Object.assign({
  ecma: 2020,
  compress: {
    keep_fargs: true,
    keep_infinity: true,
    reduce_funcs: false,
    passes: config.uglifyPasses ?? 2
  },
  module: true
}, typeof config.uglify === 'object' ? config.uglify : {})

async function uglifyJS(s) {
  return (await minifyJS(s, terserConfig)).code
}

function uglifyJSSync(s) {
  return child_process.execSync(
    `node ${path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib/minify-es6-sync.js')} -- "${JSON.stringify(terserConfig).replace(/["\\]/g, '\\$&')}"`, {
    input: s,
    encoding: 'utf-8',
    maxBuffer: Infinity,
    windowsHide: true,
  })
}

if (fs.existsSync(config.output) && !fs.lstatSync(config.output).isDirectory()) {
  throw 'Output path is not a directory'
}

if ('build' in jsConfig && typeof jsConfig.build === 'function') {
  await jsConfig.build(config, {
    processPug,
    processStylus,
    uglifyJS
  })
}

for await (const filePath of getFiles(config.src)) {
  let testPath = path.join(config.src, path.relative(config.src, filePath)).replace(reWinDirSep, '/')
  const customMatchIdx = customMatch(testPath)
  if (typeof customMatchIdx === 'number') {
    const out = await jsConfig.buildFile[customMatchIdx].process?.(filePath, config, {
      processPug,
      processStylus,
      uglifyJS,
      processTaggedTemplates: (s, filePath) => processTaggedTemplates(s, filePath, {
        processPug,
        processStylus,
        uglifyJS: uglifyJSSync
      })
    })
    if (out === undefined) {
      continue
    }
    const outPath = path.join(config.output, path.relative(config.src, filePath))
    if (!fs.existsSync(path.dirname(outPath))) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
    }
    if (typeof out === 'string') {
      fs.writeFileSync(outPath, out, 'utf-8')
    } else {
      fs.writeFileSync(outPath, out)
    }
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
  } else if (path.extname(filePath) === '.css') {
    const outPath = path.join(config.output, path.relative(config.src, filePath))
    if (!fs.existsSync(path.dirname(outPath))) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
    }
    fs.writeFileSync(outPath, minifyCSS(fs.readFileSync(filePath, 'utf-8')).css, 'utf-8')
  } else if (reJSExt.test(filePath)) {
    const outPath = path.join(config.output, path.relative(config.src, filePath))
    if (!fs.existsSync(path.dirname(outPath))) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
    }
    if (!config.uglify && !config.useTaggedTemplateReplacer) {
      await fs.promises.copyFile(filePath, outPath)
      continue
    }
    let js = fs.readFileSync(filePath, 'utf-8')
    if (config.useTaggedTemplateReplacer) {
      js = processTaggedTemplates(js, filePath, {
        processPug,
        processStylus,
        uglifyJS
      })
    }
    if (config.uglify) {
      js = await uglifyJS(js)
    }
    fs.writeFileSync(outPath, js, 'utf-8')
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
