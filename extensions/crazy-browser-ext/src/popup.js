function compareSemver(a, b) {
  const pa = String(a || '0.0.0').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '0.0.0').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

document.addEventListener('DOMContentLoaded', () => {
  const statusEl = document.getElementById('hostStatus');
  const toggleEl = document.getElementById('interceptToggle');
  const quickUrlEl = document.getElementById('quickUrl');
  const sendUrlBtn = document.getElementById('sendUrlBtn');
  const pageVideoBtn = document.getElementById('downloadPageVideoBtn');
  const extIdDisplay = document.getElementById('extIdDisplay');
  const noticeBox = document.getElementById('missingHostNotice');
  const noticeTitle = document.getElementById('noticeTitle');
  const noticeText = document.getElementById('noticeText');

  const extVersion = chrome.runtime.getManifest().version || '2.1.0';
  extIdDisplay.textContent = `Ext v${extVersion} | ID: ${chrome.runtime.id}`;

  chrome.storage.local.get(['interceptEnabled'], (res) => {
    toggleEl.checked = res.interceptEnabled !== false;
  });

  toggleEl.addEventListener('change', () => {
    chrome.storage.local.set({ interceptEnabled: toggleEl.checked });
  });

  chrome.runtime.sendMessage({ action: 'CRAZY_PING_HOST' }, (res) => {
    if (res && res.ok) {
      const desktopVer = res.version || '2.0.0';
      statusEl.textContent = res.daemonOnline ? `App v${desktopVer}` : `Ready (v${desktopVer})`;
      statusEl.className = 'status-badge online';
      extIdDisplay.textContent = `Ext v${extVersion} | Desktop v${desktopVer} | ID: ${chrome.runtime.id}`;

      if (res.minExtensionVersion && compareSemver(extVersion, res.minExtensionVersion) < 0) {
        noticeBox.className = 'notice-box warn';
        noticeBox.style.display = 'block';
        noticeTitle.textContent = 'Extension update recommended';
        noticeText.textContent = `Desktop v${desktopVer} recommends Browser Extension v${res.minExtensionVersion} or newer.`;
      } else if (compareSemver(desktopVer, '2.0.0') < 0) {
        noticeBox.className = 'notice-box warn';
        noticeBox.style.display = 'block';
        noticeTitle.textContent = 'Desktop update recommended';
        noticeText.textContent = `Extension v${extVersion} works best with Crazy Downloader 2 v2.1.0 or newer.`;
      }
    } else {
      statusEl.textContent = 'Host offline';
      statusEl.className = 'status-badge';
      noticeBox.className = 'notice-box';
      noticeBox.style.display = 'block';
    }
  });

  sendUrlBtn.addEventListener('click', () => {
    const url = quickUrlEl.value.trim();
    if (!url || !/^https?:\/\//i.test(url)) return;
    chrome.runtime.sendMessage({
      action: 'CRAZY_TRIGGER_STREAM_DOWNLOAD',
      url,
      isVideo: false
    }, () => {
      window.close();
    });
  });

  pageVideoBtn.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.url || !/^https?:\/\//i.test(tab.url)) return;
      chrome.runtime.sendMessage({
        action: 'CRAZY_TRIGGER_STREAM_DOWNLOAD',
        url: tab.url,
        referrer: tab.url,
        title: tab.title,
        isVideo: true
      }, () => {
        window.close();
      });
    });
  });
});

