#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import stream from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

import WebSocket, { WebSocketServer } from 'ws'
import pug from 'pug'
import stylus from 'stylus'
import mime from 'mime-types'
import chokidar from 'chokidar'

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

let jsConfig
if (fs.existsSync('./webbuilder.config.js')) {
  jsConfig = (await import(pathToFileURL(path.resolve('./webbuilder.config.js')))).default
}

const reWinDirSep = /\\/g

chokidar.watch(config.watch ?? config.src, {
  awaitWriteFinish: {
    stabilityThreshold: config.watchThreshold
  }
}).on('all', async (evt, path) => {
  if (path.match(/\.(css|styl)$/)) {
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
        let content = addReloadClient(await fs.promises.readFile(file, 'utf-8'))
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
  if (jsConfig === undefined || !('devMatch' in jsConfig)) {
    return false
  } else if (typeof jsConfig.devMatch === 'boolean') {
    return jsConfig.devMatch
  } else if (typeof jsConfig.devMatch === 'function') {
    return jsConfig.devMatch(fileName)
  } else if (typeof jsConfig.devMatch === 'string') {
    return fileName.endsWith(jsConfig.devMatch)
  } else if (Symbol.iterator in jsConfig.devMatch) {
    for (const test of jsConfig.devMatch) {
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
  } else if (Symbol.match in jsConfig.devMatch) {
    return !!fileName.match(jsConfig.devMatch)
  }
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

  if (config.cloudflare_spa_router && (!fs.existsSync(fp) || fs.lstatSync(fp).isDirectory()) && !(fp.endsWith('.css') && fs.existsSync(fp.slice(0, -4) + '.styl')) && !(fp.endsWith('.html') && fs.existsSync(fp.slice(0, -5) + '.pug'))) {
    fp = path.join(config.src, 'index.html').replace(reWinDirSep, '/')
  }

  try {
    if (customMatch(fp)) {
      sendFile(req, res, ...(await jsConfig.devHandle(fp, config)))
    } else if (fs.existsSync(fp)) {
      sendFile(req, res, fp)
    } else if (fp.endsWith('.html') && fs.existsSync(fp.slice(0, -5) + '.pug')) {
      sendFile(req, res, addReloadClient(pug.render(fs.readFileSync(fp.slice(0, -5) + '.pug', 'utf-8'), Object.assign({
        filename: filePath,
        basedir: config.src,
        self: true,
        filters: {
          styl(text, options) {
            return stylus.render(text, {
              filename: filePath
            })
          }
        }
      }, config.pugLocals))), 'text/html')
    } else if (fp.endsWith('.css') && fs.existsSync(fp.slice(0, -4) + '.styl')) {
      const sfp = fp.slice(0, -4) + '.styl'
      sendFile(req, res, stylus.render(fs.readFileSync(sfp, 'utf-8'), {
        filename: filePath,
        paths: [
          path.resolve(path.dirname(sfp)),
          path.resolve('.'),
          ...(config.stylusPaths ?? [])
        ]
      }), 'text/css')
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
      `.trim().replace(/^ {6}/g, '')
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
