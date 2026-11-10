// Minimal PNG reader for the simulator's glasses screenshots (8-bit, non-interlaced, gray/RGB/RGBA/palette).
import { inflateSync } from 'node:zlib'

export function decodePng(buffer) {
  const signature = '89504e470d0a1a0a'
  if (buffer.subarray(0, 8).toString('hex') !== signature) throw new Error('not a PNG')
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  let palette = null
  const data = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const body = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      bitDepth = body[8]
      colorType = body[9]
      interlace = body[12]
    } else if (type === 'PLTE') palette = body
    else if (type === 'IDAT') data.push(body)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  if (bitDepth !== 8 || interlace !== 0) throw new Error(`unsupported PNG (depth ${bitDepth}, interlace ${interlace})`)
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error(`unsupported PNG color type ${colorType}`)
  const raw = inflateSync(Buffer.concat(data))
  const stride = width * channels
  const pixels = Buffer.alloc(height * stride)
  const paeth = (a, b, c) => {
    const p = a + b - c
    const pa = Math.abs(p - a)
    const pb = Math.abs(p - b)
    const pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0
      const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0
      let value = line[x]
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += (left + up) >> 1
      else if (filter === 4) value += paeth(left, up, upLeft)
      pixels[y * stride + x] = value & 0xff
    }
  }
  // "Ink" per pixel: how far it is from the background colour (the most common pixel). The glasses framebuffer is
  // green on a flat background, but which one is the background depends on the simulator build.
  const rgb = (i) => {
    // [r, g, b, a]; the simulator's RGBA captures keep the colour fixed and draw the text with alpha.
    if (colorType === 0) return [pixels[i], pixels[i], pixels[i], 255]
    if (colorType === 4) return [pixels[i * 2], pixels[i * 2], pixels[i * 2], pixels[i * 2 + 1]]
    if (colorType === 3) { const index = pixels[i] * 3; return [palette[index], palette[index + 1], palette[index + 2], 255] }
    return [pixels[i * channels], pixels[i * channels + 1], pixels[i * channels + 2], colorType === 6 ? pixels[i * channels + 3] : 255]
  }
  const counts = new Map()
  for (let i = 0; i < width * height; i += 1) {
    const [r, g, b, a] = rgb(i)
    const key = (a * 16777216) + ((r << 16) | (g << 8) | b)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  let background = 0
  let best = -1
  for (const [key, count] of counts) if (count > best) { best = count; background = key }
  const bg = [Math.floor(background / 65536) & 255, Math.floor(background / 256) & 255, background & 255, Math.floor(background / 16777216) & 255]
  const brightness = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i += 1) {
    const [r, g, b, a] = rgb(i)
    brightness[i] = Math.max(Math.abs(r - bg[0]), Math.abs(g - bg[1]), Math.abs(b - bg[2]), Math.abs(a - bg[3]))
  }
  return { width, height, brightness }
}

/** Horizontal text bands in [y0, y1): each { top, bottom, minX, maxX } where ink (brightness > threshold) exists. */
export function inkBands(image, { x0, x1, y0, y1, threshold = 60, minGap = 3 }) {
  const bands = []
  let current = null
  let gap = 0
  for (let y = y0; y < y1; y += 1) {
    let minX = Infinity
    let maxX = -Infinity
    for (let x = x0; x < x1; x += 1) {
      if (image.brightness[y * image.width + x] > threshold) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
      }
    }
    if (maxX >= 0) {
      if (!current) current = { top: y, bottom: y, minX, maxX }
      else {
        current.bottom = y
        current.minX = Math.min(current.minX, minX)
        current.maxX = Math.max(current.maxX, maxX)
      }
      gap = 0
    } else if (current) {
      gap += 1
      if (gap >= minGap) {
        bands.push(current)
        current = null
      }
    }
  }
  if (current) bands.push(current)
  return bands
}
