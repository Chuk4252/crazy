// Crazy Downloader 2 - Manifest V3 Background Service Worker

const IPC_BASE = 'http://127.0.0.1:49820';
const NATIVE_HOST_NAME = 'com.crazy.downloader';
const EXTENSION_VERSION = chrome.runtime?.getManifest?.()?.version || '2.1.0';

const tabStreams = new Map(); // tabId -> Map(url -> { url, mimeType, size, detectedAt })
let interceptEnabled = true;

function isHttpUrl(urlStr) {
  return typeof urlStr === 'string' && /^https?:\/\//i.test(urlStr.trim());
}

try {
  chrome.storage?.local?.get(['interceptEnabled'], (res) => {
    if (typeof res?.interceptEnabled === 'boolean') {
      interceptEnabled = res.interceptEnabled;
    }
  });
  chrome.storage?.onChanged?.addListener((changes) => {
    if (changes.interceptEnabled) {
      interceptEnabled = changes.interceptEnabled.newValue !== false;
    }
  });
} catch {}

// 1. Context Menus setup
function registerContextMenus() {
  if (!chrome.contextMenus?.create) return;
  try {
    chrome.contextMenus.removeAll(() => {
      const _ignore = chrome.runtime?.lastError;
      try {
        chrome.contextMenus.create({
          id: 'crazy-download-link',
          title: 'Download with Crazy Downloader 2',
          contexts: ['link', 'image', 'video', 'audio']
        }, () => { void chrome.runtime?.lastError; });

        chrome.contextMenus.create({
          id: 'crazy-download-page-video',
          title: 'Download video on this page with Crazy Downloader 2',
          contexts: ['page', 'frame']
        }, () => { void chrome.runtime?.lastError; });
      } catch {}
    });
  } catch {}
}

if (chrome.runtime?.onInstalled?.addListener) {
  chrome.runtime.onInstalled.addListener(() => {
    registerContextMenus();
  });
}

if (chrome.contextMenus?.onClicked?.addListener) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'crazy-download-link') {
      const targetUrl = info.linkUrl || info.srcUrl || info.pageUrl;
      if (!isHttpUrl(targetUrl)) return;
      dispatchDownload({
        url: targetUrl,
        referrer: isHttpUrl(tab?.url) ? tab.url : (isHttpUrl(info.pageUrl) ? info.pageUrl : '')
      }).catch(() => {});
    } else if (info.menuItemId === 'crazy-download-page-video') {
      const pageUrl = tab?.url || info.pageUrl;
      if (!isHttpUrl(pageUrl)) return;
      dispatchDownload({
        url: pageUrl,
        referrer: pageUrl,
        isVideo: true
      }).catch(() => {});
    }
  });
}

// 2. Intercept Browser Downloads
const ACCELERATED_EXTENSIONS = new Set([
  'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz',
  'iso', 'exe', 'msi', 'apk', 'dmg', 'pkg', 'bin', 'deb', 'rpm',
  'mp4', 'mkv', 'webm', 'avi', 'mov', 'mp3', 'm4a', 'flac', 'wav',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'
]);

function shouldInterceptDownload(downloadItem) {
  if (!interceptEnabled) return false;
  const url = downloadItem.finalUrl || downloadItem.url;
  if (!isHttpUrl(url)) return false;

  try {
    const parsed = new URL(url);
    if (parsed.hostname === '127.0.0.1' && parsed.port === '49820') return false;
    const ext = parsed.pathname.split('.').pop()?.toLowerCase() || '';
    if (ACCELERATED_EXTENSIONS.has(ext)) return true;
  } catch {
    return false;
  }

  if (downloadItem.filename) {
    const fileExt = downloadItem.filename.split(/[/\\]/).pop()?.split('.').pop()?.toLowerCase() || '';
    if (ACCELERATED_EXTENSIONS.has(fileExt)) return true;
  }

  const mime = (downloadItem.mime || '').toLowerCase();
  if (
    mime.startsWith('video/') ||
    mime.startsWith('audio/') ||
    mime.includes('application/octet-stream') ||
    mime.includes('application/zip') ||
    mime.includes('application/x-')
  ) {
    return true;
  }

  return false;
}

