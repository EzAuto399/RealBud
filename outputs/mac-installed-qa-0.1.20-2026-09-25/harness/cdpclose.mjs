const v = await (await fetch('http://127.0.0.1:' + process.argv[2] + '/json/version')).json();
const ws = new WebSocket(v.webSocketDebuggerUrl);
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
ws.onmessage = m => { console.log(String(m.data).slice(0,200)); };
setTimeout(() => process.exit(0), 1500);
