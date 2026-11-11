// Crazy Downloader 2 - Main-World YouTube Player Metadata Bridge
// Reads already-loaded player response from #movie_player or window.ytInitialPlayerResponse
// so the quality selector opens immediately without waiting for an external process.

(() => {
  if (window.__crazyCd2YtBridgeInstalled) return;
  window.__crazyCd2YtBridgeInstalled = true;

  function getActivePlayerResponse(expectedVideoId) {
    try {
      const player = document.getElementById('movie_player');
      if (player && typeof player.getPlayerResponse === 'function') {
        const resp = player.getPlayerResponse();
        if (resp && resp.videoDetails && (!expectedVideoId || resp.videoDetails.videoId === expectedVideoId)) {
          return resp;
        }
      }
    } catch {}

    try {
      const initial = window.ytInitialPlayerResponse;
      if (initial && initial.videoDetails && (!expectedVideoId || initial.videoDetails.videoId === expectedVideoId)) {
        return initial;
      }
    } catch {}

    return null;
  }

  window.addEventListener('crazy-cd2-yt-request', (event) => {
    const expectedVideoId = event?.detail?.expectedVideoId || null;
    const resp = getActivePlayerResponse(expectedVideoId);

    if (!resp || !resp.videoDetails) {
      window.dispatchEvent(new CustomEvent('crazy-cd2-yt-response', {
        detail: { ok: false, expectedVideoId }
      }));
      return;
    }

    const vd = resp.videoDetails;
    const sd = resp.streamingData || {};
    const playability = resp.playabilityStatus || {};
    const rawFormats = [
      ...(Array.isArray(sd.formats) ? sd.formats : []),
      ...(Array.isArray(sd.adaptiveFormats) ? sd.adaptiveFormats : [])
    ];

    const sanitizedFormats = rawFormats.map(f => ({
      itag: f.itag,
      mimeType: f.mimeType || '',
      qualityLabel: f.qualityLabel || '',
      quality: f.quality || '',
      width: Number(f.width) || 0,
      height: Number(f.height) || 0,
      fps: Number(f.fps) || 0,
      bitrate: Number(f.averageBitrate || f.bitrate) || 0,
      contentLength: Number(f.contentLength) || 0,
      approxDurationMs: Number(f.approxDurationMs) || 0,
      audioQuality: f.audioQuality || null,
      audioSampleRate: f.audioSampleRate || null,
      drmFamilies: f.drmFamilies || null
    }));

    window.dispatchEvent(new CustomEvent('crazy-cd2-yt-response', {
      detail: {
        ok: true,
        videoId: vd.videoId || null,
        title: vd.title || '',
        lengthSeconds: Number(vd.lengthSeconds) || 0,
        isLiveContent: Boolean(vd.isLiveContent),
        playabilityStatus: playability.status || 'OK',
        playabilityReason: playability.reason || null,
        expiresInSeconds: Number(sd.expiresInSeconds) || 0,
        formats: sanitizedFormats
      }
    }));
  });
})();

