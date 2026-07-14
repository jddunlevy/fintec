// ImageProcessor: resize to 1568px long edge via canvas, JPEG ~0.8, base64.
// Anthropic downscales beyond ~1568px anyway; this keeps small screen text
// legible while holding the upload to roughly 300-600KB.

const MAX_LONG_EDGE = 1568;
const JPEG_QUALITY = 0.8;

/** Takes a capture canvas, returns base64 JPEG data (no data: prefix). */
export async function canvasToBase64Jpeg(source) {
  let canvas = source;
  const longEdge = Math.max(source.width, source.height);

  if (longEdge > MAX_LONG_EDGE) {
    const scale = MAX_LONG_EDGE / longEdge;
    canvas = document.createElement('canvas');
    canvas.width = Math.floor(source.width * scale);
    canvas.height = Math.floor(source.height * scale);
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  }

  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY)
  );
  if (!blob) throw new Error('jpeg-encode-failed');

  const dataURL = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

  return String(dataURL).split(',', 2)[1];
}
