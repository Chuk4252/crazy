// Crazy Downloader 2 - In-Page Video Overlay & Quality Selector

(() => {
  if (window.__crazyDownloaderContentLoaded) return;
  window.__crazyDownloaderContentLoaded = true;

  const detectedStreams = new Map(); // url -> { url, mimeType, size, qualityLabel, height }
  const probeCache = new Map(); // url -> { timestamp, result }

  let shadowHost = null;
  let shadowRoot = null;
  let overlayBtn = null;
  let popoverEl = null;
  let trackedVideo = null;
  let isPopoverOpen = false;
  let lastProbedUrl = '';
  let lastPrefetchedVideoId = '';
  let prefetchTimer = null;
  let activeProbeRequestId = 0;

  const SUPPORTED_PAGE_HOST_RE = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|twitch\.tv|tiktok\.com|twitter\.com|x\.com|reddit\.com|archive\.org|bilibili\.com|rumble\.com|streamable\.com|wikimedia\.org)$/i;

  function isSupportedSiteHost() {
    try {
      return SUPPORTED_PAGE_HOST_RE.test(location.hostname);
    } catch {
      return false;
    }
  }

  function extractYouTubeVideoId(urlStr = location.href) {
    try {
      const u = new URL(urlStr);
      if (u.hostname === 'youtu.be') {
        const id = u.pathname.slice(1).split('/')[0];
        return /^[\w-]{11}$/.test(id || '') ? id : null;
      }
      if (/(^|\.)youtube\.com$/i.test(u.hostname)) {
        const id = u.pathname === '/watch'
          ? u.searchParams.get('v')
          : /^\/(?:shorts|embed|live|v)\/([^/?#]+)/.exec(u.pathname)?.[1];
        return /^[\w-]{11}$/.test(id || '') ? id : null;
      }
    } catch {}
    return null;
  }

  function inferSafeExtension(urlStr, mimeType = '') {
    try {
      const u = new URL(urlStr);
      for (const param of ['filename', 'file', 'name', 'response-content-disposition']) {
        const val = u.searchParams.get(param) || '';
        const m = /\.([a-z0-9]{2,5})(?:["';\s]|$)/i.exec(val);
        if (m && ['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4a', 'mp3', 'ts'].includes(m[1].toLowerCase())) {
          return m[1].toLowerCase();
        }
      }
      const lastSeg = u.pathname.split('/').filter(Boolean).pop() || '';
      const dotIdx = lastSeg.lastIndexOf('.');
      if (dotIdx > 0) {
        const cand = lastSeg.slice(dotIdx + 1).toLowerCase();
        if (/^[a-z0-9]{2,5}$/.test(cand) && ['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4a', 'mp3', 'ts'].includes(cand)) {
          return cand;
        }
      }
    } catch {}

    const lowerMime = String(mimeType || '').toLowerCase();
    if (lowerMime.includes('webm')) return 'webm';
    if (lowerMime.includes('matroska') || lowerMime.includes('mkv')) return 'mkv';
    if (lowerMime.includes('mp2t')) return 'ts';
    if (lowerMime.includes('audio/mp4') || lowerMime.includes('m4a')) return 'm4a';
    if (lowerMime.includes('mpeg') && lowerMime.includes('audio')) return 'mp3';
    return 'mp4';
  }

  function extractYouTubeInPageQualities(expectedVideoId) {
    if (!expectedVideoId) return null;
    let bridgeReply = null;
    const listener = (ev) => {
      bridgeReply = ev.detail;
    };
    window.addEventListener('crazy-cd2-yt-response', listener, { once: true });
    try {
      window.dispatchEvent(new CustomEvent('crazy-cd2-yt-request', {
        detail: { expectedVideoId }
      }));
    } finally {
      window.removeEventListener('crazy-cd2-yt-response', listener);
    }

    if (!bridgeReply || !bridgeReply.ok || bridgeReply.videoId !== expectedVideoId) {
      return null;
    }

    if (bridgeReply.isLiveContent) {
      return {
        supported: false,
        drmProtected: false,
        reason: 'LIVE_UNSUPPORTED',
        message: 'Live broadcasts cannot be downloaded as static files.',
        qualities: []
      };
    }

    const rawFormats = Array.isArray(bridgeReply.formats) ? bridgeReply.formats : [];
    if (rawFormats.length === 0) {
      return null;
    }

    if (rawFormats.every(f => Array.isArray(f.drmFamilies) && f.drmFamilies.length > 0)) {
      return {
        supported: false,
        drmProtected: true,
        reason: 'DRM_PROTECTED',
        message: 'This video is protected by Digital Rights Management (DRM) and cannot be downloaded.',
        qualities: []
      };
    }

    const durationSec = Number(bridgeReply.lengthSeconds) || 0;
    const estimateBytes = (f) => {
      if (f.contentLength > 0) return f.contentLength;
      const dur = f.approxDurationMs > 0 ? f.approxDurationMs / 1000 : durationSec;
      if (f.bitrate > 0 && dur > 0) return Math.round((f.bitrate * dur) / 8);
      return 0;
    };

    const parseMime = (m) => {
      const str = String(m || '');
      const isAudio = str.startsWith('audio/');
      const isVideo = str.startsWith('video/');
      const isMp4 = str.includes('mp4');
      const codecsMatch = /codecs="([^"]+)"/i.exec(str);
      const codecs = codecsMatch ? codecsMatch[1] : '';
      const hasAvc1 = codecs.includes('avc1');
      const hasMp4a = codecs.includes('mp4a');
      return { isAudio, isVideo, isMp4, codecs, hasAvc1, hasMp4a };
    };

    const cleanFormats = rawFormats.filter(f => !(Array.isArray(f.drmFamilies) && f.drmFamilies.length > 0));
    const m4aAudios = cleanFormats
      .filter(f => {
        const m = parseMime(f.mimeType);
        return m.isAudio && m.isMp4;
      })
      .sort((a, b) => (a.itag === 140 ? -1 : b.itag === 140 ? 1 : (b.bitrate - a.bitrate)));

    const bestM4a = m4aAudios[0] || null;
    const bestM4aSize = bestM4a ? estimateBytes(bestM4a) : 0;

    const byHeight = new Map();
    for (const f of cleanFormats) {
      const m = parseMime(f.mimeType);
      if (!m.isVideo || !f.height) continue;
      if (!byHeight.has(f.height)) byHeight.set(f.height, []);
      byHeight.get(f.height).push({ ...f, _mime: m });
    }

    const qualities = [];
    const heights = Array.from(byHeight.keys()).sort((a, b) => b - a);
    for (const height of heights) {
      const group = byHeight.get(height);
      const progressiveMp4 = group
        .filter(f => f._mime.isMp4 && f._mime.hasMp4a)
        .sort((a, b) => b.bitrate - a.bitrate)[0];

      const adaptiveMp4 = group
        .filter(f => f._mime.isMp4 && !f._mime.hasMp4a)
        .sort((a, b) => {
          if (a._mime.hasAvc1 !== b._mime.hasAvc1) return a._mime.hasAvc1 ? -1 : 1;
          return b.bitrate - a.bitrate;
        })[0];

      const fallback = group.sort((a, b) => b.bitrate - a.bitrate)[0];
      const chosen = progressiveMp4 || adaptiveMp4 || fallback;
      if (!chosen) continue;

      const hasNativeAudio = chosen._mime.hasMp4a;
      const canMuxM4a = !hasNativeAudio && chosen._mime.isMp4 && bestM4a;
      const formatId = canMuxM4a ? `${chosen.itag}+${bestM4a.itag}` : String(chosen.itag);
      const vSize = estimateBytes(chosen);
      const totalSize = canMuxM4a && vSize > 0 ? vSize + bestM4aSize : vSize;
      const ext = chosen._mime.isMp4 ? 'mp4' : 'webm';
      const resTag = `${height}p`;

      qualities.push({
        id: formatId,
        formatId,
        videoFormatId: String(chosen.itag),
        audioFormatId: canMuxM4a ? String(bestM4a.itag) : null,
        label: resTag,
        quality: resTag,
        height,
        fps: chosen.fps || 30,
        ext,
        hasAudio: hasNativeAudio || Boolean(canMuxM4a),
        hasVideo: true,
        audioNote: hasNativeAudio ? 'Included' : (canMuxM4a ? 'AAC Audio' : 'Video'),
        size: totalSize
      });
    }

    if (bestM4a) {
      const kbps = bestM4a.bitrate ? Math.round(bestM4a.bitrate / 1000) : 128;
      qualities.push({
        id: String(bestM4a.itag),
        formatId: String(bestM4a.itag),
        videoFormatId: null,
        audioFormatId: String(bestM4a.itag),
        label: `Audio only (${kbps} kbps)`,
        quality: 'Audio Only',
        height: 0,
        ext: 'm4a',
        hasAudio: true,
        hasVideo: false,
        isAudioOnly: true,
        audioNote: 'Audio Only',
        size: bestM4aSize
      });
    }

    if (qualities.length === 0) return null;

    const canonicalUrl = `https://www.youtube.com/watch?v=${expectedVideoId}`;
    return {
      supported: true,
      drmProtected: false,
      youtube: true,
      videoId: expectedVideoId,
      title: bridgeReply.title || getCleanPageTitle(),
      pageUrl: canonicalUrl,
      source: 'in-page-player',
      qualities
    };
  }

  function scheduleYouTubePrefetch() {
    const videoId = extractYouTubeVideoId(location.href);
    if (!videoId || videoId === lastPrefetchedVideoId) return;
    if (prefetchTimer) clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(() => {
      const currentId = extractYouTubeVideoId(location.href);
      if (!currentId || currentId === lastPrefetchedVideoId) return;
      lastPrefetchedVideoId = currentId;
      const canonicalUrl = `https://www.youtube.com/watch?v=${currentId}`;
      try {
        chrome.runtime?.sendMessage?.({
          action: 'CRAZY_PREFETCH_VIDEO',
          url: canonicalUrl,
          pageUrl: canonicalUrl,
          videoId: currentId
        });
      } catch {}
    }, 650);
  }

  function formatBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function sanitizeFilename(name) {
    return String(name || 'video')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 140) || 'video';
  }

  function getCleanPageTitle() {
    return (document.title || 'video')
      .replace(/\s*-\s*YouTube$/i, '')
      .replace(/\s*\|\s*Vimeo$/i, '')
      .trim() || 'video';
  }

  chrome.runtime?.onMessage?.addListener((message) => {
    if (!message || !message.action) return;
    if (message.action === 'CRAZY_VIDEO_STREAM_DETECTED' && message.url) {
      detectedStreams.set(message.url, {
        url: message.url,
        mimeType: message.mimeType || '',
        size: message.size || null
      });
      scheduleScan();
    }
  });

  function ensureShadowUi() {
    if (shadowHost && document.documentElement.contains(shadowHost)) return;

    shadowHost = document.createElement('div');
    shadowHost.id = 'crazy-downloader-overlay-host';
    shadowHost.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;z-index:2147483646;pointer-events:none;';
    shadowRoot = shadowHost.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      * {
        box-sizing: border-box;
        font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, sans-serif;
      }
      .cd2-video-btn {
        position: fixed;
        pointer-events: auto;
        display: inline-flex;
        align-items: center;
        gap: 6px;
        height: 28px;
        padding: 0 10px;
        border-radius: 4px;
        background: rgba(18, 22, 28, 0.88);
        border: 1px solid rgba(59, 130, 246, 0.55);
        color: #e6edf3;
        font-size: 12px;
        font-weight: 600;
        line-height: 1;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.45);
         opacity: 0.88;
        transition: opacity 0.12s ease, background 0.12s ease, border-color 0.12s ease;
        user-select: none;
      }
      .cd2-video-btn:hover,
      .cd2-video-btn.active {
        opacity: 1;
        background: #181d25;
        border-color: #3b82f6;
      }
      .cd2-video-btn .cd2-mark {
        background: #2563eb;
        color: #ffffff;
        font-size: 10px;
        font-weight: 700;
        padding: 2px 4px;
        border-radius: 2px;
      }
      .cd2-popover {
        position: fixed;
        pointer-events: auto;
        width: 310px;
        background: #14181f;
        border: 1px solid #2b3545;
        border-radius: 5px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.65);
        color: #e6edf3;
        font-size: 12px;
        overflow: hidden;
      }
      .cd2-hidden {
        display: none !important;
      }
      .cd2-pop-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 11px;
        background: #1a2029;
        border-bottom: 1px solid #28313e;
        gap: 8px;
      }
      .cd2-pop-title {
        font-weight: 600;
        font-size: 12px;
        color: #e6edf3;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .cd2-pop-close {
        background: transparent;
        border: none;
        color: #8b949e;
        font-size: 15px;
        cursor: pointer;
        padding: 0 2px;
        line-height: 1;
      }
      .cd2-pop-close:hover {
        color: #ffffff;
      }
      .cd2-pop-body {
        max-height: 260px;
        overflow-y: auto;
        padding: 6px;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .cd2-quality-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        padding: 7px 9px;
        border-radius: 4px;
        border: 1px solid #242c38;
        background: #181d25;
        color: #e6edf3;
        text-align: left;
        cursor: pointer;
        transition: background 0.1s ease, border-color 0.1s ease;
      }
      .cd2-quality-item:hover {
        background: #212834;
        border-color: #3b82f6;
      }
      .cd2-q-left {
        display: flex;
        align-items: center;
        gap: 7px;
      }
      .cd2-q-badge {
        font-weight: 700;
        font-size: 11px;
        padding: 2px 6px;
        border-radius: 3px;
        background: rgba(37, 99, 235, 0.2);
        color: #60a5fa;
        border: 1px solid rgba(59, 130, 246, 0.35);
        font-variant-numeric: tabular-nums;
      }
      .cd2-q-meta {
        font-size: 11px;
        color: #8b949e;
      }
      .cd2-q-size {
        font-family: Consolas, "Courier New", monospace;
        font-size: 11px;
        color: #c9d1d9;
        font-variant-numeric: tabular-nums;
      }
      .cd2-notice {
        padding: 10px;
        border-radius: 4px;
        background: #1a2029;
        border: 1px solid #28313e;
        color: #c9d1d9;
        line-height: 1.45;
      }
      .cd2-notice.drm,
      .cd2-notice.unsupported {
        border-color: rgba(248, 81, 73, 0.4);
        background: rgba(185, 28, 28, 0.14);
      }
      .cd2-notice-title {
        font-weight: 600;
        margin-bottom: 4px;
        color: #f85149;
      }
    `;

    overlayBtn = document.createElement('button');
    overlayBtn.type = 'button';
    overlayBtn.className = 'cd2-video-btn cd2-hidden';
    overlayBtn.setAttribute('aria-label', 'Download video with Crazy Downloader 2');
    overlayBtn.innerHTML = `<span class="cd2-mark">CD2</span><span>Download video</span>`;

    popoverEl = document.createElement('div');
    popoverEl.className = 'cd2-popover cd2-hidden';
    popoverEl.innerHTML = `
      <div class="cd2-pop-header">
        <span class="cd2-pop-title" id="cd2PopTitle">Available video qualities</span>
        <button type="button" class="cd2-pop-close" id="cd2PopClose" title="Close">&times;</button>
      </div>
      <div class="cd2-pop-body" id="cd2PopBody"></div>
    `;

    shadowRoot.appendChild(style);
    shadowRoot.appendChild(overlayBtn);
    shadowRoot.appendChild(popoverEl);
    document.documentElement.appendChild(shadowHost);

    overlayBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePopover();
    });

    popoverEl.querySelector('#cd2PopClose').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      closePopover();
    });

    document.addEventListener('mousedown', (e) => {
      if (!isPopoverOpen) return;
      if (e.composedPath && e.composedPath().includes(shadowHost)) return;
      closePopover();
    }, true);
  }

  function findPrimaryVideoElement() {
    const videos = Array.from(document.querySelectorAll('video'));
    let best = null;
    let bestArea = 0;

    for (const v of videos) {
      const rect = v.getBoundingClientRect();
      if (rect.width < 180 || rect.height < 100) continue;
      const style = window.getComputedStyle(v);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) continue;
      const area = rect.width * rect.height;
      if (area > bestArea) {
        bestArea = area;
        best = v;
      }
    }
    return best;
  }

  function detectInPageDrm(video) {
    if (!video) return null;
    if (video.mediaKeys) {
      return 'This video uses browser Encrypted Media Extensions (EME / DRM) and cannot be downloaded.';
    }
    if (video.dataset?.drmProtected === 'true' || video.getAttribute('data-drm-protected') === 'true') {
      return video.getAttribute('data-drm-message') || 'This video is DRM-protected (Widevine / PlayReady / FairPlay) and cannot be saved.';
    }
    const drmMeta = document.querySelector('meta[name="drm-protected"][content="true"], [data-drm="widevine"], [data-drm="playready"]');
    if (drmMeta) {
      return 'This video stream is encrypted with Digital Rights Management (DRM) and cannot be downloaded.';
    }
    return null;
  }

  function detectInPageUnsupported(video) {
    if (!video) return null;
    if (video.dataset?.unsupportedVideo === 'true' || video.getAttribute('data-unsupported') === 'true') {
      return video.getAttribute('data-unsupported-message') || 'This video stream format is not supported for downloading.';
    }
    return null;
  }

  function collectDomVideoSources(video) {
    const list = [];
    for (const item of detectedStreams.values()) {
      list.push(item);
    }
    if (!video) return list;

    const sources = Array.from(video.querySelectorAll('source[src]'));
    for (const srcEl of sources) {
      const src = srcEl.src;
      if (!src || src.startsWith('blob:') || src.startsWith('data:')) continue;
      const label = srcEl.getAttribute('label') || srcEl.dataset?.quality || srcEl.getAttribute('res') || '';
      const height = parseInt(label, 10) || video.videoHeight || 720;
      list.push({
        url: src,
        mimeType: srcEl.type || 'video/mp4',
        qualityLabel: label || `${height}p`,
        height,
        title: getCleanPageTitle()
      });
    }

    const currentSrc = video.currentSrc || video.src;
    if (currentSrc && !currentSrc.startsWith('blob:') && !currentSrc.startsWith('data:')) {
      if (!list.some(x => x.url === currentSrc)) {
        const h = video.videoHeight || 720;
        list.push({
          url: currentSrc,
          mimeType: 'video/mp4',
          qualityLabel: `${h}p`,
          height: h,
          title: getCleanPageTitle()
        });
      }
    }

    return list;
  }

  function updateOverlayPosition() {
    ensureShadowUi();
    trackedVideo = findPrimaryVideoElement();

    if (!trackedVideo) {
      overlayBtn.classList.add('cd2-hidden');
      if (isPopoverOpen) closePopover();
      return;
    }

    trackedVideo.setAttribute('data-crazy-downloader-attached', 'true');
    const rect = trackedVideo.getBoundingClientRect();
    if (rect.bottom < 40 || rect.top > window.innerHeight - 40 || rect.right < 60 || rect.left > window.innerWidth - 60) {
      overlayBtn.classList.add('cd2-hidden');
      if (isPopoverOpen) closePopover();
      return;
    }

    overlayBtn.classList.remove('cd2-hidden');
    const top = Math.max(8, Math.round(rect.top + 10));
    const btnWidth = overlayBtn.offsetWidth || 132;
    const left = Math.max(8, Math.min(window.innerWidth - btnWidth - 10, Math.round(rect.right - btnWidth - 10)));

    overlayBtn.style.top = `${top}px`;
    overlayBtn.style.left = `${left}px`;

    if (isPopoverOpen) {
      const popWidth = 310;
      const popLeft = Math.max(8, Math.min(window.innerWidth - popWidth - 10, Math.round(rect.right - popWidth - 10)));
      const popTop = Math.min(window.innerHeight - 280, top + 34);
      popoverEl.style.top = `${popTop}px`;
      popoverEl.style.left = `${popLeft}px`;
    }
  }

  function closePopover() {
    isPopoverOpen = false;
    activeProbeRequestId++;
    if (overlayBtn) overlayBtn.classList.remove('active');
    if (popoverEl) popoverEl.classList.add('cd2-hidden');
  }

  async function togglePopover() {
    if (isPopoverOpen) {
      closePopover();
      return;
    }
    isPopoverOpen = true;
    overlayBtn.classList.add('active');
    popoverEl.classList.remove('cd2-hidden');
    updateOverlayPosition();
    await loadAndRenderQualities();
  }

  function renderNotice(type, heading, message, showRetry = false) {
    const body = popoverEl.querySelector('#cd2PopBody');
    body.innerHTML = `
      <div class="cd2-notice ${type}">
        <div class="cd2-notice-title">${heading}</div>
        <div>${message}</div>
        ${showRetry ? `<div style="margin-top:8px;display:flex;gap:6px;"><button type="button" id="cd2RetryProbeBtn" style="padding:4px 10px;border-radius:3px;border:1px solid #3b82f6;background:#2563eb;color:#fff;font-size:11px;font-weight:600;cursor:pointer;">Retry</button></div>` : ''}
      </div>
    `;
    const retryBtn = body.querySelector('#cd2RetryProbeBtn');
    if (retryBtn) {
      retryBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const ytId = extractYouTubeVideoId(location.href);
        const cacheKey = ytId ? `https://www.youtube.com/watch?v=${ytId}` : location.href;
        probeCache.delete(cacheKey);
        loadAndRenderQualities();
      });
    }
  }

  function renderQualitiesList(info) {
    const titleEl = popoverEl.querySelector('#cd2PopTitle');
    const body = popoverEl.querySelector('#cd2PopBody');
    const videoTitle = info.title || getCleanPageTitle();
    titleEl.textContent = videoTitle;
    body.innerHTML = '';

    for (const q of info.qualities) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cd2-quality-item';
      btn.setAttribute('data-format-id', q.formatId || 'best');
      btn.setAttribute('data-quality-label', q.label || '');

      const targetUrl = q.directUrl || info.pageUrl || location.href;
      const safeExt = /^[a-z0-9]{2,5}$/i.test(q.ext || '')
        ? q.ext.toLowerCase()
        : inferSafeExtension(targetUrl);

      const extLabel = safeExt.toUpperCase();
      const audioDesc = q.hasVideo === false
        ? 'Audio stream'
        : (q.hasAudio ? `${extLabel} with audio` : `${extLabel} video`);
      const sizeText = q.size ? formatBytes(q.size) : '';

      btn.innerHTML = `
        <div class="cd2-q-left">
          <span class="cd2-q-badge">${q.label}</span>
          <span class="cd2-q-meta">${audioDesc}</span>
        </div>
        <span class="cd2-q-size">${sizeText || 'Select'}</span>
      `;

      let clickInFlight = false;
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (clickInFlight) return;
        clickInFlight = true;

        const sizeSpan = btn.querySelector('.cd2-q-size');
        sizeSpan.textContent = 'Opening...';

        const safeName = sanitizeFilename(videoTitle);
        const filename = `${safeName} (${q.label}).${safeExt}`;
        const isDirectHttpVideo = q.formatId === 'direct' && Boolean(q.directUrl) && !/\.m3u8(\?|$)/i.test(q.directUrl);

        try {
          const reply = await chrome.runtime.sendMessage({
            action: 'CRAZY_TRIGGER_STREAM_DOWNLOAD',
            url: targetUrl,
            referrer: location.href,
            formatId: isDirectHttpVideo ? null : (q.formatId || 'best'),
            filename,
            title: videoTitle,
            size: q.size || null,
            isVideo: !isDirectHttpVideo,
            qualities: !isDirectHttpVideo ? info.qualities : undefined
          });

          if (reply && reply.ok) {
            sizeSpan.textContent = 'Opened dialog';
            setTimeout(() => closePopover(), 500);
          } else {
            clickInFlight = false;
            sizeSpan.textContent = 'Retry';
          }
        } catch {
          clickInFlight = false;
          sizeSpan.textContent = 'Retry';
        }
      });

      body.appendChild(btn);
    }
  }

  async function loadAndRenderQualities() {
    const reqId = ++activeProbeRequestId;
    const titleEl = popoverEl.querySelector('#cd2PopTitle');
    const body = popoverEl.querySelector('#cd2PopBody');
    titleEl.textContent = getCleanPageTitle();

    // 1. Check in-page DRM protection first
    const drmReason = detectInPageDrm(trackedVideo);
    if (drmReason) {
      renderNotice('drm', 'DRM-protected video', drmReason);
      return;
    }

    // 2. Check explicit in-page unsupported state
    const unsupportedReason = detectInPageUnsupported(trackedVideo);
    if (unsupportedReason) {
      renderNotice('unsupported', 'Unsupported video', unsupportedReason);
      return;
    }

    const domSources = collectDomVideoSources(trackedVideo);
    const pageUrl = location.href;
    const ytVideoId = extractYouTubeVideoId(pageUrl);
    const cacheKey = ytVideoId ? `https://www.youtube.com/watch?v=${ytVideoId}` : pageUrl;

    // 3. Fast path for YouTube: read current video's streamingData directly from in-page player (< 20ms)
    if (ytVideoId) {
      scheduleYouTubePrefetch();
      const inPageInfo = extractYouTubeInPageQualities(ytVideoId);
      if (inPageInfo) {
        probeCache.set(cacheKey, { timestamp: Date.now(), videoId: ytVideoId, result: inPageInfo });
        applyProbeResponse(inPageInfo);
        return;
      }
    }

    // 4. If this is a local/custom HTML5 video with explicit <source> or currentSrc on a non-extractor host,
    // list those available qualities immediately without waiting for yt-dlp.
    if (!isSupportedSiteHost() && domSources.length > 0 && !domSources.some(s => s.url.includes('.m3u8') || s.url.includes('.mpd'))) {
      const qualities = domSources.map((s, idx) => ({
        id: `dom-${idx}`,
        formatId: 'direct',
        label: s.qualityLabel || `${s.height || 720}p`,
        height: s.height || 720,
        ext: inferSafeExtension(s.url, s.mimeType),
        hasAudio: true,
        hasVideo: true,
        size: s.size || null,
        directUrl: s.url
      }));
      renderQualitiesList({
        supported: true,
        title: getCleanPageTitle(),
        pageUrl,
        qualities
      });
      return;
    }

    // 5. Check recent cache for this canonical video URL (bound to videoId on YouTube)
    const cached = probeCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 300000 && (!ytVideoId || cached.videoId === ytVideoId)) {
      applyProbeResponse(cached.result);
      return;
    }

    body.innerHTML = `
      <div class="cd2-notice">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
          <span>Checking available video qualities...</span>
          <button type="button" id="cd2CancelProbeBtn" style="padding:2px 8px;border-radius:3px;border:1px solid #28313e;background:#212834;color:#c9d1d9;font-size:11px;cursor:pointer;">Cancel</button>
        </div>
      </div>
    `;
    const cancelBtn = body.querySelector('#cd2CancelProbeBtn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closePopover();
      });
    }

    try {
      const reply = await chrome.runtime.sendMessage({
        action: 'CRAZY_PROBE_VIDEO',
        url: cacheKey,
        pageUrl,
        videoId: ytVideoId,
        detectedStreams: domSources
      });

      if (reqId !== activeProbeRequestId || !isPopoverOpen) return;

      if (reply && reply.supported) {
        probeCache.set(cacheKey, { timestamp: Date.now(), videoId: ytVideoId, result: reply });
      }
      applyProbeResponse(reply);
    } catch (err) {
      if (reqId !== activeProbeRequestId || !isPopoverOpen) return;
      renderNotice(
        'unsupported',
        'Desktop application required',
        err.message || 'Install and run Crazy Downloader 2 for Windows to inspect and download this video.',
        true
      );
    }
  }

  function applyProbeResponse(reply) {
    if (!reply) {
      renderNotice('unsupported', 'Unsupported video', 'No video information was returned.', true);
      return;
    }
    if (reply.reason === 'HOST_UNREACHABLE') {
      renderNotice(
        'unsupported',
        'Desktop application required',
        reply.message || 'Install and run Crazy Downloader 2 for Windows to enable video downloads.',
        true
      );
      return;
    }
    if (reply.drmProtected) {
      renderNotice(
        'drm',
        'DRM-protected video',
        reply.message || reply.reason || 'This video is encrypted with Digital Rights Management (DRM) and cannot be downloaded.'
      );
      return;
    }
    if (!reply.supported || !Array.isArray(reply.qualities) || reply.qualities.length === 0) {
      renderNotice(
        'unsupported',
        'Unsupported video',
        reply.message || reply.reason || 'No downloadable video streams were found for this video.',
        true
      );
      return;
    }
    renderQualitiesList(reply);
  }

  let scanScheduled = false;
  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    requestAnimationFrame(() => {
      scanScheduled = false;
      updateOverlayPosition();
      if (extractYouTubeVideoId(location.href)) {
        scheduleYouTubePrefetch();
      }
    });
  }

  const observer = new MutationObserver(() => {
    if (location.href !== lastProbedUrl) {
      lastProbedUrl = location.href;
      if (isPopoverOpen) closePopover();
    }
    scheduleScan();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  window.addEventListener('yt-navigate-finish', () => {
    if (isPopoverOpen) closePopover();
    scheduleScan();
  });
  window.addEventListener('popstate', () => {
    if (isPopoverOpen) closePopover();
    scheduleScan();
  });
  window.addEventListener('scroll', scheduleScan, { passive: true, capture: true });
  window.addEventListener('resize', scheduleScan, { passive: true });
  document.addEventListener('fullscreenchange', scheduleScan);
  setInterval(scheduleScan, 1200);
  scheduleScan();
})();
