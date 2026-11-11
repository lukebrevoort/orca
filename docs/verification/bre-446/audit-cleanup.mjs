import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const base = process.argv[2] ?? "9ec3ca31afecc28a4af2bf8b40c48a5f1fb9a311";
const candidate = process.argv[3] ?? "01f6909ee534177a4fbaf486c29b06d7e7ba55e2";
for (const revision of [base, candidate]) {
  assert.match(revision, /^[a-f0-9]{40}$/, "Pass immutable full commit SHAs");
}
const cwd = fileURLToPath(new URL("../../../", import.meta.url));
const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
const sourcePath = "apps/api/src/index.ts";
const before = ts.createSourceFile(sourcePath, git("show", `${base}:${sourcePath}`), ts.ScriptTarget.Latest, true);
const after = ts.createSourceFile(sourcePath, git("show", `${candidate}:${sourcePath}`), ts.ScriptTarget.Latest, true);
const functions = new Set(["transportError", "updateCollectionRecord", "updatePinRecord", "validatePinTarget", "organizationConflict"]);
const removed = new Set([...functions, "CollectionRecord", "OrganizationTargetError"]);
const identifiers = (source) => {
  const counts = new Map();
  const visit = (node) => {
    if (ts.isIdentifier(node)) counts.set(node.text, (counts.get(node.text) ?? 0) + 1);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return counts;
};
const beforeIds = identifiers(before);
const afterIds = identifiers(after);
for (const node of before.statements) {
  if (ts.isFunctionDeclaration(node) && node.name && functions.has(node.name.text)) {
    assert.ok(!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword), `${node.name.text} must remain private`);
  }
}
for (const name of functions) assert.equal(beforeIds.get(name), 1, `${name} must have only its private declaration`);
for (const name of [...removed, "pinFilterSchema"]) assert.equal(afterIds.get(name) ?? 0, 0, `${name} must be absent after cleanup`);

const retained = before.statements.filter((node) => {
  const declaration = ts.isFunctionDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isClassDeclaration(node);
  return !(declaration && node.name && removed.has(node.name.text));
});
const normalizeImport = (node) => {
  if (!ts.isImportDeclaration(node) || !node.importClause?.namedBindings || !ts.isNamedImports(node.importClause.namedBindings)) return node;
  const bindings = node.importClause.namedBindings;
  const elements = bindings.elements.filter((element) => element.name.text !== "pinFilterSchema");
  // Rebuild both imports so original multiline/trailing-comma metadata cannot
  // create a printer-only difference after removing one named specifier.
  const named = ts.factory.createNamedImports(elements.map((element) => ts.factory.createImportSpecifier(element.isTypeOnly, element.propertyName && ts.factory.createIdentifier(element.propertyName.text), ts.factory.createIdentifier(element.name.text))));
  const clause = ts.factory.createImportClause(node.importClause.isTypeOnly, node.importClause.name, named);
  return ts.factory.createImportDeclaration(node.modifiers, clause, ts.factory.createStringLiteral(node.moduleSpecifier.text), node.attributes);
};
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });
const print = (nodes, source) => nodes.map((node) => printer.printNode(ts.EmitHint.Unspecified, normalizeImport(node), source));
assert.equal(retained.length, 178, "Reassess the declared component audit if its scope changes");
const beforePrinted = print(retained, before);
const afterPrinted = print([...after.statements], after);
assert.equal(beforePrinted.length, afterPrinted.length, "Retained statement counts must match");
assert.equal(beforePrinted.findIndex((statement, index) => statement !== afterPrinted[index]), -1, "Retained API statements must match after import normalization");

const canonical = ["package.json", "bun.lock", "apps/api/package.json", "apps/web/package.json", "packages/shared/package.json"];
assert.equal(git("diff", "--name-only", base, candidate, "--", ...canonical), "", "Canonical dependency inputs must remain unchanged");
const lockBytes = Buffer.byteLength(git("show", `${base}:package-lock.json`));
assert.equal(lockBytes, 61924);
assert.equal(git("ls-tree", "--name-only", candidate, "--", "package-lock.json"), "");
console.log(JSON.stringify({ base, candidate, privateFunctions: functions.size, retainedStatements: retained.length, unchangedCanonicalInputs: canonical.length, removedNpmLockBytes: lockBytes, passed: true, scope: "Pinned cleanup component source audit; not runtime, final integration or performance proof" }, null, 2));
