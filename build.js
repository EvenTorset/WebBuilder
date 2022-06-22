#!/usr/bin/env node

import fs from 'fs'
import path from 'path'

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

if (fs.existsSync(config.output) && !fs.lstatSync(config.output).isDirectory()) {
  throw 'Output path is not a directory'
}

for await (const filePath of getFiles(config.src)) {
  if (path.extname(filePath) === '.pug') {
    const outPath = path.join(config.output, path.relative(config.src, filePath.slice(0, -3) + 'html'))
    if (!fs.existsSync(path.dirname(outPath))) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
    }
    fs.writeFileSync(outPath, pug.render(fs.readFileSync(filePath, 'utf-8'), {
      filename: filePath,
      basedir: config.src,
      filters: {
        styl(text, options) {
          return stylus.render(text, {
            filename: filePath,
            compress: true
          })
        }
      }
    }), 'utf-8')
  } else if (path.extname(filePath) === '.styl') {
    const outPath = path.join(config.output, path.relative(config.src, filePath.slice(0, -4) + 'css'))
    if (!fs.existsSync(path.dirname(outPath))) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
    }
    fs.writeFileSync(outPath, stylus.render(fs.readFileSync(filePath, 'utf-8'), {
      filename: filePath,
      compress: true
    }), 'utf-8')
  } else if (config.uglify && path.extname(filePath) === '.js') {
    const outPath = path.join(config.output, path.relative(config.src, filePath))
    if (!fs.existsSync(path.dirname(outPath))) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true })
    }
    const options = Object.assign({
      ecma: 2020,
      compress: {
        keep_fargs: true,
        keep_infinity: true,
        reduce_funcs: false
      },
      module: true
    }, typeof config.uglify === 'object' ? config.uglify : {})
    fs.writeFileSync(outPath, (await minify(fs.readFileSync(filePath, 'utf-8'), options)).code, 'utf-8')
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
