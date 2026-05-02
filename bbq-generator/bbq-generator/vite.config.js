import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** 与本项目并列的 `newdataset_rwj/SBIC.v2`（解压 SBIC.v2.tgz 后的目录） */
const SBIC_LOCAL_DIR = path.resolve(__dirname, '../../SBIC.v2')

const SBIC_ALLOWED_FILES = new Set([
  'SBIC.v2.trn.csv',
  'SBIC.v2.dev.csv',
  'SBIC.v2.tst.csv',
  'SBIC.v2.agg.trn.csv',
  'SBIC.v2.agg.dev.csv',
  'SBIC.v2.agg.tst.csv',
])

function sbicLocalMiddleware() {
  return (req, res, next) => {
    const rawUrl = req.url ? req.url.split('?')[0] : ''
    if (!rawUrl.startsWith('/sbic/')) return next()
    const name = path.basename(decodeURIComponent(rawUrl.slice('/sbic/'.length)))
    if (!SBIC_ALLOWED_FILES.has(name)) {
      res.statusCode = 404
      res.end('Not found')
      return
    }
    const fp = path.join(SBIC_LOCAL_DIR, name)
    if (!fp.startsWith(SBIC_LOCAL_DIR)) return next()
    fs.stat(fp, (err, st) => {
      if (err || !st.isFile()) {
        res.statusCode = 404
        res.end(
          `SBIC 文件未找到: ${name}。请将数据集解压到 ${SBIC_LOCAL_DIR}（与 SBIC.v2.tgz 解压目录一致）。`,
        )
        return
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      fs.createReadStream(fp).pipe(res)
    })
  }
}

function sbicLocalPlugin() {
  return {
    name: 'sbic-local-csv',
    configureServer(server) {
      server.middlewares.use(sbicLocalMiddleware())
    },
    configurePreviewServer(server) {
      server.middlewares.use(sbicLocalMiddleware())
    },
    closeBundle() {
      const outDir = path.resolve(__dirname, 'dist/sbic')
      fs.mkdirSync(outDir, { recursive: true })
      for (const name of SBIC_ALLOWED_FILES) {
        const src = path.join(SBIC_LOCAL_DIR, name)
        if (!fs.existsSync(src)) continue
        fs.copyFileSync(src, path.join(outDir, name))
      }
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    sbicLocalPlugin(),
    react(),
    tailwindcss(),
  ],
})