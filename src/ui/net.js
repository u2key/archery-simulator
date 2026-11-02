// オンライン試合サーバーとの通信 (WebSocket)。切れたら自動で再接続する。
// サーバーなしで静的配信している場合は 'offline' のままで、プラクティスだけ使える。

/** タブごとの選手 ID。sessionStorage なのでリロードしても同じ選手として試合に戻れ、別タブは別の選手になる */
function playerId() {
  try {
    let id = sessionStorage.getItem('archery.playerId');
    if (!id) {
      id = crypto.randomUUID?.() ?? `p${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      sessionStorage.setItem('archery.playerId', id);
    }
    return id;
  } catch {
    return `p${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * @param {object} h
 * @param {(status:'connecting'|'online'|'offline') => void} h.onStatus
 * @param {(state:object) => void} h.onState
 * @param {(error:string) => void} h.onError
 * @param {() => string} h.getName
 */
export function connectMatchServer(h) {
  const id = playerId();
  const room = new URLSearchParams(location.search).get('room') || 'main';
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?room=${encodeURIComponent(room)}`;
  let ws = null, retry = 1000, closed = false;

  function open() {
    h.onStatus('connecting');
    try {
      ws = new WebSocket(url);
    } catch {
      h.onStatus('offline');
      return;
    }
    ws.onopen = () => {
      retry = 1000;
      ws.send(JSON.stringify({ type: 'hello', id, name: h.getName() }));
      h.onStatus('online');
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'state') h.onState(msg.state);
      else if (msg.type === 'error') h.onError(msg.error);
    };
    ws.onclose = (ev) => {
      h.onStatus('offline');
      // 同じ選手 ID で別の接続に置き換えられた場合は再接続しない
      if (closed || ev.code === 4000) return;
      setTimeout(open, retry);
      retry = Math.min(15000, retry * 2);
    };
  }
  open();

  const send = (msg) => {
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  };
  return {
    id,
    room,
    send,
    close() { closed = true; ws?.close(); },
  };
}
