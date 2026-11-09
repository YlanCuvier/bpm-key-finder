// Desktop app: serves the page from an app:// origin (so the analysis worker can load) and opens it in a window.
const { app, BrowserWindow, protocol, net, shell } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const file = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, '') || 'index.html';
    const full = path.normalize(path.join(__dirname, file));
    if (!full.startsWith(__dirname)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(full).toString());
  });

  const win = new BrowserWindow({
    width: 760, height: 900, minWidth: 380, backgroundColor: '#0f0f12', autoHideMenuBar: true,
    title: 'BPM & Key Finder', icon: path.join(__dirname, 'build', 'icon.png'),
  });
  // Song links (Apple Music) open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.loadURL('app://bkf/index.html');
});

app.on('window-all-closed', () => app.quit());
