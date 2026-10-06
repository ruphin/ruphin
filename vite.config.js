import { defineConfig } from 'vite';
import * as sass from 'sass';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// This site is a Polymer 1 app built on HTML imports, which Vite cannot bundle.
// Vite processes index.html, and the plugin below serves the rest of the app
// (elements, vendor libraries) as plain static files, the way the old gulp
// setup did, including generating the `<name>-style.html` modules from SCSS.

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(ROOT, 'app');

// URL prefix `/vendor/<name>/` -> directory on disk.
// Polymer 1 and its elements were only published to bower, so their runtime
// files are committed in `vendor/`. The rest comes from npm.
const VENDOR = {
  webcomponentsjs: path.join(ROOT, 'node_modules/webcomponents.js'),
  autotrack: path.join(ROOT, 'node_modules/autotrack'),
  polymer: path.join(ROOT, 'vendor/polymer'),
  'app-route': path.join(ROOT, 'vendor/app-route'),
  'iron-location': path.join(ROOT, 'vendor/iron-location'),
};

// Only these vendor files are needed at runtime and copied into the build.
const VENDOR_BUILD_FILES = [
  'webcomponentsjs/webcomponents-lite.min.js',
  'autotrack/autotrack.js',
  'autotrack/autotrack.js.map',
  'polymer/polymer.html',
  'polymer/polymer-mini.html',
  'polymer/polymer-micro.html',
  'app-route/app-location.html',
  'app-route/app-route.html',
  'app-route/app-route-converter.html',
  'app-route/app-route-converter-behavior.html',
  'iron-location/iron-location.html',
  'iron-location/iron-query-params.html',
];

// Static directories inside `app/` that are copied verbatim into the build.
const STATIC_DIRS = ['elements', 'images', 'fonts'];

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

// Compile `<element>.scss` into a Polymer style module `<element>-style`.
function compileStyleModule(scssFile) {
  const css = sass.compile(scssFile, {
    style: 'compressed',
    loadPaths: [path.dirname(scssFile)],
  }).css;
  const id = path.basename(scssFile, '.scss') + '-style';
  return `<dom-module id="${id}"><template><style>${css}</style></template></dom-module>`;
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function resolveVendor(urlPath) {
  const match = urlPath.match(/^\/vendor\/([^/]+)\/(.+)$/);
  if (!match || !VENDOR[match[1]]) return null;
  const base = VENDOR[match[1]];
  const file = path.normalize(path.join(base, match[2]));
  return file.startsWith(base + path.sep) ? file : null;
}

function polymerLegacy() {
  // Keep HTML imports (`<link rel="import">`) out of Vite's asset pipeline:
  // hide their href before Vite parses index.html and restore it afterwards.
  const hideImports = {
    name: 'polymer-legacy:hide-imports',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => html.replace(/(<link\s+rel="import"\s+)href=/g, '$1data-import-href='),
    },
  };

  return [hideImports, {
    name: 'polymer-legacy',

    transformIndexHtml: {
      order: 'post',
      handler: (html) => html.replace(/(<link\s+rel="import"\s+)data-import-href=/g, '$1href='),
    },

    configureServer(server) {
      // Registered directly (not in a returned function) so it runs before
      // Vite's own middlewares and the HTML-import files are served untouched.
      server.middlewares.use((req, res, next) => {
        const urlPath = decodeURIComponent(req.url.split('?')[0]);
        try {
          if (urlPath.startsWith('/vendor/')) {
            const file = resolveVendor(urlPath);
            if (file && fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
              return send(res, file, fs.readFileSync(file));
            }
            res.statusCode = 404;
            return res.end();
          }
          if (urlPath.startsWith('/elements/')) {
            const file = path.normalize(path.join(APP, urlPath));
            if (!file.startsWith(path.join(APP, 'elements') + path.sep)) return next();
            const scss = file.replace(/-style\.html$/, '.scss');
            if (file.endsWith('-style.html') && fs.existsSync(scss)) {
              return send(res, file, compileStyleModule(scss));
            }
            if (fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
              return send(res, file, fs.readFileSync(file));
            }
          }
        } catch (err) {
          return next(err);
        }
        next();
      });

      // Full reload when element sources or styles change.
      server.watcher.add([path.join(APP, 'elements'), path.join(ROOT, 'vendor')]);
      server.watcher.on('change', (file) => {
        if (file.startsWith(path.join(APP, 'elements'))) {
          server.ws.send({ type: 'full-reload' });
        }
      });
    },

    generateBundle() {
      const emit = (fileName, source) => this.emitFile({ type: 'asset', fileName, source });

      for (const dir of STATIC_DIRS) {
        for (const file of walk(path.join(APP, dir))) {
          const rel = path.relative(APP, file).split(path.sep).join('/');
          if (file.endsWith('.scss')) {
            emit(rel.replace(/\.scss$/, '-style.html'), compileStyleModule(file));
          } else {
            emit(rel, fs.readFileSync(file));
          }
        }
      }

      // Root-level files other than index.html (e.g. Google site verification).
      for (const entry of fs.readdirSync(APP, { withFileTypes: true })) {
        if (entry.isFile() && entry.name !== 'index.html') {
          emit(entry.name, fs.readFileSync(path.join(APP, entry.name)));
        }
      }

      for (const rel of VENDOR_BUILD_FILES) {
        emit(`vendor/${rel}`, fs.readFileSync(resolveVendor(`/vendor/${rel}`)));
      }
    },
  }];
}

function send(res, file, body) {
  res.setHeader('Content-Type', CONTENT_TYPES[path.extname(file)] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.end(body);
}

export default defineConfig({
  root: APP,
  publicDir: false,
  plugins: [polymerLegacy()],
  server: {
    port: 5000,
  },
  build: {
    outDir: path.join(ROOT, 'dist'),
    emptyOutDir: true,
  },
});
