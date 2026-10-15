/* 法语单词 App 的 Service Worker
   策略：外壳（页面/图标）安装时预缓存；audio/ 里的 mp3 按需缓存 —— 听过一次就存在本地，
   之后断网也能听。三千多个 mp3 全部预缓存没必要也没那么快，所以走按需这条路。

   ⚠ 音频**必须**处理 Range 请求：<audio> 拖进度条时浏览器发的是 Range 请求，
   而 Cache 里存的是整份文件。如果直接把整份响应返回（忽略 Range），
   浏览器会认为这个音源「不能跳转」（audio.seekable 变成空），进度条就拖不动了。
   所以命中缓存时要按 Range 切出 206；缓存里没有时先取整份存下，再切。
   想强制更新时，把下面的版本号改一下（v2 → v3）重新传即可。 */
const CACHE = "fr-vocab-v2";

const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-180.png"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* 按 Range 从整份响应里切出 206 */
async function slice(resp, rangeHeader) {
  const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader || "");
  if (!m) return resp;
  const buf = await resp.clone().arrayBuffer();
  const total = buf.byteLength;
  let start = m[1] === "" ? 0 : parseInt(m[1], 10);
  let end = m[2] === "" ? total - 1 : parseInt(m[2], 10);
  if (isNaN(start) || start < 0) start = 0;
  if (isNaN(end) || end >= total) end = total - 1;
  if (start > end) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": "bytes */" + total }
    });
  }
  const chunk = buf.slice(start, end + 1);
  return new Response(chunk, {
    status: 206,
    statusText: "Partial Content",
    headers: {
      "Content-Type": resp.headers.get("Content-Type") || "audio/mpeg",
      "Content-Length": String(chunk.byteLength),
      "Content-Range": "bytes " + start + "-" + end + "/" + total,
      "Accept-Ranges": "bytes"
    }
  });
}

/* 缓存里没有：取整份存下来，再按 Range 切 */
async function fillAndSlice(req, cache, rangeHeader) {
  const full = await fetch(req.url, { credentials: "same-origin" });   // 故意不带 Range，要整份
  if (full && full.status === 200 && full.type === "basic") {
    await cache.put(req, full.clone());
  }
  return rangeHeader ? slice(full, rangeHeader) : full;
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== location.origin) return;   // 站外的一概不管

  const range = req.headers.get("range");

  e.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(req).then(hit => {
        if (hit) return range ? slice(hit, range) : hit;   // 有缓存：按需切片
        return fillAndSlice(req, cache, range).catch(() =>
          // 断网了：页面导航兜到 index.html，其它就返回错误
          req.mode === "navigate" ? caches.match("./index.html") : Response.error()
        );
      })
    )
  );
});
