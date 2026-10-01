#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { webModelModule } from './web-model-module.mjs';
const url = text => `data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(text)).toString('base64')}`;
const source = file => readFile(new URL(`../apps/web/src/${file}.ts`, import.meta.url), 'utf8');
const { validateLocalization, validateProjectLocalization, localizeComponent, captionTokens, translationReferences, applyLocalizationCatalog } = await import(url(await source('localization')));
const { evaluateComponentBindings } = await import(await webModelModule('propertyBindings'));
const catalog = () => ({ defaultLocale: 'en', locales: ['en', 'es', 'fr'], messages: { note: { en: 'Note for {station}', es: 'Nota para {station}' }, heading: { en: 'Operations', es: 'Operaciones', fr: 'Opérations' } } });
const component = (props = {}, type = 'textInput') => ({ id: 'note', type, x: 10, y: 20, width: 220, height: 80, props: { text: 'Note for {station}', textKey: 'note', fieldKey: 'note', defaultValue: 'BATCH-014', ...props } });
const project = () => ({ id: 'locale-test', name: 'Locale test', revision: 4, parameters: { station: 'Assembly' }, localization: catalog(), screens: [{ id: 'home', name: 'Home', width: 800, height: 600, components: [component()] }], templates: [{ id: 'card', name: 'Card', width: 300, height: 150, parameters: { station: 'Assembly' }, components: [component()] }] });
let passed = 0;
function check(name, run) { run(); passed++; console.log(`PASS ${name}`); }
check('legacy absence and bounded supported language catalogs validate', () => {
  validateLocalization(undefined); validateLocalization(catalog()); validateProjectLocalization(project());
  for (const locale of ['en', 'en-US', 'es-MX', 'fr-CA', 'de', 'it', 'pt-BR', 'es-419']) validateLocalization({ defaultLocale: locale, locales: [locale], messages: {} });
});
check('malformed shapes, undeclared default and unsupported language codes reject', () => {
  for (const invalid of [null, [], {}, { ...catalog(), extra: true }, { ...catalog(), locales: [] }, { ...catalog(), locales: ['en', 'en'] }, { ...catalog(), locales: ['en\n'] }, { ...catalog(), locales: ['ar'] }, { ...catalog(), locales: ['EN'] }, { ...catalog(), defaultLocale: 'de' }, { ...catalog(), messages: [] }]) assert.throws(() => validateLocalization(invalid));
  assert.throws(() => validateLocalization({ ...catalog(), locales: ['en', 'en-US', 'es', 'es-MX', 'fr', 'fr-CA', 'de', 'it', 'pt'] }));
});
check('message values require default text, known locales, safe types and bounded strings', () => {
  for (const translations of [null, [], {}, { es: 'Nota' }, { en: '' }, { en: ' ' }, { en: null }, { en: true }, { en: 2 }, { en: 'x'.repeat(2049) }, { en: 'bad\u0000text' }, { en: 'bad\u0085text' }, { en: 'Note', de: 'Notiz' }]) assert.throws(() => validateLocalization({ ...catalog(), messages: { note: translations } }));
  for (const key of ['bad key', ' leading', 'trailing\n', '_private', 'x'.repeat(65)]) assert.throws(() => validateLocalization({ ...catalog(), messages: { [key]: { en: 'Note' } } }));
  validateLocalization({ ...catalog(), messages: { note: { en: 'Line one\nLine two\tNote' } } });
});
check('per-project message and aggregate text limits are enforced', () => {
  assert.throws(() => validateLocalization({ ...catalog(), messages: Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`key${i}`, { en: 'Caption' }])) }));
  assert.throws(() => validateLocalization({ ...catalog(), messages: Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`key${i}`, { en: 'x'.repeat(2048) }])) }));
  validateLocalization({ ...catalog(), messages: Object.fromEntries(Array.from({ length: 128 }, (_, i) => [`key${i}`, { en: 'x'.repeat(2048) }])) });
});
check('translations preserve parameter multiplicity but permit grammatical reordering', () => {
  validateLocalization({ ...catalog(), messages: { note: { en: '{station} {line} {station}', es: '{line}: {station} {station}' } } });
  for (const text of ['Station', '{other}', '{station} {station}', '{station', '{station}}']) assert.throws(() => validateLocalization({ ...catalog(), messages: { note: { en: '{station}', es: text } } }));
  assert.deepEqual(captionTokens('{z} {a} {z}'), ['a', 'z', 'z']);
});
check('localization changes only caption text and retains authored document definitions', () => {
  const control = component({ targetScreenId: 'review', options: [{ label: 'English choice', value: 'stable-value' }], parameters: { station: 'Assembly' }, script: 'result = {}' });
  const before = JSON.stringify(control), result = localizeComponent(control, catalog(), 'es');
  assert.equal(result.component.props.text, 'Nota para {station}'); assert.equal(result.locale, 'es'); assert.equal(result.warning, undefined); assert.equal(JSON.stringify(control), before);
  const expected = structuredClone(control); expected.props.text = 'Nota para {station}'; assert.deepEqual(result.component, expected);
});
check('missing requested translation uses the declared default with a visible explanation', () => {
  const result = localizeComponent(component(), catalog(), 'fr'); assert.equal(result.component.props.text, 'Note for {station}'); assert.equal(result.locale, 'en'); assert.match(result.warning, /using en/);
  const invalid = localizeComponent(component(), catalog(), 'unconfigured'); assert.equal(invalid.locale, 'en'); assert.match(invalid.warning, /requested language/);
});
check('missing or corrupt key/catalog uses authored caption and bounded diagnostic', () => {
  for (const value of [undefined, {}, { ...catalog(), messages: null }, { ...catalog(), messages: {} }, { ...catalog(), messages: { note: null } }, { ...catalog(), messages: { note: { en: 'Wrong {parameter}' } } }]) {
    const control = component(), result = localizeComponent(control, value, 'es'); assert.equal(result.component, control); assert.match(result.warning, /authored text/);
  }
});
check('text bindings retain precedence and suppress unused localization warnings', () => {
  const control = component({ bindings: { text: { expression: '"Computed caption"', references: {} } } });
  const localized = localizeComponent(control, undefined, 'es'); assert.equal(localized.component, control); assert.equal(localized.warning, undefined);
  assert.equal(evaluateComponentBindings(localized.component, { components: [control], tags: [], parameters: {}, inputs: {} }).component.props.text, 'Computed caption');
  const queryControl = component({ queryBindings: { text: { queryId: 'q', column: 'caption' } } }); assert.equal(localizeComponent(queryControl, catalog(), 'fr').warning, undefined);
});
check('password caption keys reject admission and never enter presentation translation', () => {
  const control = component({}, 'passwordInput'); assert.equal(localizeComponent(control, catalog(), 'es').component, control);
  const invalid = project(); invalid.screens[0].components[0] = control; assert.throws(() => validateProjectLocalization(invalid), /Password/);
});
check('all screen/template assignments require a real key and matching authored parameter tokens', () => {
  for (const value of ['missing', null, 1, '']) { const invalid = project(); invalid.templates[0].components[0].props.textKey = value; assert.throws(() => validateProjectLocalization(invalid)); }
  const changed = project(); changed.screens[0].components[0].props.text = 'Different {machine}'; assert.throws(() => validateProjectLocalization(changed), /parameters/);
  assert.equal(translationReferences(project(), 'note').length, 2);
});
check('catalog Apply is immutable, clones staged text and preserves all authored forms', () => {
  const original = project(), snapshot = JSON.stringify(original), translations = catalog(); translations.messages.heading.es = 'Nuevo título';
  const result = applyLocalizationCatalog(original, snapshot, translations); assert.equal(JSON.stringify(original), snapshot); assert.equal(result.screens, original.screens); assert.equal(result.templates, original.templates); assert.equal(result.revision, 4);
  translations.messages.heading.es = 'Mutated'; assert.equal(result.localization.messages.heading.es, 'Nuevo título');
  assert.throws(() => applyLocalizationCatalog({ ...original, revision: 5 }, snapshot, catalog()), /changed/);
  assert.throws(() => applyLocalizationCatalog(original, snapshot, undefined), /missing/);
});
console.log(`${passed} localization model groups passed.`);
