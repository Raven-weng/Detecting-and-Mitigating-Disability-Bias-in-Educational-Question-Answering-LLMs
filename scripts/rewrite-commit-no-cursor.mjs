import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

process.chdir(repoRoot)

const tree = execSync('git show -s --format=%T HEAD', { encoding: 'utf8' }).trim()
const msgPath = path.join(repoRoot, '.git', 'COMMIT_MSG_CLEAN.txt')
const msg = fs.readFileSync(msgPath, 'utf8').replace(/\r\n/g, '\n')
const now = Math.floor(Date.now() / 1000)
const author = 'gengyuang5-lang <gengyuang5-lang@users.noreply.github.com>'
const authorLine = `${author} ${now} +0800`
const commitBody = `tree ${tree}
author ${authorLine}
committer ${authorLine}

${msg}`
const hash = execSync('git hash-object -t commit -w --stdin', {
  input: commitBody,
  encoding: 'utf8',
}).trim()
execSync(`git reset --hard ${hash}`, { stdio: 'inherit' })
console.log('New commit:', hash)
console.log(execSync('git cat-file -p HEAD', { encoding: 'utf8' }))
