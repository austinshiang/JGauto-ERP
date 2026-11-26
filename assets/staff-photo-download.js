/* ERP Staff Photo Download v4.15.0
 * 電腦：一鍵直連 Google Drive 下載（不經 Apps Script、不轉 base64）。
 *       若瀏覽器沒開始下載，可點「改用備援下載」走原本的 Apps Script 橋接（PublicPhotoBridge V4.11）。
 * 手機：長按大圖＝瀏覽器原生「儲存圖片」，本程式不攔截。
 * 不做 ZIP、不用 window.open。瀏覽器的多檔下載許可提示仍由瀏覽器決定。
 */
(function () {
  'use strict';
  if (window.ERP_PHOTO_DOWNLOAD) return;
  const USE_DIRECT = true;               // false = 一律使用 Apps Script 橋接
  const MOBILE = window.matchMedia('(pointer: coarse)').matches;
  const MAX_CONCURRENT = 3, MAX_BATCH = 80, DIRECT_GAP_MS = 400, MAX_BASE64_CHARS = 9 * 1024 * 1024;
  const MIME_EXT = Object.freeze({'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif'});
  const BUTTONS = ['download-current-photo', 'download-all-photos'];
  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let busy = false, extraAction = null;

  /* ---------- UI helpers ---------- */
  const bar = () => document.querySelector('.erp46-download-bar');
  function status(message, done, total) {
    const msg = $('photo-download-status'); if (msg) msg.textContent = message;
    const host = bar(); if (!host) return;
    let p = $('erp415-progress');
    if (!p) { p = document.createElement('progress'); p.id = 'erp415-progress'; host.appendChild(p); }
    p.max = Math.max(1, Number(total) || 1); p.value = Math.max(0, Number(done) || 0);
  }
  function setExtra(label, action) {
    const host = bar(); if (!host) return;
    let b = $('erp415-extra');
    if (!b) { b = document.createElement('button'); b.type = 'button'; b.id = 'erp415-extra'; b.className = 'btn-lite'; host.appendChild(b); }
    b.textContent = label; extraAction = action;
  }
  function clearExtra() { extraAction = null; $('erp415-extra')?.remove(); }
  function setBusy(v) { busy = v; BUTTONS.forEach(id => { if ($(id)) $(id).disabled = v; }); }

  /* ---------- photo list ---------- */
  function photoUrls() {
    const thumbs = Array.from(document.querySelectorAll('#thumbs [data-photo] img'));
    const urls = thumbs.length ? thumbs.map(i => i.getAttribute('src')) : [$('featured-img')?.getAttribute('src')];
    return urls.filter(Boolean).slice(0, MAX_BATCH);
  }
  function photoIndex() {
    const sel = document.querySelector('#thumbs [data-photo].selected');
    return Math.max(0, Number(sel?.getAttribute('data-photo') || 0) || 0);
  }
  function driveId(url) {
    const m = String(url || '').match(/(?:[?&]id=|\/file\/d\/|\/d\/)([a-zA-Z0-9_-]{20,})/);
    return m ? m[1] : '';
  }

  /* ---------- fast path: direct Drive download via hidden iframe ---------- */
  function directSave(id) {
    const f = document.createElement('iframe');
    f.hidden = true; f.setAttribute('aria-hidden', 'true');
    f.src = 'https://drive.google.com/uc?export=download&id=' + encodeURIComponent(id);
    document.body.appendChild(f);
    setTimeout(() => f.remove(), 120000);
  }

  /* ---------- fallback: Apps Script bridge (same validation as V4.14) ---------- */
  function validBridgeOrigin(origin) {
    try {
      const u = new URL(origin);
      return u.protocol === 'https:' && (u.hostname === 'script.google.com' || u.hostname.endsWith('.googleusercontent.com'));
    } catch (_) { return false; }
  }
  function bridgeRequest(photoUrl) {
    const id = driveId(photoUrl);
    if (!id) return Promise.reject(Error('照片網址無法解析 Drive 檔案 ID'));
    let address;
    try {
      address = new URL(String(window.ERP_SITE?.ADMIN_URL || ''));
      if (address.protocol !== 'https:' || address.hostname !== 'script.google.com' ||
          !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(address.pathname)) throw Error();
    } catch (_) { return Promise.reject(Error('後台 Apps Script 網址未正確設定')); }
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), v => v.toString(16).padStart(2, '0')).join('');
    address.searchParams.set('staffPhotoBridge', '1');
    address.searchParams.set('photoId', id); address.searchParams.set('nonce', nonce);
    return new Promise((resolve, reject) => {
      const frame = document.createElement('iframe');
      frame.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;opacity:0;border:0;pointer-events:none';
      frame.setAttribute('aria-hidden', 'true'); frame.tabIndex = -1;
      let settled = false;
      const timer = setTimeout(() => end(Error('讀取逾時；請確認 PublicPhotoBridge 已部署且照片為公開狀態')), 35000);
      function end(error, data) {
        if (settled) return; settled = true; clearTimeout(timer);
        window.removeEventListener('message', onMessage); frame.remove();
        error ? reject(error) : resolve(data);
      }
      function onMessage(ev) {
        if (ev.source !== frame.contentWindow || !validBridgeOrigin(ev.origin)) return;
        const d = ev.data;
        if (!d || d.type !== 'ERP_PUBLIC_PHOTO_V411' || d.nonce !== nonce) return;
        if (!d.ok) return end(Error(String(d.error || '後端拒絕下載')));
        const b64 = String(d.base64 || '');
        if (!Object.hasOwn(MIME_EXT, String(d.mime || '')) || b64.length < 4 || b64.length > MAX_BASE64_CHARS ||
            !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return end(Error('傳回的圖片格式或大小不符合要求'));
        end(null, d);
      }
      window.addEventListener('message', onMessage);
      frame.src = address.href; document.body.appendChild(frame);
    });
  }
  function savePhoto(result, position) {
    const raw = Uint8Array.from(atob(result.base64), c => c.charCodeAt(0));
    const cleaned = String(result.filename || '').trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 160);
    const name = /\.(jpe?g|png|webp|gif)$/i.test(cleaned)
      ? cleaned : `照片_${String(position + 1).padStart(2, '0')}.${MIME_EXT[result.mime]}`;
    const url = URL.createObjectURL(new Blob([raw], {type: result.mime}));
    const a = document.createElement('a'); a.href = url; a.download = name; a.hidden = true;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  async function viaBridge(items) {
    let cursor = 0, attempted = 0, last = null; const fails = [];
    status(`正在讀取 0 / ${items.length} 張照片…`, 0, items.length);
    const worker = async () => {
      while (cursor < items.length) {
        const p = items[cursor++];
        try { const result = await bridgeRequest(p.url); last = {result, position: p.position}; savePhoto(result, p.position); }
        catch (e) { fails.push(`第 ${p.position + 1} 張：${e?.message || e}`); }
        attempted++;
        status(`已送出 ${attempted} / ${items.length} 張下載請求${fails.length ? `（${fails.length} 張失敗）` : ''}`, attempted, items.length);
      }
    };
    await Promise.all(Array.from({length: Math.min(MOBILE ? 1 : MAX_CONCURRENT, items.length)}, worker));
    status(fails.length ? `有 ${fails.length} 張失敗：${fails.slice(0, 2).join('；')}`
      : `已送出 ${attempted} 張下載請求；請查看瀏覽器下載清單${items.length > 1 ? '並允許多檔下載' : ''}`, attempted, items.length);
    if (MOBILE && last) setExtra('若沒有下載，點此儲存照片', () => savePhoto(last.result, last.position));
  }

  /* ---------- main entry ---------- */
  async function download(mode, forceBridge) {
    if (busy) { status('照片正在下載，請稍候', 0, 1); return; }
    const urls = photoUrls(), cur = photoIndex();
    const items = (mode === 'all' && !MOBILE ? urls.map((url, position) => ({url, position})) : [{url: urls[cur], position: cur}])
      .filter(x => x.url);
    if (!items.length) { status('這台車沒有可下載的照片', 0, 1); return; }
    clearExtra(); setBusy(true);
    try {
      if (USE_DIRECT && !forceBridge) {
        // 第一張必須在使用者點擊的同一個同步流程內送出，瀏覽器才不會擋下載。
        const drive = items.filter(x => driveId(x.url));
        for (let i = 0; i < drive.length; i++) {
          directSave(driveId(drive[i].url));
          status(`已送出 ${i + 1} / ${drive.length} 張下載請求`, i + 1, drive.length);
          if (i < drive.length - 1) await sleep(DIRECT_GAP_MS);
        }
        const skipped = items.length - drive.length;
        status(drive.length
          ? `已送出 ${drive.length} 張下載請求${skipped ? `（${skipped} 張非 Drive 照片已略過）` : ''}；請查看瀏覽器下載清單${drive.length > 1 ? '並允許多檔下載' : ''}。`
          : '這些照片不是 Google Drive 檔案，無法直接下載', drive.length, drive.length || 1);
        if (drive.length) setExtra('沒有開始下載？改用備援下載', () => download(mode, true));
      } else await viaBridge(items);
    } finally { setBusy(false); }
  }

  document.addEventListener('click', ev => {
    const b = ev.target?.closest?.('#download-current-photo,#download-all-photos,#erp415-extra');
    if (!b) return;
    ev.preventDefault(); ev.stopImmediatePropagation();
    if (b.id === 'erp415-extra') { extraAction?.(); return; }
    void download(b.id === 'download-all-photos' && !MOBILE ? 'all' : 'one');
  }, true);

  window.ERP_PHOTO_DOWNLOAD = Object.freeze({version: '4.15.0', downloadOne: () => download('one'), downloadAll: () => download('all')});
})();
