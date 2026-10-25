import http from 'node:http'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply } from '../dsh-agnes-media/index.js'

const mode = process.argv[2] === 'real' ? 'real' : 'mock'
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const MP4 = Buffer.concat([
  Buffer.from('00000018667479706d703432000000006d703432', 'hex'),
  Buffer.alloc(4096, 7),
])

function readAgnesKey() {
  const file = path.join(process.env.USERPROFILE || '', '.dsh', '.credentials.yaml')
  const text = readFileSync(file, 'utf8')
  const match = /^\s+AGNES_API_KEY:\s*([^,\s]+)/m.exec(text)
  if (!match) throw new Error('AGNES_API_KEY not found in credentials store')
  return match[1]
}

async function json(url, options) {
  const response = await fetch(url, options)
  let data = {}
  try {
    data = await response.json()
  } catch {
    /* keep status */
  }
  if (!response.ok || data.ok === false) {
    throw new Error(`${url} -> HTTP ${response.status}: ${data.error || ''}`)
  }
  return data
}

async function main() {
  const home = await mkdtemp(path.join(tmpdir(), 'agnes-media-test-'))
  process.env.DSH_HOME = home
  const apiKey = mode === 'real' ? readAgnesKey() : 'test-key'

  let imageHits = 0
  let videoSubmitHits = 0
  let videoStatusHits = 0
  let mockPort = 0
  let mockServer

  if (mode === 'mock') {
    mockServer = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const send = (status, body, type = 'application/json') => {
        res.writeHead(status, { 'content-type': type })
        res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
      }
      if (url.pathname === '/v1/images/generations') {
        imageHits += 1
        if (imageHits <= 2) return send(503, { error: { message: 'busy' } })
        return send(200, { data: [{ url: `http://127.0.0.1:${mockPort}/files/image.png` }] })
      }
      if (url.pathname === '/v1/videos') {
        videoSubmitHits += 1
        return send(200, { video_id: 'vid-1' })
      }
      if (url.pathname === '/v1/videos/vid-1') {
        videoStatusHits += 1
        if (videoStatusHits <= 2) return send(503, { error: { message: 'busy' } })
        if (videoStatusHits <= 4) return send(200, { status: 'queued', progress: 10 })
        return send(200, {
          status: 'completed',
          metadata: { url: `http://127.0.0.1:${mockPort}/files/clip.mp4` },
        })
      }
      if (url.pathname === '/files/image.png') return send(200, PNG, 'image/png')
      if (url.pathname === '/files/clip.mp4') return send(200, MP4, 'video/mp4')
      return send(404, {})
    })
    await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve))
    mockPort = mockServer.address().port
  }

  const routes = []
  const ctx = {
    effect(fn) {
      return fn()
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    credentials: {
      async resolve(ref) {
        return ref === 'AGNES_API_KEY' ? { value: apiKey, source: 'test' } : undefined
      },
      async readRecord() {
        return undefined
      },
    },
  }

  apply(ctx, {
    baseURL: mockPort ? `http://127.0.0.1:${mockPort}/v1` : undefined,
    apiKeyEnv: 'AGNES_API_KEY',
    videoModel: 'agnes-video-2.5-flash',
    imageModel: 'agnes-image-2.5-flash',
  })

  const server = http.createServer((req, res) => {
    const route = routes.find((entry) => (req.url || '').startsWith(entry.path))
    if (!route) {
      res.writeHead(404)
      res.end()
      return
    }
    Promise.resolve(route.handler(req, res)).catch((error) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
      }
      res.end(JSON.stringify({ ok: false, error: String(error) }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const base = `${origin}/agnes-media/api`

  const started = Date.now()
  const status = await json(`${base}/status`)
  if (!status.configured) throw new Error('status reports key missing')

  const imageTask = await json(`${base}/image`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'a red apple on a wooden table', size: '1024x1024' }),
  })

  async function waitFor(id, timeoutMs) {
    const deadline = Date.now() + timeoutMs
    let last
    while (Date.now() < deadline) {
      const data = await json(`${base}/history`)
      last = data.items.find((item) => item.id === id)
      if (last && (last.status === 'ready' || last.status === 'failed')) return last
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    throw new Error(`timeout waiting for ${id}, last=${JSON.stringify(last)}`)
  }

  const imageItem = await waitFor(imageTask.item.id, 4 * 60 * 1000)
  if (imageItem.status !== 'ready') throw new Error(`image failed: ${imageItem.error}`)
  const imageResponse = await fetch(`${origin}${imageItem.url}`)
  const imageBytes = (await imageResponse.arrayBuffer()).byteLength
  if (!imageResponse.ok || imageBytes === 0) throw new Error('image media not served')

  const videoTask = await json(`${base}/video`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'a paper boat drifting down a rainy street', size: '720P', seconds: '4' }),
  })
  const videoItem = await waitFor(videoTask.item.id, 30 * 60 * 1000)
  if (videoItem.status !== 'ready') throw new Error(`video failed: ${videoItem.error}`)
  const videoResponse = await fetch(`${origin}${videoItem.url}`)
  const videoBytes = (await videoResponse.arrayBuffer()).byteLength
  if (!videoResponse.ok || videoBytes === 0) throw new Error('video media not served')

  const rangeResponse = await fetch(`${origin}${videoItem.url}`, { headers: { range: 'bytes=0-99' } })
  const rangeOk = rangeResponse.status === 206

  await json(`${base}/history/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: imageTask.item.id }),
  })
  const after = await json(`${base}/history`)
  const deleteOk = !after.items.some((item) => item.id === imageTask.item.id)

  const result = {
    ok: true,
    mode,
    elapsedMs: Date.now() - started,
    image: { status: imageItem.status, bytes: imageBytes, retries: mode === 'mock' ? imageHits - 1 : undefined },
    video: {
      status: videoItem.status,
      bytes: videoBytes,
      submitHits: mode === 'mock' ? videoSubmitHits : undefined,
      statusHits: mode === 'mock' ? videoStatusHits : undefined,
    },
    rangeOk,
    deleteOk,
    historyCount: after.items.length,
    persisted: readFileSync(path.join(home, 'agnes-media', 'history.json'), 'utf8').length > 0,
  }
  console.log(JSON.stringify(result, null, 2))

  server.close()
  if (mockServer) mockServer.close()
  await rm(home, { recursive: true, force: true })
}

main().catch((error) => {
  console.error('FAILED:', error && error.stack ? error.stack : String(error))
  process.exitCode = 1
})
