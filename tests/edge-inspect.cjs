const fs = require('fs');

(async () => {
  try {
    const list = await (await fetch('http://127.0.0.1:9475/json/list')).json();
    console.log('targets', list.map((t) => ({ url: t.url, title: t.title })));
    const target = list.find((t) => t.type === 'page');
    if (!target) return;

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('open timeout')), 5000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => reject(new Error('ws error'));
    });
    console.log('opened');

    let id = 0;
    const pending = new Map();
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
        else entry.resolve(message.result);
      }
    };
    const send = (method, params = {}) => {
      const messageId = ++id;
      ws.send(JSON.stringify({ id: messageId, method, params }));
      return new Promise((resolve, reject) => pending.set(messageId, { resolve, reject }));
    };

    await send('Runtime.enable');
    await send('Page.enable');
    const result = await send('Runtime.evaluate', {
      expression: 'JSON.stringify({href: location.href, title: document.title, text: (document.body && document.body.innerText || "").slice(0, 300), html: document.documentElement.outerHTML.slice(0, 200)})',
      returnByValue: true
    });
    console.log('eval', result.result && result.result.value);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('dist/SnakeArena-Windows/blank.png', Buffer.from(shot.data, 'base64'));
    console.log('shot saved');
    process.exit(0);
  } catch (error) {
    console.error('ERR', error);
    process.exit(1);
  }
})();
