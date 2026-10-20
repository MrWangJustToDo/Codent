/**
 * Shiki adapter for `@git-diff-view`.
 *
 * The view receives a highlighter object and calls `getAST` + `processAST`; this pins that our
 * adapter loads Shiki, normalizes extension aliases, falls back to plain text for unknown
 * languages, and honors the ignore list. It is deliberately a runtime test: the failure modes are
 * a missing language (Shiki throws) or an AST shape `processAST` cannot consume, both invisible to
 * a type check.
 */

import assert from "node:assert/strict";

import { getDiffViewHighlighterSync, loadDiffViewHighlighter } from "../dist/utils/diff-highlighter.mjs";

const highlighter = await loadDiffViewHighlighter();

assert.equal(getDiffViewHighlighterSync(), highlighter, "the initialized adapter is available synchronously");

assert.equal(highlighter.name, "shiki");
assert.equal(highlighter.type, "class");
assert.equal(highlighter.hasRegisteredCurrentLang("ts"), true, "the ts alias resolves to typescript");
assert.equal(highlighter.hasRegisteredCurrentLang("c#"), true, "c# resolves to csharp");
assert.equal(highlighter.hasRegisteredCurrentLang("php"), true, "the common preload includes php");
assert.equal(highlighter.hasRegisteredCurrentLang("not-a-language"), false);

const parsed = highlighter.processAST(highlighter.getAST("const value: number = 1;", "a.ts", "ts"));
assert.equal(parsed.syntaxFileLineNumber, 1, "the HAST has one line");
assert.ok(parsed.syntaxFileObject[1].nodeList.length > 1, "the line is split into syntax tokens");

const fallback = highlighter.processAST(highlighter.getAST("just text", "a.unknown", "not-a-language"));
assert.equal(fallback.syntaxFileLineNumber, 1, "an unknown language falls back to text, not a throw");

highlighter.setIgnoreSyntaxHighlightList([/\.lock$/]);
assert.equal(highlighter.getAST("whatever", "package.lock", "json"), undefined, "the ignore list is honored");
highlighter.setIgnoreSyntaxHighlightList([]);

console.log("diff-highlighter validation passed");
