import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
let checks = 0;
const check = (name, run) => { run(); checks++; console.log(`PASS ${name}`); };
const parse = name => ts.createSourceFile(`${name}.tsx`, fs.readFileSync(new URL(`src/${name}.tsx`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const findJsx = (ast, name) => { const result = []; function visit(node) { if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(ast) === name) result.push(node); ts.forEachChild(node, visit); } visit(ast); return result; };
const attribute = (node, name) => node.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.text === name);
check('Designer, operator and popup owners wire separate automatic setters and visible diagnostics', () => {
  for (const name of ['App', 'OperatorRuntime', 'Popup']) {
    const ast = parse(name), diagnostics = findJsx(ast, 'ComponentEventDiagnostics'); assert.equal(diagnostics.length, 1);
    assert.equal(attribute(diagnostics[0], 'state').initializer.expression.getText(ast), 'applicationState');
    assert.equal(Boolean(attribute(diagnostics[0], 'errorsOnly')), name === 'Popup');
    const views = findJsx(ast, name === 'App' ? 'Canvas' : 'ProjectComponentView'); assert.equal(views.length, 1);
    assert.equal(attribute(views[0], 'onInputChange').initializer.expression.getText(ast), name === 'App' ? 'previewForm.assign' : 'form.assign');
    assert.equal(attribute(views[0], 'onAutomaticInputChange').initializer.expression.getText(ast), name === 'App' ? 'previewForm.assignAutomatic' : 'form.assignAutomatic');
    if (name === 'App') {
      assert.equal(attribute(findJsx(ast, 'ProjectComponentView')[0], 'onAutomaticInputChange').initializer.expression.getText(ast), 'onAutomaticInputChange');
      assert.match(diagnostics[0].parent.getText(ast), /^preview &&/);
    }
  }
});
console.log(`${checks}/${checks} component-events authoring checks passed.`);
