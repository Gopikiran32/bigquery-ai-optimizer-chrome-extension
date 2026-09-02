// Minimal service worker.
//
// Its only job is opening the options page on request. Content scripts cannot
// call chrome.runtime.openOptionsPage() themselves, and Chrome blocks web
// pages from navigating to chrome-extension:// URLs — so the panel's
// "Open settings" links have to round-trip through here.

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === 'open-options') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
  }
  return false;
});

// Open the options page automatically on first install, so a new user lands
// straight on the one screen they have to fill in.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});
