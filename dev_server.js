#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import stream from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import child_process from 'node:child_process'

import WebSocket, { WebSocketServer } from 'ws'
import pug from 'pug'
import stylus from 'stylus'
import mime from 'mime-types'
import chokidar from 'chokidar'
import { minify as minifyJS } from 'terser'
import { minify as minifyCSS } from 'csso'

import processTaggedTemplates from './tagged_templates.js'

let config = {
  port: 8080,
  src: 'src',
  watchThreshold: 200
}
if (fs.existsSync('package.json')) {
  const packageJSON = JSON.parse(fs.readFileSync('package.json', 'utf-8'))
  if (packageJSON.webbuilder) {
    config = Object.assign({}, config, packageJSON.webbuilder)
  }
}

const wss = new WebSocketServer({ port: 35789 })

let jsConfig = {}
if (fs.existsSync('./webbuilder.config.js')) {
  jsConfig = (await import(pathToFileURL(path.resolve('./webbuilder.config.js')))).default
}

const reWinDirSep = /\\/g
const reJSExt = /\.[mc]?js$/
const rePathPartEnd = /^(?:\\|\/|$)/

let isSoftReloadAllowed = fp => true
if ('forceHardReload' in config) {
  config.forceHardReload = config.forceHardReload.map(e => path.resolve(e))
  isSoftReloadAllowed = fp => {
    fp = path.resolve(fp)
    return !config.forceHardReload.some(e => fp.startsWith(e) && rePathPartEnd.test(fp.slice(e.length)))
  }
}

chokidar.watch(config.watch ?? config.src, {
  awaitWriteFinish: {
    stabilityThreshold: config.watchThreshold
  }
}).on('all', async (evt, filePath) => {
  if (filePath.match(/\.(css|styl)$/) && isSoftReloadAllowed(filePath)) {
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send('reload css')
      }
    })
  } else {
    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send('reload')
      }
    })
  }
})

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
    env: 'dev'
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

function addReloadClient(html) {
  return html.replace('</head>', '<script type="module" src="/webbuilder_reload_client.js"></script></head>')
}

function handleRange(req, res, size) {
  let [start, end] = req.headers.range.replace(/bytes=/, '').split('-')
  start = parseInt(start)
  end = end ? parseInt(end) : size - 1
  if (isNaN(end)) {
    end = size - 1
  }
  if (isNaN(start)) {
    start = size - 1 - end
  }
  if (start >= size || end >= size) {
    res.writeHead(416, { // Range not satisfiable
      'Content-Range': `bytes */${size}`
    })
    res.end()
    return { start, end, err: true }
  }
  return { start, end, err: false }
}

async function sendFile(req, res, file, type) {
  if (typeof type === 'undefined') {
    if (req.headers.range) {
      const { size } = await fs.promises.stat(file)
      const { start, end, err } = handleRange(req, res, size)
      if (err) return;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': mime.contentType(path.basename(file)),
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      })
      stream.pipeline(fs.createReadStream(file, {start, end}), res, err => {
        if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
          console.error(err)
        }
      })
    } else {
      if (file.endsWith('.html')) {
        const content = Buffer.from(addReloadClient(await fs.promises.readFile(file, 'utf-8')), 'utf-8')
        res.writeHead(200, {
          'Content-Length': content.length,
          'Content-Type': 'text/html',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        })
        res.end(content)
      } else {
        res.writeHead(200, {
          'Content-Length': (await fs.promises.stat(file)).size,
          'Content-Type': mime.contentType(path.basename(file)),
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        })
        stream.pipeline(fs.createReadStream(file), res, err => {
          if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
            console.error(err)
          }
        })
      }
    }
  } else {
    if (typeof file === 'string') {
      file = Buffer.from(file, 'utf-8')
    }
    if (req.headers.range) {
      const { start, end, err } = handleRange(req, res, file.length)
      if (err) return;
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${file.length}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1,
        'Content-Type': type,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      })
      res.end(file.slice(start, end + 1))
    } else {
      res.writeHead(200, {
        'Content-Length': file.length,
        'Content-Type': type,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      })
      res.end(file)
    }
  }
}

