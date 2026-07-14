// Camera: getUserMedia viewfinder, digital pinch-to-zoom, frame capture.
// Zoom is a CSS transform on the preview plus a matching center-crop at
// capture time, so what you see is exactly what gets sent.

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;

let video = null;
let container = null;
let stream = null;
let zoom = 1;
let pinchAttached = false;
let pinchStartDist = 0;
let pinchStartZoom = 1;

/** Starts the rear camera into videoEl. Returns false if denied/unavailable. */
export async function start(videoEl, containerEl) {
  video = videoEl;
  container = containerEl;
  stop();
  zoom = 1;
  applyZoom();
  attachPinchOnce();

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 4096 },
        height: { ideal: 2160 },
      },
    });
  } catch {
    return false;
  }

  video.srcObject = stream;
  try {
    await video.play();
  } catch {
    // Autoplay hiccup; playsinline+muted normally makes this succeed.
  }
  return true;
}

/** Stops the stream (battery); reacquired on next start(). */
export function stop() {
  if (stream) {
    stream.getTracks().forEach((track) => track.stop());
    stream = null;
  }
  if (video) video.srcObject = null;
}

export function isRunning() {
  return stream !== null;
}

/**
 * Draws the currently visible (zoom-cropped) region of the live frame to a
 * canvas at native stream resolution. Returns null if no frame available.
 */
export function captureFrame() {
  if (!video || !video.videoWidth || !stream) return null;

  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const rect = container.getBoundingClientRect();

  // object-fit: cover scale, multiplied by the digital zoom.
  const coverScale = Math.max(rect.width / vw, rect.height / vh);
  const scale = coverScale * zoom;

  const srcW = Math.min(vw, rect.width / scale);
  const srcH = Math.min(vh, rect.height / scale);
  const srcX = (vw - srcW) / 2;
  const srcY = (vh - srcH) / 2;

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(srcW);
  canvas.height = Math.round(srcH);
  canvas.getContext('2d')
    .drawImage(video, srcX, srcY, srcW, srcH, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// ---- pinch-to-zoom ----

function attachPinchOnce() {
  if (pinchAttached) return;
  pinchAttached = true;

  container.addEventListener('touchstart', (event) => {
    if (event.touches.length === 2) {
      pinchStartDist = touchDistance(event.touches);
      pinchStartZoom = zoom;
    }
  }, { passive: true });

  container.addEventListener('touchmove', (event) => {
    if (event.touches.length === 2 && pinchStartDist > 0) {
      event.preventDefault();
      const ratio = touchDistance(event.touches) / pinchStartDist;
      zoom = clamp(pinchStartZoom * ratio, MIN_ZOOM, MAX_ZOOM);
      applyZoom();
    }
  }, { passive: false });

  container.addEventListener('touchend', () => {
    pinchStartDist = 0;
  }, { passive: true });
}

function applyZoom() {
  if (video) video.style.transform = `scale(${zoom})`;
}

function touchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}
