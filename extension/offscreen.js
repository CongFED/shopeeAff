/**
 * Shopee Monitor - Offscreen Document (Persistent 10s Heartbeat Engine)
 * Runs 24/7 in background DOM context to prevent Chrome Service Worker sleep.
 */

let port = null;

function connectPort() {
  try {
    port = chrome.runtime.connect({ name: 'heartbeat_port' });
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connectPort, 1000);
    });
  } catch (e) {
    port = null;
    setTimeout(connectPort, 1000);
  }
}

connectPort();

// 10s Realtime Pulse Timer (Never sleeps, never paused by Chrome)
setInterval(() => {
  if (port) {
    try {
      port.postMessage({ action: 'heartbeat_tick' });
    } catch (e) {
      connectPort();
    }
  } else {
    connectPort();
  }
  chrome.runtime.sendMessage({ action: 'heartbeat_tick' }).catch(() => {});
}, 10000);