if (chrome.downloads?.onCreated?.addListener) {
  chrome.downloads.onCreated.addListener((downloadItem) => {
    const url = downloadItem.finalUrl || downloadItem.url;
    if (!shouldInterceptDownload(downloadItem)) return;

    const baseFilename = downloadItem.filename
      ? downloadItem.filename.split(/[/\\]/).pop()
      : undefined;

    chrome.downloads.pause(downloadItem.id, () => {
      if (chrome.runtime.lastError) return;
      dispatchDownload({
        url,
        referrer: downloadItem.referrer || '',
        filename: baseFilename,
        size: downloadItem.fileSize > 0 ? downloadItem.fileSize : undefined
      })
        .then(() => {
          chrome.downloads.cancel(downloadItem.id, () => {
            try {
              chrome.downloads.erase?.({ id: downloadItem.id });
            } catch {}
          });
        })
        .catch(() => {
          chrome.downloads.resume(downloadItem.id);
        });
    });
  });
}

// 3. Media Stream Sniffer (filters out raw byte-range video chunks)
const MEDIA_MIME_PATTERNS = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'application/dash+xml',
  'video/mp4',
  'video/webm'
];

function isIgnoredChunkUrl(urlStr) {
  if (!urlStr) return true;
  const lower = urlStr.toLowerCase();
  if (
    lower.includes('googlevideo.com/videoplayback') ||
    lower.includes('range=') ||
    lower.includes('bytestart=') ||
    lower.includes('segment-') ||
    lower.includes('frag-') ||
    /\.(ts|m4s|aac|vtt|key)(\?|$)/i.test(lower)
  ) {
    return true;
  }
  return false;
}

if (chrome.webRequest?.onHeadersReceived?.addListener) {
  chrome.webRequest.onHeadersReceived.addListener((details) => {
    if (details.tabId < 0) return;
    if (isIgnoredChunkUrl(details.url)) return;

    const contentTypeHeader = details.responseHeaders?.find(
      h => h.name.toLowerCase() === 'content-type'
    );
    const contentLengthHeader = details.responseHeaders?.find(
      h => h.name.toLowerCase() === 'content-length'
    );
    const contentType = contentTypeHeader?.value?.toLowerCase() || '';
    const size = contentLengthHeader ? parseInt(contentLengthHeader.value, 10) : 0;

    const isManifest = details.url.includes('.m3u8') || details.url.includes('.mpd');
    const isMediaMime = MEDIA_MIME_PATTERNS.some(p => contentType.includes(p));

    if (!isManifest && !isMediaMime) return;
    // Ignore tiny video tracking clips (< 150 KB) unless they are HLS/DASH manifests
    if (!isManifest && size > 0 && size < 150 * 1024) return;

    if (!tabStreams.has(details.tabId)) {
      tabStreams.set(details.tabId, new Map());
    }
    const map = tabStreams.get(details.tabId);
    map.set(details.url, {
      url: details.url,
      mimeType: contentType,
      size: size > 0 ? size : null,
      detectedAt: Date.now()
    });

    try {
      chrome.tabs?.sendMessage?.(details.tabId, {
        action: 'CRAZY_VIDEO_STREAM_DETECTED',
        url: details.url,
        mimeType: contentType,
        size: size > 0 ? size : null
      }).catch(() => {});
    } catch {}
  }, { urls: ['<all_urls>'] }, ['responseHeaders']);
}

try {
  chrome.tabs?.onRemoved?.addListener((tabId) => {
    tabStreams.delete(tabId);
  });
} catch {}

// 4. Dual-transport Desktop Communication (HTTP + Native Messaging On-Demand Launch)
function sendViaNativeHost(payload) {
  return new Promise((resolve, reject) => {
    if (typeof chrome?.runtime?.sendNativeMessage !== 'function') {
      reject(new Error('Native messaging API unavailable'));
      return;
    }
    try {
      chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, payload, (response) => {
        const lastErr = chrome.runtime.lastError;
        if (lastErr) {
          reject(new Error(lastErr.message || 'Native messaging host error'));
          return;
        }
        if (!response || response.status === 'error') {
          reject(new Error(response?.message || 'Native host rejected request'));
          return;
        }
        resolve(response);
      });
    } catch (err) {
      reject(err);
    }
  });
}

