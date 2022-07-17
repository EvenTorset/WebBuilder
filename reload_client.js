const socket = new WebSocket('ws://localhost:35789')

socket.addEventListener('open', event => {
  console.log('[RELOAD CLIENT]', 'Listening for file changes from dev server...')
})

function* getExternalStyles(root = document) {
  for (const link of root.querySelectorAll('link[rel="stylesheet"][href]')) {
    yield link
  }
  for (const element of root.querySelectorAll('*')) if (element.shadowRoot) {
    yield* getExternalStyles(element.shadowRoot)
  }
}

socket.addEventListener('message', function (event) {
  if (event.data.endsWith('.css')) {
    let found = false
    for (const link of getExternalStyles()) {
      const url = new URL(link.getAttribute('href'), location.href)
      if (url.origin === location.origin && url.pathname === event.data) {
        found = true
        break
      }
    }
    if (found) {
      const cache = new Map
      function newCSSURL(old) {
        if (!cache.has(old)) {
          const url = new URL(old, location.href)
          url.searchParams.set('wbrc_r', Math.random())
          cache.set(old, url.toString())
        }
        return cache.get(old)
      }
      for (const link of getExternalStyles()) {
        const url = new URL(link.getAttribute('href'), location.href)
        if (url.origin !== location.origin) continue;
        link.setAttribute('href', newCSSURL(link.getAttribute('href')))
      }
    } else {
      location.reload()
    }
  } else {
    location.reload()
  }
})
