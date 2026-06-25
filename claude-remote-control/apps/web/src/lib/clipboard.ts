/**
 * Clipboard helpers with HTTP (non-secure-context) fallbacks.
 *
 * The async Clipboard API (navigator.clipboard) only exists in a secure
 * context: HTTPS or localhost. When the web app is served over plain HTTP on
 * a LAN IP (see scripts/start-web.sh, which binds 0.0.0.0), the API is absent,
 * so navigator.clipboard is undefined and writeText/readText throw. These
 * helpers degrade gracefully so copy/paste still work over LAN HTTP.
 */

/**
 * Writes text to the clipboard.
 *
 * Prefers the async Clipboard API (HTTPS / localhost). Falls back to the
 * legacy hidden-textarea + execCommand('copy') trick over plain HTTP — it is
 * deprecated but still supported in every browser and is the only option in a
 * non-secure context.
 *
 * @returns true if the copy succeeded, false otherwise.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  if (!text) return false;

  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied / document not focused — fall through to legacy path.
    }
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // Keep off-screen and non-disruptive, but in the DOM + focusable so the
    // selection + execCommand('copy') actually capture the value.
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.width = '1px';
    ta.style.height = '1px';
    ta.style.padding = '0';
    ta.style.border = 'none';
    ta.style.outline = 'none';
    ta.style.boxShadow = 'none';
    ta.style.background = 'transparent';
    ta.style.opacity = '0';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Reads text from the clipboard.
 *
 * There is NO execCommand fallback for reading — browsers block
 * execCommand('paste') for security. Over plain HTTP this returns null and the
 * caller must fall back to a native paste field (see PasteBox), where the user
 * triggers the OS paste action manually.
 *
 * @returns the clipboard text, or null if unavailable / denied.
 */
export async function readClipboard(): Promise<string | null> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      return await navigator.clipboard.readText();
    } catch {
      // Permission denied / not supported — caller falls back to PasteBox.
    }
  }
  return null;
}