async function sendToDesktop(endpointPath, payload, timeoutMs = 8000) {
  const extId = chrome.runtime?.id || '';
  try {
    const response = await fetch(`${IPC_BASE}${endpointPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Crazy-Extension-Version': EXTENSION_VERSION,
        ...(extId ? { 'X-Crazy-Extension-Id': extId } : {})
      },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ ...payload, extensionId: extId, extensionVersion: EXTENSION_VERSION })
    });
    const reply = await response.json();
    if (response.ok && reply.status !== 'error') {
      return reply;
    }
  } catch {
    // Desktop app is closed or unreachable on port 49820; launch on demand via Native Messaging Host
  }

  return await sendViaNativeHost({ ...payload, extensionId: extId, extensionVersion: EXTENSION_VERSION });
}

async function dispatchDownload(urlOrOptions, referrer = '', filename = undefined) {
  const opts = typeof urlOrOptions === 'string'
    ? { url: urlOrOptions, referrer, filename }
    : { ...urlOrOptions };

  if (!isHttpUrl(opts.url)) {
    throw new Error('Only HTTP and HTTPS URLs can be downloaded.');
  }

  const payload = {
    action: 'DOWNLOAD_REQUEST',
    url: opts.url,
    referrer: isHttpUrl(opts.referrer) ? opts.referrer : '',
    filename: opts.filename,
    formatId: opts.formatId || null,
    title: opts.title || null,
    size: opts.size || null,
    isVideo: Boolean(opts.isVideo),
    qualities: Array.isArray(opts.qualities) ? opts.qualities : undefined,
    headers: opts.headers || {}
  };

  const reply = await sendToDesktop('/api/downloads', payload, 8000);
  if (!reply || reply.received !== true || reply.url !== opts.url) {
    throw new Error(reply?.message || 'Crazy Downloader 2 did not acknowledge the download.');
  }
  return reply;
}

async function probeVideoForTab(message, tabId) {
  const detectedMap = tabId !== undefined && tabStreams.has(tabId)
    ? Array.from(tabStreams.get(tabId).values())
    : [];
  const mergedStreams = [...detectedMap, ...(Array.isArray(message.detectedStreams) ? message.detectedStreams : [])];

  const payload = {
    action: 'VIDEO_PROBE_REQUEST',
    url: message.url || message.pageUrl,
    pageUrl: message.pageUrl || message.url,
    headers: message.headers || {},
    detectedStreams: mergedStreams
  };

  return await sendToDesktop('/api/video/probe', payload, 90000);
}

if (chrome.runtime?.onMessage?.addListener) {
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message || !message.action) return false;

  if (message.action === 'CRAZY_TRIGGER_STREAM_DOWNLOAD') {
    dispatchDownload({
      url: message.url,
      referrer: message.referrer || sender?.tab?.url || '',
      filename: message.filename,
      formatId: message.formatId || null,
      title: message.title || null,
      size: message.size || null,
      isVideo: message.isVideo !== false,
      qualities: message.qualities
    }).then(
      (res) => respond({ ok: true, ...res }),
      (err) => respond({ ok: false, error: err.message })
    );
    return true;
  }

  if (message.action === 'CRAZY_PREFETCH_VIDEO') {
    const extId = chrome.runtime?.id || '';
    fetch(`${IPC_BASE}/api/video/prefetch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(extId ? { 'X-Crazy-Extension-Id': extId } : {})
      },
      signal: AbortSignal.timeout(3000),
      body: JSON.stringify({
        url: message.url || message.pageUrl,
        pageUrl: message.pageUrl || message.url,
        extensionId: extId
      })
    })
      .then(() => respond({ ok: true }))
      .catch(() => respond({ ok: false }));
    return true;
  }

  if (message.action === 'CRAZY_PROBE_VIDEO') {
    probeVideoForTab(message, sender?.tab?.id).then(
      (res) => respond({ ok: true, ...res }),
      (err) => respond({
        ok: false,
        supported: false,
        drmProtected: false,
        reason: 'HOST_UNREACHABLE',
        message: err.message
      })
    );
    return true;
  }

  if (message.action === 'CRAZY_PING_HOST') {
    fetch(`${IPC_BASE}/api/health`, {
      method: 'GET',
      headers: { 'X-Crazy-Extension-Version': EXTENSION_VERSION },
      signal: AbortSignal.timeout(800)
    })
      .then(r => r.json())
      .then(data => respond({ ok: true, daemonOnline: true, extensionVersion: EXTENSION_VERSION, ...data }))
      .catch(() => {
        sendViaNativeHost({ action: 'PING', extensionVersion: EXTENSION_VERSION })
          .then(res => respond({ ok: true, nativeHostReady: true, extensionVersion: EXTENSION_VERSION, ...res }))
          .catch(err => respond({ ok: false, daemonOnline: false, extensionVersion: EXTENSION_VERSION, error: err.message }));
      });
    return true;
  }

    return false;
  });
}
