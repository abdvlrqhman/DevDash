/**
 * Turns a chosen photo into a profile picture: the largest centred square, shrunk to `size` pixels, as a JPEG — a few
 * dozen KB however big the original. Browsers apply the photo's own orientation (EXIF) when drawing it.
 */
export async function squarePicture(file: File, size = 256): Promise<Blob> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    await img.decode().catch(() => { throw new Error("That file isn't a picture this browser can open.") })
    const side = Math.min(img.naturalWidth, img.naturalHeight)
    if (!side) throw new Error("That picture is empty.")
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff' // a transparent PNG becomes a picture on white, not on black
    ctx.fillRect(0, 0, size, size)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, size, size)
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't prepare the picture."))), 'image/jpeg', 0.88))
  } finally {
    URL.revokeObjectURL(url)
  }
}
