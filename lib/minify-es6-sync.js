import fs from 'node:fs'

import { minify } from 'terser'

const cl = 100 // context length for error printing

let input = ''
const terserConfig = JSON.parse(process.argv[3])

process.stdin.on('readable', () => {
  let chunk
  while (null !== (chunk = process.stdin.read())) {
    input += chunk
  }
})

process.stdin.on('end', async () => {
  try {
    const out = await minify(input, terserConfig)

    if (!out.error) {
      process.stdout.write(out.code) // no newline
      process.stdout.on('drain', () => {
        // write is done
        process.exit(0) // success
      })
    } else {
      console.log('error:')
      console.dir(out.error)
      const ep = out.error.pos
      console.log(`parse error context +-${cl}: ${input.substring(ep - cl, ep + cl)}`)
      console.log(`parse error raised at: ${input.substring(ep, ep + cl)}`)
      process.stdout.on('drain', () => {
        // write is done
        process.exit(1) // error 1
      })
    }
  }
  catch (error) {
    console.log('error:')
    console.dir(error)
    process.stdout.on('drain', () => {
      // write is done
      process.exit(2) // error 2
    })
  }
})
