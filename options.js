import { compileRules, escapeRegex, matchingLines, RuleError } from './rules.js';

const filters = document.querySelector('#filters');
const urlInput = document.querySelector('#test-url');
const saveButton = document.querySelector('#save');
const saveStatus = document.querySelector('#save-status');
const testStatus = document.querySelector('#test-status');
let savedRules = '';
let edited = false;

function show(element, message, error = false) {
  element.textContent = message;
  element.classList.toggle('error', error);
}

function draftRules() {
  return Array.from(filters.querySelectorAll('input'), input => input.value).join('\n');
}

function clearTest() {
  for (const row of filters.querySelectorAll('.matching-filter')) row.classList.remove('matching-filter');
  show(testStatus, '');
}

function markEdited() {
  edited = true;
  show(saveStatus, draftRules() === savedRules ? 'Draft matches saved filters.' : 'Unsaved draft.');
  clearTest();
}

function numberFilters() {
  for (const [index, row] of Array.from(filters.children).entries()) {
    const input = row.querySelector('input');
    const label = row.querySelector('label');
    input.id = `filter-${index + 1}`;
    label.htmlFor = input.id;
    label.textContent = `Filter ${index + 1}`;
    row.querySelector('.escape-filter').setAttribute('aria-label', `Add escape characters to filter ${index + 1}`);
    row.querySelector('.remove-filter').setAttribute('aria-label', `Remove filter ${index + 1}`);
  }
}

function addFilter(value = '') {
  const row = document.createElement('div');
  row.className = 'filter-row';
  const label = document.createElement('label');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'filter-input';
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.setAttribute('aria-describedby', 'rules-help');
  input.value = value;
  const escape = document.createElement('button');
  escape.type = 'button';
  escape.className = 'escape-filter';
  escape.textContent = 'Add escape characters';
  escape.addEventListener('click', () => {
    input.value = escapeRegex(input.value);
    markEdited();
  });
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove-filter';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => {
    const next = row.nextElementSibling || row.previousElementSibling;
    row.remove();
    if (!filters.children.length) addFilter();
    numberFilters();
    (next || filters.firstElementChild).querySelector('input').focus();
    markEdited();
  });
  row.append(label, input, escape, remove);
  filters.append(row);
  numberFilters();
  return input;
}

function renderFilters(source) {
  filters.replaceChildren();
  for (const value of source.split(/\r?\n/)) addFilter(value);
}

function showRuleError(element, error) {
  const message = error instanceof RuleError
    ? `Filter ${error.line} failed during ${error.operation}.`
    : 'Could not evaluate filters.';
  show(element, message, true);
}

filters.addEventListener('input', markEdited);
urlInput.addEventListener('input', clearTest);
document.querySelector('#add-filter').addEventListener('click', () => {
  addFilter().focus();
  markEdited();
});

async function load() {
  try {
    const { settings } = await chrome.storage.local.get('settings');
    if (settings !== undefined && (settings?.version !== 1 || typeof settings.revision !== 'string' || typeof settings.rules !== 'string')) {
      throw new Error('Invalid settings record');
    }
    savedRules = settings?.rules || '';
    if (!edited) renderFilters(savedRules);
    show(saveStatus, edited && draftRules() !== savedRules ? 'Unsaved draft.' : 'Saved filters loaded.');
  } catch {
    show(saveStatus, 'Could not load saved filters. Your draft is unchanged.', true);
  }
}

document.querySelector('#settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  const draft = draftRules();
  try {
    compileRules(draft);
  } catch (error) {
    showRuleError(saveStatus, error);
    return;
  }
  saveButton.disabled = true;
  try {
    const revision = crypto.randomUUID();
    await chrome.storage.local.set({ settings: { version: 1, revision, rules: draft } });
    savedRules = draft;
    show(saveStatus, draftRules() === draft ? 'Filters saved.' : 'Filters saved. The editor has a newer unsaved draft.');
  } catch {
    show(saveStatus, 'Could not save filters. Your draft and previously saved filters are unchanged.', true);
  } finally {
    saveButton.disabled = false;
  }
});

document.querySelector('#test').addEventListener('click', () => {
  clearTest();
  try {
    const lines = matchingLines(compileRules(draftRules()), urlInput.value);
    for (const line of lines) filters.children[line - 1].classList.add('matching-filter');
    show(testStatus, lines.length ? `Matching filters: ${lines.join(', ')}.` : 'No matching filters.');
  } catch (error) {
    showRuleError(testStatus, error);
  }
});

renderFilters('');
void load();