function printServerReadyMessage() {
  console.clear()
  console.log(`Dev server running on http://localhost:${config.port}/`)
}

function customMatch(fileName) {
  if (jsConfig === undefined || !('serveFile' in jsConfig) || !Array.isArray(jsConfig.serveFile) || jsConfig.serveFile.length === 0) {
    return false
  }
  for (const [i, handler] of jsConfig.serveFile.entries()) {
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

let errored = 0
const server = http.createServer(async (req, res) => {
  if (errored > 0 && Date.now() - errored > 1000) {
    errored = 0
    printServerReadyMessage()
  }

  const filePath = decodeURIComponent(req.url.slice(1).match(/.*?(?=[#?]|$)/) ?? '')

  try {
    if (filePath === 'webbuilder_reload_client.js') {
      sendFile(req, res, path.join(path.dirname(fileURLToPath(import.meta.url)), 'reload_client.js'))
      return
    }
  } catch (ex) {
    res.writeHead(500)
    res.end()
    console.error(err)
    errored = Date.now()
    return
  }

  let fp = path.join(config.src, filePath).replace(reWinDirSep, '/')
  if (fs.existsSync(fp) && fs.lstatSync(fp).isDirectory()) {
    fp = path.join(fp, 'index.html').replace(reWinDirSep, '/')
  } else if (!fs.existsSync(fp) && fs.existsSync(fp + '.html')) {
    fp += '.html'
  }

  if (!(typeof customMatch(fp) === 'number') && (config.cloudflareSPARouter || config.cloudflare_spa_router) && (!fs.existsSync(fp) || fs.lstatSync(fp).isDirectory()) && !(fp.endsWith('.css') && fs.existsSync(fp.slice(0, -4) + '.styl')) && !(fp.endsWith('.html') && fs.existsSync(fp.slice(0, -5) + '.pug'))) {
    fp = path.join(config.src, 'index.html').replace(reWinDirSep, '/')
  }

  try {
    const customMatchIdx = customMatch(fp)
    if (typeof customMatchIdx === 'number') {
      const out = await jsConfig.serveFile[customMatchIdx].process?.(fp, config, {
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
        res.writeHead(404)
        res.end()
        return
      }
      sendFile(req, res, ...out)
    } else if (reJSExt.test(fp) && fs.existsSync(fp)) {
      if (config.useTaggedTemplateReplacer) {
        sendFile(req, res, processTaggedTemplates(fs.readFileSync(fp, 'utf-8'), fp, {
          processPug,
          processStylus,
          uglifyJS: uglifyJSSync
        }), 'text/javascript')
      } else {
        sendFile(req, res, fp)
      }
    } else if (fs.existsSync(fp)) {
      sendFile(req, res, fp)
    } else if (fp.endsWith('.html') && fs.existsSync(fp.slice(0, -5) + '.pug')) {
      sendFile(req, res, addReloadClient(processPug(fs.readFileSync(fp.slice(0, -5) + '.pug', 'utf-8'), fp)), 'text/html')
    } else if (fp.endsWith('.css') && fs.existsSync(fp.slice(0, -4) + '.styl')) {
      const sfp = fp.slice(0, -4) + '.styl'
      sendFile(req, res, processStylus(fs.readFileSync(sfp, 'utf-8'), fp), 'text/css')
    } else {
      res.writeHead(404)
      res.end()
    }
  } catch (err) {
    if (fp.endsWith('.html')) {
      const errHtml = `
        <body style="color:#ddd;background-color:#101010;margin:0;padding:60px;min-height:100vh;box-sizing:border-box;overflow-x:auto">
          <script type="module" src="webbuilder_reload_client.js"></script>
          <h2>Pug / HTML Error</h2>
          <p style="color:#c25;font-family:'Cascadia Mono',Consolas,monospace;white-space:pre">${
            err.stack.toString()
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#039;')
          }</p>
        </body>
      `.trim().replace(/^ {8}/g, '')
      res.writeHead(200, {
        'Content-Length': errHtml.length,
        'Content-Type': 'text/html',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      })
      res.end(errHtml)
    } else {
      res.writeHead(500)
      res.end()
    }
    console.error(err)
    errored = Date.now()
  }
})

server.listen(config.port, printServerReadyMessage)
