/* 法语单词 App 的 Service Worker

   两种策略，按请求类型分开：

   1) 页面本身 → 网络优先。
      原来这里是「缓存优先」，结果是：只要 sw.js 没变，index.html 就永远从缓存里拿，
      改了内容也发不出去（踩过：搜索框和彩条上线了，手机上却一直是旧版）。
      现在先取网络，取不到（离线）再兜缓存，离线照样能用。

   2) audio/ 里的 mp3、图标 → 缓存优先。
      音频是**内容寻址**的：文件名就是朗读文本的哈希，内容改了文件名就变了，
      所以缓存优先不会拿到过期文件，而且听过一次就永久离线可用。

   ⚠ 音频必须处理 Range 请求：<audio> 拖进度条时浏览器发的是 Range 请求，
   而缓存里存的是整份文件。直接返回整份会让浏览器认为「不能跳转」
   （audio.seekable 为空），进度条就拖不动了。所以命中缓存时要按 Range 切出 206。
   （这个坑也踩过，见 slice() / fillAndSlice()。）

   想强制让所有人更新时，把下面的版本号改一下（v3 → v4）重新传。 */
const CACHE = "fr-vocab-v4";

const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-180.png"
];

// 预缓存外壳。带上 cache:"reload" 绕过 HTTP 缓存，保证拿到的是最新一份
async function precache(){
  const c = await caches.open(CACHE);
  await Promise.all(SHELL.map(async u => {
    try{
      const res = await fetch(u, { cache: "reload" });
      if(res && res.ok) await c.put(u, res);
    }catch(_){ /* 离线装不上就算了，用旧缓存顶 */ }
  }));
}

self.addEventListener("install", e => {
  e.waitUntil(precache().then(() => self.skipWaiting()).catch(() => self.skipWaiting()));
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

const isDoc = req =>
  req.mode === "navigate" || req.destination === "document" ||
  /(\/|index\.html)$/.test(new URL(req.url).pathname);

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;

  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== location.origin) return;   // 站外的一概不管

  const range = req.headers.get("range");

  e.respondWith(caches.open(CACHE).then(cache => {
    // ---- 页面：网络优先，断了才用缓存 ----
    if (isDoc(req)) {
      // cache:"no-cache" = 每次都向服务器验证一下（不新鲜才重新下载）。
      // GitHub Pages 给 index.html 的缓存是 10 分钟，不带这个的话
      // 刚发的新版可能十几分钟才看得到。
      return fetch(req, { cache: "no-cache" }).then(res => {
        if (res && res.ok) cache.put("./index.html", res.clone());
        return res;
      }).catch(() =>
        cache.match(req)
          .then(h => h || cache.match("./index.html"))
          .then(h => h || Response.error())
      );
    }

    // ---- 音频 / 图标：缓存优先 ----
    return cache.match(req).then(hit => {
      if (hit) return range ? slice(hit, range) : hit;
      return fillAndSlice(req, cache, range).catch(() => Response.error());
    });
  }));
});
