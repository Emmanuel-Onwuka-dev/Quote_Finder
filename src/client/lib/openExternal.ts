// Open an external URL without window.open (preview sandboxes block it
// with ERR_BLOCKED_BY_RESPONSE): click a temporary anchor instead.

export function openExternal(url: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
