// Simulates a loaded libuv threadpool: every SHA-256 digest takes 30 ms.
const orig = crypto.subtle.digest.bind(crypto.subtle);
crypto.subtle.digest = async (...a) => { await new Promise(r => setTimeout(r, 30)); return orig(...a); };
