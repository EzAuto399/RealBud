/** Packaged RealBud may only hand https URLs to the OS browser. */
function isHttpsUrl(url) {
  if (typeof url !== "string" || url.length === 0 || url.length > 2048) return false;
  if (!url.startsWith("https://")) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

async function openHttpsExternal(opener, url) {
  if (!isHttpsUrl(url) || typeof opener?.openExternal !== "function") return false;
  try {
    await opener.openExternal(url);
    return true;
  } catch {
    return false;
  }
}

module.exports = { isHttpsUrl, openHttpsExternal };
