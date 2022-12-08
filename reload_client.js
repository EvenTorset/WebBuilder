const socket = new WebSocket('ws://localhost:35789')

socket.addEventListener('open', event => {
  console.log('Listening for reload events from dev server...')
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
  if (event.data === 'reload') {
    location.reload()
  } else if (event.data === 'reload css') {
    const cache = {}
    function newCSSURL(old) {
      if (cache[old]) {
        return cache[old]
      } else {
        const url = new URL(old, location.href)
        url.searchParams.set('wbrc_r', Math.random())
        return cache[old] = url.toString()
      }
    }
    for (const link of getExternalStyles()) {
      const old = link.getAttribute('href')
      if (new URL(old, location.href).origin !== location.origin) continue;
      link.setAttribute('href', newCSSURL(old))
    }
  }
})
