const RETRY_MS = 200;

// Sends a message to the service worker. Retries every 200 ms on lastError
// (covers extension context not yet ready, SW starting up, etc.).
export function sendMessage(message) {
  return new Promise((resolve, reject) => {
    let attempts = 0;

    function attempt() {
      attempts++;
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          const errMsg = chrome.runtime.lastError.message ?? '';
          // "Extension context invalidated" means this content script's context is dead
          // (extension was reloaded). Retrying cannot help — surface the error immediately.
          if (errMsg.includes('Extension context invalidated')) {
            console.error(`[Stash] sendMessage: extension context invalidated (${message.type}) — page reload required`);
            reject(new Error(errMsg));
            return;
          }
          console.log(
            `[Stash] sendMessage retry #${attempts} (${message.type}):`,
            errMsg
          );
          setTimeout(attempt, RETRY_MS);
          return;
        }
        if (response?.error) {
          console.error(`[Stash] sendMessage error response (${message.type}):`, response.error);
          reject(new Error(response.error));
          return;
        }
        resolve(response);
      });
    }

    attempt();
  });
}
