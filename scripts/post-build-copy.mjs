/**
 * 将 newdataset_rwj 内其它静态资产拷入 Vite 的 dist/project，便于整仓随主站一起部署。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const dist = path.join(root, 'bbq-generator', 'bbq-generator', 'dist')
const projectDir = path.join(dist, 'project')

if (!fs.existsSync(dist)) {
  console.error('post-build-copy: dist 不存在，请先成功执行 vite build')
  process.exit(1)
}

fs.mkdirSync(projectDir, { recursive: true })

function copyFile(relFrom, relTo) {
  const src = path.join(root, relFrom)
  const dest = path.join(projectDir, relTo)
  if (!fs.existsSync(src)) {
    console.warn('post-build-copy: 跳过（不存在）', relFrom)
    return
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.copyFileSync(src, dest)
  console.log('post-build-copy:', relFrom, '->', relTo)
}

function copyDir(relFrom, relTo) {
  const src = path.join(root, relFrom)
  const dest = path.join(projectDir, relTo)
  if (!fs.existsSync(src)) {
    console.warn('post-build-copy: 跳过目录（不存在）', relFrom)
    return
  }
  fs.cpSync(src, dest, { recursive: true })
  console.log('post-build-copy: 目录', relFrom, '->', relTo)
}

copyFile('BBQ_cleaned.jsonl', 'BBQ_cleaned.jsonl')
copyFile('清洗字段.ipynb', '清洗字段.ipynb')
for (const f of ['SBIC.v2.tst.csv', 'SBIC.v2.agg.dev.csv']) {
  copyFile(f, f)
}

copyDir('bbq_cleaned_experiment_results', 'bbq_cleaned_experiment_results')
copyDir('SBIC.v2', 'SBIC.v2')

fs.writeFileSync(
  path.join(projectDir, 'README.txt'),
  [
    'newdataset_rwj — 随站点部署的静态副本',
    '',
    'BBQ 生成器（主应用）: /',
    'SBIC CSV（由构建写入）: /sbic/*.csv',
    '本目录其它数据与实验 JSON: /project/',
    '',
  ].join('\n'),
  'utf8',
)

console.log('post-build-copy: 完成 →', projectDir)
