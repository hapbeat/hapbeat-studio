#!/usr/bin/env node
/**
 * i18n migration gate.  It intentionally targets only user-visible JSX:
 * visible JSX text and accessibility/tooltip attributes.  Comments,
 * identifiers, protocol values, class names, and data models are not UI copy.
 *
 * During the one-time migration use `--report`; CI uses the default and fails
 * until every violation is moved to `t('<stable.message.id>')`.
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const sourceRoot = path.resolve('src')
const reportOnly = process.argv.includes('--report')
const attrNames = new Set(['title', 'aria-label', 'placeholder', 'data-tip', 'alt'])
// English is the baseline vocabulary for technical terms such as firmware,
// Event ID, Wi-Fi, and CLI commands.  This gate protects the actual locale
// boundary: Japanese copy may not be rendered outside the message catalogue.
const localizedText = /[ぁ-んァ-ン一-龯]/
const ignored = new Set(['node_modules', 'dist', 'txman'])

function filesUnder(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (ignored.has(entry.name)) return []
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return filesUnder(full)
    return entry.isFile() && /\.tsx$/.test(entry.name) ? [full] : []
  })
}

function position(sourceFile, node) {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
  return `${path.relative(process.cwd(), sourceFile.fileName)}:${line + 1}:${character + 1}`
}

function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text
  return null
}

const violations = []
for (const filename of filesUnder(sourceRoot)) {
  const sourceFile = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const visit = (node) => {
    if (ts.isJsxText(node) && localizedText.test(node.text.trim())) {
      violations.push(`${position(sourceFile, node)} JSX text: ${node.text.trim().slice(0, 80)}`)
    }
    if (ts.isJsxAttribute(node) && attrNames.has(node.name.text) && node.initializer) {
      const initializer = ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer
      const text = initializer ? literalText(initializer) : null
      if (text && localizedText.test(text)) {
        violations.push(`${position(sourceFile, node)} ${node.name.text}: ${text.slice(0, 80)}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

if (violations.length) {
  console.error(`i18n: ${violations.length} raw localized UI strings found`)
  for (const violation of violations) console.error(violation)
  if (!reportOnly) process.exitCode = 1
} else {
  console.log('i18n: no raw localized JSX text or user-visible attributes found')
}
